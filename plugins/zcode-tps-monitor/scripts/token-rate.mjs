#!/usr/bin/env node
// Token 输出速率:从 ZCode 自身的 usage 数据库(model_usage 表)计算真实的模型生成速率。
// 用法:
//   node token-rate.mjs            最近一次请求 + 会话统计(人类可读)
//   node token-rate.mjs --turn     最新一问(本次提问触发的轮次)即时速率
//   node token-rate.mjs --turn --current
//                                  同上,但本问尚无入库数据时输出为空(--current 守卫,
//                                  绝不把上一轮数据当作本问返回)
//   node token-rate.mjs -c         = --turn --current 组合短旗标(每轮注入命令用)
//   node token-rate.mjs --json     JSON 输出
//   ZCODE_SESSION_ID=xxx node ...  只统计指定会话(ZSID 为等价短别名)
//   ZCODE_USAGE_DB=/path/db.sqlite 指定数据库路径(默认按用户主目录解析)
//   TPS_MONITOR_STATE_FILE=/path   指定钩子状态文件(默认 ~/.zcode/tps-monitor.last-session.json)
// 只读打开 WAL 数据库,不影响运行中的客户端。

// 抑制 node:sqlite 的 ExperimentalWarning 噪音:必须在动态 import 之前接管 warning 通道
// (静态 import 的内置模块在模块体执行前就已求值,届时再监听就晚了)。
process.removeAllListeners("warning");
process.on("warning", () => {});

const { DatabaseSync } = await import("node:sqlite");
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 跨平台默认路径(macOS/Linux: ~/.zcode/...;Windows: %USERPROFILE%\.zcode\...),可用 ZCODE_USAGE_DB 覆盖
const DB_PATH =
  process.env.ZCODE_USAGE_DB ||
  path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
const N = Number(process.env.TOKEN_RATE_WINDOW) || 5;           // 统计窗口(均/峰)
const HIST = Number(process.env.TOKEN_RATE_HIST) || 60;         // 曲线历史点数
const MIN_GEN_MS = Number(process.env.TOKEN_RATE_MIN_MS) || 200;      // 有效样本:最短生成耗时
const MAX_GEN_MS = Number(process.env.TOKEN_RATE_MAX_MS) || 3_600_000; // 有效样本:最长生成耗时(1h)

// 钩子状态文件:记录"用户最后所处的会话"与最近提问时刻(--current 守卫依赖 ts)
const STATE_FILE =
  process.env.TPS_MONITOR_STATE_FILE ||
  path.join(os.homedir(), ".zcode", "tps-monitor.last-session.json");
const STATE_TTL_MS = 7 * 24 * 3600 * 1000; // 过旧的状态文件视为失效(与大屏跟随逻辑一致)

function readState() {
  try {
    const st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!st || !Number.isFinite(st.ts) || Date.now() - st.ts > STATE_TTL_MS) return null;
    return st;
  } catch {
    return null;
  }
}

function openDb() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  // 连接级读取调优(全部不写库文件,基准内有哈希不变断言佐证):
  //   mmap_size  内存映射读大库,免逐页系统调用拷贝(收益最大)
  //   temp_store 排序中间结果驻留内存(查询计划里的 TEMP B-tree 不落盘)
  //   cache_size 页缓存加大到 16MB,同进程多条查询复用已解析页
  // 任何 PRAGMA 在特定环境不可用时仅退回默认行为,结果不受影响
  try {
    db.exec("PRAGMA mmap_size=134217728; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-16384;");
  } catch {}
  return db;
}

// 未显式指定会话时的解析顺序:状态文件里"用户最后所处的会话"(切会话即跟随)→
// 全局最近一次完成请求所属的会话
function fallbackSessionId(db) {
  const st = readState();
  if (st && st.sessionId) return st.sessionId;
  // MAX() 裸列惯用法:SQLite 保证仅用单个 min/max 聚合时,裸列取自聚合命中行,
  // 免去 ORDER BY 的临时 B-tree 排序;空集时返回一行 null,与 LIMIT 1 未命中同义
  const row = db
    .prepare("SELECT session_id, MAX(completed_at) FROM model_usage WHERE status = 'completed'")
    .get();
  return row && row.session_id != null ? row.session_id : null;
}

function resolveSession(db, sessionId) {
  const sid = sessionId || fallbackSessionId(db);
  return { sid, scoped: sessionId ? "explicit" : "auto" };
}

// 主对话优先的过滤范围:先按 main_turn 取窗口,一条都没有时回退为全部请求。
// (等价于旧版"先做 LIMIT 1 存在性探测、再查询",但常规路径少一次全表扫描:
// main_turn 窗口为空 ⟺ 范围内没有任何 main_turn 行,判定条件不变)
const SCOPE_COLS =
  "SELECT model_id, output_tokens, reasoning_tokens, input_tokens, cache_read_input_tokens," +
  " first_token_at, completed_at, time_to_first_token_ms, status" +
  " FROM model_usage WHERE status = 'completed'";
