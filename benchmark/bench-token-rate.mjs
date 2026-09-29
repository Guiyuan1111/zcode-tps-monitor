#!/usr/bin/env node
// 基准 1:token-rate 查询层(进程内,不含 Node 启动开销)。
// 对比 benchmark/baseline-v0.9.0(优化前)与 plugins/...(优化后)的:
//   queryTurn(sid)            收尾自测走的核心路径(Stop/CLI --turn)
//   queryTurn(sid,{current})  带 --current 守卫(读状态文件)
//   queryTurn(null)           自动会话解析(状态文件路径)
//   query(sid)                历史查询(CLI 默认)
//   query(null)               自动会话 + 历史
// 红线校验:两版本所有返回值与格式化输出必须深度相等,否则本基准直接失败。
// 结果行:##RESULT## {json}
//
//   node benchmark/bench-token-rate.mjs [small|medium|large]   BENCH_ITERS=200

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

process.removeAllListeners("warning");
process.on("warning", () => {});

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const size = process.argv[2] || "medium";
const ITERS = Number(process.env.BENCH_ITERS || 200);
const TEMP = path.join(ROOT, "benchmark", "TEMP");
const dbFile = path.join(TEMP, `fixture-${size}.sqlite`);
const stateFile = path.join(TEMP, "state.json");
if (!fs.existsSync(dbFile)) {
  console.error("夹具不存在,先运行: node benchmark/fixture-gen.mjs");
  process.exit(1);
}

// 模块在加载时读取环境,必须在 import 前设置
process.env.ZCODE_USAGE_DB = dbFile;
process.env.TPS_MONITOR_STATE_FILE = stateFile;
process.env.ZCODE_SESSION_ID = "";
process.env.TOKEN_RATE_WINDOW = "5";
process.env.TOKEN_RATE_HIST = "60";
process.env.TOKEN_RATE_MIN_MS = "200";
process.env.TOKEN_RATE_MAX_MS = "3600000";

const baseline = await import(url.pathToFileURL(path.join(ROOT, "benchmark", "baseline-v0.9.0", "scripts", "token-rate.mjs")).href);
const current = await import(url.pathToFileURL(path.join(ROOT, "plugins", "zcode-tps-monitor", "scripts", "token-rate.mjs")).href + "?cur");

// --- 兼容性红线:行为必须逐字节等价(夹具固定 → 输出确定) ---
assert.deepEqual(current.queryTurn("sess_cur"), baseline.queryTurn("sess_cur"), "queryTurn(sid) 输出不一致");
assert.deepEqual(current.queryTurn("sess_cur", { current: true }), baseline.queryTurn("sess_cur", { current: true }), "queryTurn(current) 输出不一致");
assert.deepEqual(current.queryTurn(null), baseline.queryTurn(null), "queryTurn(auto) 输出不一致");
assert.deepEqual(current.query("sess_cur"), baseline.query("sess_cur"), "query(sid) 输出不一致");
assert.deepEqual(current.query(null), baseline.query(null), "query(auto) 输出不一致");
assert.equal(current.formatTurnLine(current.queryTurn("sess_cur")), baseline.formatTurnLine(baseline.queryTurn("sess_cur")), "formatTurnLine 输出不一致");
assert.equal(current.formatLine(current.query("sess_cur")), baseline.formatLine(baseline.query("sess_cur")), "formatLine 输出不一致");
assert.equal(current.fmtCompact(73818000), baseline.fmtCompact(73818000));
assert.equal(current.fmtNum(128643), baseline.fmtNum(128643));

// --- 计时:预热后整批计时,重复 3 轮取最小值(剔除 GC/JIT 抖动),ms/op ---
function timeIt(fn, iters) {
  const warm = Math.min(25, iters);
  for (let i = 0; i < warm; i++) fn();
  let best = Infinity;
  for (let rep = 0; rep < 3; rep++) {
    const t = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) fn();
    best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6 / iters);
  }
  return best;
}

const CASES = {
  "queryTurn(sid)": (m) => m.queryTurn("sess_cur"),
  "queryTurn(sid,current)": (m) => m.queryTurn("sess_cur", { current: true }),
  "queryTurn(auto)": (m) => m.queryTurn(null),
  "query(sid)": (m) => m.query("sess_cur"),
  "query(auto)": (m) => m.query(null),
};

const result = { bench: "token-rate", size, iters: ITERS, dbBytes: fs.statSync(dbFile).size, baseline: {}, current: {}, speedup: {} };
for (const [name, call] of Object.entries(CASES)) {
  // 正反双序各测一轮再取各自最小,消除"先后执行"的模块/JIT 顺序偏置
  const b1 = timeIt(() => call(baseline), ITERS);
  const c1 = timeIt(() => call(current), ITERS);
  const c2 = timeIt(() => call(current), ITERS);
  const b2 = timeIt(() => call(baseline), ITERS);
  const b = Math.min(b1, b2), c = Math.min(c1, c2);
  result.baseline[name] = +b.toFixed(4);
  result.current[name] = +c.toFixed(4);
  result.speedup[name] = +(b / c).toFixed(2);
}
result.rows = fs.statSync(dbFile).size; // 字节数,行数见 fixture-gen 输出
console.log(`[token-rate/${size}] ` + Object.entries(result.speedup).map(([k, v]) => `${k}×${v}`).join("  "));
console.log("##RESULT## " + JSON.stringify(result));
