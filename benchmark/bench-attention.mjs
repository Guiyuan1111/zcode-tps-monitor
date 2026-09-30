#!/usr/bin/env node
// 基准 7:AI 注意力/上下文占用 —— 量化插件注入给模型的全部文本面。
// 面与口径:
//   perTurn   UserPromptSubmit 每轮注入的 additionalContext(每轮重复,占比最大)
//   session   SessionStart 会话提示(每会话一次)
//   tools     MCP tools/list 的 tools 定义(进系统提示,每会话一次)
//   skill     SKILL.md frontmatter description(进系统提示,每会话一次)
//   commands  斜杠命令文件全文(tps/tps-doctor;用户调用时展开,按需面,不计入百轮外推)
//   skillBody SKILL.md 正文(技能触发时加载,按需面,不计入百轮外推)
// token 为零依赖估算:CJK 字符 1/字 + 其余字符 /3.5(路径/标点密集,偏保守),
// 同时报原始字符数;估算只用于横向对比(同口径),不代表任何分词器精确值。
// 红线校验(两变体都必须通过,否则基准失败):
//   - 两个钩子输出严格 JSON 且可解析
//   - prompt-submit 注入必须包含:本问统计脚本命令(基线长旗标 --turn --current /
//     0.9.8 起组合短旗标 -c)、Markdown 引用块标记、以及"无输出/未调用工具不显示"守卫语义
//   - MCP 必须列出 tps_snapshot/tps_watch 两个工具且带 inputSchema
//   - SKILL description 非空且含触发关键词(tok/s 与 TPS)
// 结果行:##RESULT## {json}
//
//   node benchmark/bench-attention.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const TEMP = path.join(ROOT, "benchmark", "TEMP");
fs.mkdirSync(TEMP, { recursive: true });

const VARIANTS = {
  baseline: path.join(ROOT, "benchmark", "baseline-v0.9.7"),
  current: path.join(ROOT, "plugins", "zcode-tps-monitor"),
};