const MAIN_AND = " AND query_source = 'main_turn'";

// 返回窗口行与 scopeSql(供 SUM 复用);main 标记当前 scope 是否只含主对话
function scopeRows(db, sid, limit) {
  const sidAnd = sid ? " AND session_id = ?" : "";
  const args = sid ? [sid] : [];
  const mainSql = SCOPE_COLS + MAIN_AND + sidAnd;
  const rows = db.prepare(mainSql + " ORDER BY completed_at DESC LIMIT ?").all(...args, limit);
  if (rows.length) return { rows, scopeSql: mainSql, args, main: true };
  const allSql = SCOPE_COLS + sidAnd;
  return { rows: db.prepare(allSql + " ORDER BY completed_at DESC LIMIT ?").all(...args, limit), scopeSql: allSql, args, main: false };
}

function toItem(r) {
  const tok = r.output_tokens ?? 0;
  const reasoning = r.reasoning_tokens ?? 0;
  // 部分行(如非流式/中断请求)缺 first_token_at,须判无效
  const hasTime = Number.isFinite(r.first_token_at) && Number.isFinite(r.completed_at) && r.completed_at > r.first_token_at;
  const genMs = hasTime ? r.completed_at - r.first_token_at : null; // 纯生成耗时(不含首 token 等待)
  // 速率分子含思考 token:思考内容同样是流式输出,ZCode 未单独记录时该列为 0,行为不变
  const rateTokens = tok + reasoning;
  const valid = genMs != null && genMs >= MIN_GEN_MS && genMs < MAX_GEN_MS && rateTokens > 0;
  return {
    model: r.model_id,
    outputTokens: tok,
    reasoningTokens: reasoning,
    inputTokens: r.input_tokens ?? 0,
    cacheRead: r.cache_read_input_tokens ?? 0,
    ttftMs: Number.isFinite(r.time_to_first_token_ms) ? r.time_to_first_token_ms : null,
    genMs,
    tokPerSec: valid ? Math.round((rateTokens / genMs) * 10000) / 10 : null,
    completedAt: r.completed_at,
  };
}

// 会话累计用独立 SUM(不受展示窗口限制);速率均值/峰值由调用方按窗口传入
function sessionAggregate(db, scopeSql, args, rated) {
  if (!rated.length) return null;
  const sumRow = db
    .prepare(
      "SELECT COUNT(*) n, SUM(output_tokens) o, SUM(reasoning_tokens) r," +
      " SUM(input_tokens) i, SUM(cache_read_input_tokens) c FROM (" + scopeSql + ")"
    )
    .get(...args);
  let max = -Infinity, min = Infinity, sum = 0;
  for (const i of rated) {
    if (i.tokPerSec > max) max = i.tokPerSec;
    if (i.tokPerSec < min) min = i.tokPerSec;
    sum += i.tokPerSec;
  }
  return {
    samples: rated.length,
    requests: sumRow.n ?? 0,
    avg: Math.round((sum / rated.length) * 10) / 10,
    max,
    min,
    totalOutput: sumRow.o ?? 0,
    totalReasoning: sumRow.r ?? 0,
    totalInput: sumRow.i ?? 0,
    totalCacheRead: sumRow.c ?? 0,
  };
}

function query(sessionId) {
  const db = openDb();
  try {
    const { sid, scoped } = resolveSession(db, sessionId);
    // 窗口瘦身:history/统计实际只消费前 min(N, HIST) 条(与旧版取 HIST 条再
    // slice(0,N) 的结果集逐条一致),按需拉取即可,免去多余行的物化
    const { rows, scopeSql, args } = scopeRows(db, sid, Math.min(N, HIST));
    const items = rows.map(toItem);
    const rated = items.filter((i) => i.tokPerSec != null);
    // 展示用 latest 优先取最近一条"有效"记录,避免在途/缺字段行顶掉头条
    const latest = rated[0] ?? items[0] ?? null;
    const session = sessionAggregate(db, scopeSql, args, rated);
    return { sessionId: sid, scoped, latest, session, history: items.slice().reverse() };
  } finally {
    db.close();
  }
}

