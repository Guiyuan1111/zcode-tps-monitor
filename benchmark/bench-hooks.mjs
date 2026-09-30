#!/usr/bin/env node
// 基准 5:钩子进程端到端(含 Node 启动)。ZCode 对 UserPromptSubmit 有超时预算,
// 钩子耗时直接吃对话交互延迟,逐次 spawn 计时(交错执行消除漂移)。
// 环境隔离:HOME/USERPROFILE/TPS_MONITOR_STATE_FILE 全部重定向到 benchmark/TEMP,
// 绝不读写真实 ~/.zcode;stop 钩子的 DB 指向夹具库。
// 红线校验:stop 逐字节一致;prompt-submit/session-start 是注意力优化面
// (注入文本自 v0.9.6 起有意精简),改为结构等价——严格 JSON、hookEventName
// 一致、注入非空;注入文本的语义守卫(命令/引用块/空输出守卫)在 bench-attention。
// 结果行:##RESULT## {json}
//
//   node benchmark/bench-hooks.mjs [small|medium|large]   BENCH_RUNS=15

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const size = process.argv[2] || "medium";
const RUNS = Number(process.env.BENCH_RUNS || 15);
const TEMP = path.join(ROOT, "benchmark", "TEMP");
const dbFile = path.join(TEMP, `fixture-${size}.sqlite`);
if (!fs.existsSync(dbFile)) {
  console.error("夹具不存在,先运行: node benchmark/fixture-gen.mjs");
  process.exit(1);
}
const benchHome = path.join(TEMP, "bench-home");
fs.mkdirSync(benchHome, { recursive: true });
const hookState = path.join(benchHome, "hook-state.json");

const V = (rel) => ({
  baseline: path.join(ROOT, "benchmark", "baseline-v0.9.0", rel),
  current: path.join(ROOT, "plugins", "zcode-tps-monitor", rel),
});

const baseEnv = {
  ...process.env,
  HOME: benchHome,
  USERPROFILE: benchHome,
  ZCODE_SESSION_ID: "sess_cur",
  TPS_MONITOR_STATE_FILE: hookState,
};

const SCENARIOS = {
  // prompt-submit / session-start 不读 stdin;stop 读 stdin JSON
  "prompt-submit": { script: V("hooks/prompt-submit.mjs"), env: baseEnv, stdin: null },
  "session-start": { script: V("hooks/session-start.mjs"), env: baseEnv, stdin: null },
  "stop": {
    script: V("hooks/stop.mjs"),
    env: { ...baseEnv, ZCODE_USAGE_DB: dbFile },
    stdin: JSON.stringify({ session_id: "sess_cur" }),
  },
};

function runOnce(script, env, stdin) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [script], { encoding: "utf8", env, input: stdin ?? undefined });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.status !== 0) throw new Error(`${script} 退出码 ${r.status}: ${r.stderr}`);
  return { ms, stdout: r.stdout };
}

const result = { bench: "hooks", size, runs: RUNS, baseline: {}, current: {}, speedup: {} };
// 钩子输出内嵌自身脚本绝对路径(指令命令行),两个变体路径天然不同:
// 比较前把各自根路径(含 JSON 转义形态 \\)规范化为 <ROOT>,剥离这一固有差异
const BASELINE_DIR = path.join(ROOT, "benchmark", "baseline-v0.9.0");
const PLUGIN_DIR = path.join(ROOT, "plugins", "zcode-tps-monitor");
const esc = (p) => JSON.stringify(p).slice(1, -1);
const normOut = (s) =>
  s.split(BASELINE_DIR).join("<ROOT>").split(esc(BASELINE_DIR)).join("<ROOT>")
   .split(PLUGIN_DIR).join("<ROOT>").split(esc(PLUGIN_DIR)).join("<ROOT>");
for (const [name, { script, env, stdin }] of Object.entries(SCENARIOS)) {
  const samples = { baseline: [], current: [] };
  const outs = {};
  for (let i = 0; i < RUNS; i++) {
    for (const v of i % 2 === 0 ? ["baseline", "current"] : ["current", "baseline"]) {
      const { ms, stdout } = runOnce(script[v], env, stdin);
      samples[v].push(ms);
      (outs[v] ??= new Set()).add(normOut(stdout));
    }
  }
  assert.equal(outs.baseline.size, 1, `${name}: 基线输出不稳定`);
  assert.equal(outs.current.size, 1, `${name}: 当前输出不稳定`);
  if (name === "stop") {
    assert.equal([...outs.baseline][0], [...outs.current][0], `${name}: 两版本输出不一致`);
  } else {
    // 注入面:文本有意精简(注意力优化),校验结构等价 + 注入非空
    const parse = (s) => JSON.parse(s).hookSpecificOutput;
    const b = parse([...outs.baseline][0]);
    const c = parse([...outs.current][0]);
    assert.equal(b.hookEventName, c.hookEventName, `${name}: hookEventName 不一致`);
    assert.ok(c.additionalContext.length > 0, `${name}: 注入不应为空`);
  }
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const b = med(samples.baseline), c = med(samples.current);
  result.baseline[name] = +b.toFixed(2);
  result.current[name] = +c.toFixed(2);
  result.speedup[name] = +(b / c).toFixed(3);
}
console.log(`[hooks/${size}] ` + Object.entries(result.speedup).map(([k, v]) => `${k}×${v}`).join("  "));
console.log("##RESULT## " + JSON.stringify(result));