// --- 钩子进程沙箱:HOME/USERPROFILE 指向 TEMP 下的隔离目录,钩子的一切文件写入
//     (状态文件、可能的快捷副本)都不触碰真实用户目录 ---
function runHook(variantDir, hookFile) {
  const home = path.join(TEMP, "attn-home");
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  const r = spawnSync(process.execPath, [path.join(variantDir, "hooks", hookFile)], {
    encoding: "utf8",
    env: {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
      ZCODE_SESSION_ID: "sess_bench_attn",
      TPS_MONITOR_STATE_FILE: path.join(home, "state.json"),
    },
  });
  assert.equal(r.status, 0, `${hookFile} 退出码 ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout); // 非严格 JSON 直接抛错 = 红线失败
}

function promptSubmitText(variantDir) {
  const j = runHook(variantDir, "prompt-submit.mjs");
  const ctx = j.hookSpecificOutput?.additionalContext ?? "";
  // 语义守卫:命令、引用块、空输出守卫三要素缺一不可
  // 命令形态两代并存:v0.9.7 基线为长旗标,0.9.8 起为 -c 组合短旗标(语义同 --turn --current)
  assert.match(ctx, /node ~\/\.zcode\/(token-rate\.mjs --turn --current|tr\.mjs -c)/, "注入缺少本问统计命令");
  assert.match(ctx, />/, "注入缺少 Markdown 引用块标记");
  assert.match(ctx, /(不显示|不要显示)/, "注入缺少空输出守卫");
  assert.match(ctx, /(没有调用过|未调用过|为此(额外)?调用)/, "注入缺少未调用工具守卫");
  return ctx;
}

function sessionStartText(variantDir) {
  const j = runHook(variantDir, "session-start.mjs");
  const ctx = j.hookSpecificOutput?.additionalContext ?? "";
  assert.ok(ctx.includes("zcode-tps-monitor"), "会话提示缺少插件标识");
  return ctx;
}

// MCP tools/list(进程内同步取整段 stdout,再抽 id:1 的应答体)
function toolsListBytes(variantDir) {
  const frame = (obj) => {
    const body = JSON.stringify(obj);
    return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
  };
  const r = spawnSync(process.execPath, [path.join(variantDir, "mcp", "tps-server.mjs")], {
    encoding: "utf8",
    input:
      frame({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bench", version: "0" } } }) +
      frame({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    timeout: 20_000,
  });
  assert.equal(r.status, 0, `tps-server 退出码 ${r.status}: ${r.stderr}`);
  const m = /(\{"jsonrpc":"2\.0","id":1[^]*?\})(?=Content-Length:|$)/.exec(r.stdout);
  assert.ok(m, "未找到 tools/list 应答");
  const body = JSON.parse(m[1]);
  const tools = body.result.tools;
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["tps_snapshot", "tps_watch"], "工具清单不完整");
  for (const t of tools) assert.ok(t.inputSchema, `${t.name} 缺 inputSchema`);
  return JSON.stringify(body.result);
}

function skillDescription(variantDir) {
  const md = fs.readFileSync(path.join(variantDir, "skills", "zcode-tps-monitor", "SKILL.md"), "utf8");
  const m = /^description:\s*(.+)$/m.exec(md);
  assert.ok(m, "SKILL.md 缺 description");
  const desc = m[1];
  assert.match(desc, /tok\/s/i, "SKILL 描述缺触发关键词 tok/s");
  assert.match(desc, /TPS/, "SKILL 描述缺触发关键词 TPS");
  return desc;
}

// 按需面:斜杠命令文件全文(用户调用时展开进上下文)
function commandFilesText(variantDir) {
  const tps = fs.readFileSync(path.join(variantDir, "commands", "tps.md"), "utf8");
  const doctor = fs.readFileSync(path.join(variantDir, "commands", "tps-doctor.md"), "utf8");
  assert.ok(tps.includes("$ARGUMENTS") && doctor.includes("$ARGUMENTS"), "命令文件缺 $ARGUMENTS 占位");
  return tps + doctor;
}

// 按需面:SKILL.md 正文(技能触发时加载;frontmatter 之后的部分)
function skillBodyText(variantDir) {
  const md = fs.readFileSync(path.join(variantDir, "skills", "zcode-tps-monitor", "SKILL.md"), "utf8");
  const m = /^---\r?\n[^]*?\r?\n---\r?\n/.exec(md);
  assert.ok(m, "SKILL.md 缺 frontmatter");
  const body = md.slice(m[0].length);
  assert.match(body, /【本轮统计】/, "SKILL 正文缺【本轮统计】标签引用(0.9.7 对齐纪律)");
  return body;
}

// --- 零依赖 token 估算:CJK 1/字,其余 /3.5(保守,路径密集场景) ---
function estTokens(text) {
  let cjk = 0, other = 0;
  for (const ch of text) {
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) cjk++;
    else other++;
  }
  return +(cjk + other / 3.5).toFixed(1);
}

const SURFACES = {
  perTurn: (d) => promptSubmitText(d),
  session: (d) => sessionStartText(d),
  tools: (d) => toolsListBytes(d),
  skill: (d) => skillDescription(d),
  commands: (d) => commandFilesText(d),
  skillBody: (d) => skillBodyText(d),
};

const result = { bench: "attention", baseline: {}, current: {}, ratio: {} };
for (const [name, collect] of Object.entries(SURFACES)) {
  const b = collect(VARIANTS.baseline);
  const c = collect(VARIANTS.current);
  result.baseline[name] = { chars: b.length, estTokens: estTokens(b) };
  result.current[name] = { chars: c.length, estTokens: estTokens(c) };
  result.ratio[name] = +(result.baseline[name].estTokens / result.current[name].estTokens).toFixed(2);
}
// 100 轮累计(常驻面:每轮注入 ×100 + 三个一次性面;按需面 commands/skillBody
// 只在用户调用命令/触发技能时展开,不随轮数增长,不参与外推)
result.hundredTurns = {
  baseline: +(result.baseline.perTurn.estTokens * 100 + result.baseline.session.estTokens + result.baseline.tools.estTokens + result.baseline.skill.estTokens).toFixed(0),
  current: +(result.current.perTurn.estTokens * 100 + result.current.session.estTokens + result.current.tools.estTokens + result.current.skill.estTokens).toFixed(0),
};
result.hundredTurns.ratio = +(result.hundredTurns.baseline / result.hundredTurns.current).toFixed(2);

console.log(
  `[attention] perTurn ${result.baseline.perTurn.estTokens}→${result.current.perTurn.estTokens} tok(×${result.ratio.perTurn})` +
    `  session ×${result.ratio.session}  tools ×${result.ratio.tools}  skill ×${result.ratio.skill}` +
    `  [按需] commands ×${result.ratio.commands}  skillBody ×${result.ratio.skillBody}` +
    `  100轮累计 ${result.hundredTurns.baseline}→${result.hundredTurns.current}(×${result.hundredTurns.ratio})`
);
console.log("##RESULT## " + JSON.stringify(result));