// 本轮 = 会话里最新的 turn_id(一次用户消息触发的全部请求共享同一个 turn_id,
// 含"模型→工具→模型"的每一段)。回复收尾时(模型运行 --turn --current)本轮已完成
// 的各段均已实时入库,因此能给出真正的"本问即时速率";而 prompt-submit 时刻本问
// 尚未发生,只能看到上一轮。
function latestTurnId(db, sid) {
  try {
    // 同 fallbackSessionId:MAX() 裸列免排序,语义 = 按 completed_at 降序取第一条的 turn_id
    const row = db
      .prepare("SELECT turn_id, MAX(completed_at) FROM model_usage WHERE session_id = ? AND turn_id IS NOT NULL")
      .get(sid);
    return row && row.turn_id != null ? row.turn_id : null;
  } catch {
    return null; // 旧版客户端的库没有 turn_id 列
  }
}

// 最近一次用户提问的时间戳(prompt-submit 钩子写入);--current 守卫用:
// 最新 turn 的所有行都早于它,说明本问尚未产生任何模型请求(纯问答轮),不得当作"本问"统计。
function lastPromptTs() {
  const st = readState();
  return st && Number.isFinite(st.ts) ? st.ts : null;
}

function queryTurn(sessionId, opts = {}) {
  const db = openDb();
  try {
    const sid = sessionId || fallbackSessionId(db);
    if (!sid) return { sessionId: null, turnId: null, turn: null, session: null };
    const turnId = latestTurnId(db, sid);
    // scope 由"不带 turn 过滤"的窗口一次判定(乐观 main_turn,空则回退)。
    // turn 行改走 (session_id, turn_id) 索引直达:真实 usage 库建有
    // model_usage_session_turn_idx,查询计划从"低选择性的 query_source 索引扫描 +
    // 临时 B-tree 排序"变为索引定位;status/query_source 的 scope 过滤移到 JS 完成,
    // 行集与 SQL 过滤严格等价(无索引的库自动退化为全表扫描,结果不变)
    const scope = scopeRows(db, sid, N);
    let turnRows = null;
    if (turnId) {
      try {
        turnRows = db
          .prepare(
            "SELECT model_id, output_tokens, reasoning_tokens, input_tokens, cache_read_input_tokens," +
              " first_token_at, completed_at, time_to_first_token_ms, status, query_source" +
              " FROM model_usage WHERE session_id = ? AND turn_id = ? ORDER BY completed_at ASC"
          )
          .all(sid, turnId)
          .filter((r) => r.status === "completed" && (!scope.main || r.query_source === "main_turn"));
      } catch {
        turnRows = null; // 旧版客户端的库没有 turn_id 列
      }
    }
    const session = sessionAggregate(db, scope.scopeSql, scope.args, scope.rows.map(toItem).filter((i) => i.tokPerSec != null));
    if (!turnId) return { sessionId: sid, turnId: null, turn: null, session };
    if (!turnRows || !turnRows.length) return { sessionId: sid, turnId, turn: null, session };
    // --current 守卫:最新 turn 的行全部早于本次提问时刻 → 本问还没有任何模型请求
    // (典型场景:纯问答轮在回答结束前),绝不把上一轮数据冒充"本问"返回。
    if (opts.current) {
      const ts = lastPromptTs();
      let lastAt = -Infinity;
      for (const r of turnRows) if ((r.completed_at ?? 0) > lastAt) lastAt = r.completed_at ?? 0;
      if (ts && lastAt < ts) {
        return { sessionId: sid, turnId, turn: null, noCurrentTurnData: true, session };
      }
    }
    const items = turnRows.map(toItem);
    const rated = items.filter((i) => i.tokPerSec != null);
    let totalTok = 0, genMs = 0, totalOut = 0, totalRea = 0, peak = null;
    for (const i of rated) {
      totalTok += i.outputTokens + i.reasoningTokens;
      genMs += i.genMs;
      if (i.tokPerSec != null && (peak === null || i.tokPerSec > peak)) peak = i.tokPerSec;
    }
    for (const i of items) {
      totalOut += i.outputTokens;
      totalRea += i.reasoningTokens;
    }
    const turn = {
      requests: items.length,
      rated: rated.length,
      ttftMs: items[0].ttftMs, // 本轮第一段的首字延迟
      firstAt: items[0].completedAt,
      lastAt: items[items.length - 1].completedAt,
      genMs,
      totalOutput: totalOut,
      totalReasoning: totalRea,
      // 本轮即时速率:总产出 / 总纯生成时长(按段加权,排除段间工具等待),单段时即该段速率
      tokPerSec: genMs >= MIN_GEN_MS && totalTok > 0 ? Math.round((totalTok / genMs) * 10000) / 10 : null,
      peak,
    };
    return { sessionId: sid, turnId, turn, session };
  } finally {
    db.close();
  }
}

// 紧凑单位(注入行等需一眼扫读处):千以下原始、千~万一位小数 k、万~百万取整 k、百万以上一位小数 M
function fmtCompact(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 10_000) return Math.round(n / 1000) + "k";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

// 千分位精确数字(每轮输出与 CLI 明细):2,762。
// 缓存格式化器实例:toLocaleString 每次调用都要新建 Intl 对象,进程内重复
// 格式化(库调用方/批处理)时开销可观;输出与 toLocaleString("en-US") 逐字节一致
let _numFmt = null;
function fmtNum(n) {
  return (_numFmt ??= new Intl.NumberFormat("en-US")).format(n);
}

// 时:分:秒(与 new Date(x).toLocaleTimeString("zh-CN",{hour12:false}) 逐字节一致)
let _timeFmt = null;
function fmtTime(ms) {
  return (_timeFmt ??= new Intl.DateTimeFormat("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })).format(new Date(ms));
}

function formatLine(r) {
  const l = r.latest;
  if (!l) return "暂无已完成的模型请求";
  const t = fmtTime(l.completedAt);
  const parts = [
    // 采样发生在发送消息的瞬间,头条描述的是上一条已完成回复
    `⚡ ${l.tokPerSec ?? "-"} tok/s(上轮)`,
    `首字 ${l.ttftMs != null ? (l.ttftMs / 1000).toFixed(1) : "-"}s`,
    `输出 ${fmtNum(l.outputTokens)}${l.reasoningTokens ? `(+${fmtNum(l.reasoningTokens)} 思考)` : ""} tok / 生成 ${l.genMs != null ? (l.genMs / 1000).toFixed(1) : "-"}s`,
  ];
  if (r.session) {
    parts.push(`近${r.session.samples}次均 ${r.session.avg} / 峰 ${r.session.max}`);
    parts.push(`累计 ${fmtCompact(r.session.totalOutput + r.session.totalReasoning)} tok`);
  }
  parts.push(`⏱ ${t}`);
  return parts.join(" · ");
}

// 本问统计行(回复收尾自测、Stop 钩子、监控大屏共用)
function formatTurnLine(r) {
  const t = r.turn;
  if (!t) return "暂无本轮请求记录";
  const time = fmtTime(t.lastAt);
  const parts = [
    // 采样发生在回复刚结束的瞬间,头条即本轮即时速率
    `⚡ ${t.tokPerSec ?? "-"} tok/s(本轮)`,
    `首字 ${t.ttftMs != null ? (t.ttftMs / 1000).toFixed(1) : "-"}s`,
    `输出 ${fmtNum(t.totalOutput)}${t.totalReasoning ? `(+${fmtNum(t.totalReasoning)} 思考)` : ""} tok / 生成 ${t.genMs > 0 ? (t.genMs / 1000).toFixed(1) : "-"}s`,
  ];
  if (t.requests > 1) parts.push(`${t.requests} 段 / 峰 ${t.peak ?? "-"}`);
  if (r.session) parts.push(`累计 ${fmtCompact(r.session.totalOutput + r.session.totalReasoning)} tok`);
  parts.push(`⏱ ${time}`);
  return parts.join(" · ");
}

// --- CLI ---
// 守卫:仅当本文件作为入口执行时才走命令行(被 import 时不执行)。按 argv[1] 基名
// 白名单判定,与路径风格/大小写无关;短路径副本(hooks/lib.mjs)以 tr.mjs 命名,
// 两个入口名都在白名单内——改名必须与 lib.mjs 同步,否则副本运行静默无输出。
const CLI_ENTRY_NAMES = new Set(["token-rate.mjs", "tr.mjs"]);
if (CLI_ENTRY_NAMES.has(process.argv[1] ? path.basename(process.argv[1]) : "")) {
  const json = process.argv.includes("--json");
  const quick = process.argv.includes("-c"); // -c = --turn --current 组合(注入短命令用)
  const turnOnly = process.argv.includes("--turn") || quick;
  const current = process.argv.includes("--current") || quick;
  const sid = process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || process.env.ZSID || null;
  if (turnOnly) {
    const r = queryTurn(sid, { current });
    if (json) console.log(JSON.stringify(r, null, 2));
    else if (r.turn) console.log(formatTurnLine(r));
    // --current 且本问尚无数据:不输出任何行,调用方据此不显示统计(绝不回退到上一轮)
  } else {
    const r = query(sid);
    if (json) {
      console.log(JSON.stringify(r, null, 2));
    } else {
      const s = r.session;
      console.log(formatLine(r));
      if (s) {
        // CLI 明细面向细读,全部千分位精确数字
        console.log(`会话累计:输出 ${fmtNum(s.totalOutput)}${s.totalReasoning ? `(+${fmtNum(s.totalReasoning)} 思考)` : ""} tok · 输入 ${fmtNum(s.totalInput)} tok(其中缓存读 ${fmtNum(s.totalCacheRead)}) · 请求 ${s.requests} 次`);
      }
    }
  }
}

export { query, queryTurn, formatLine, formatTurnLine, fmtCompact, fmtNum };
