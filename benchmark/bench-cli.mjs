#!/usr/bin/env node
// 基准 2:收尾自测 CLI 端到端(含 Node 进程启动、模块加载、DB 打开、查询、输出)。
// 这是模型每轮回复实际付出的代价,逐次 spawn 计时,交错执行两版本以消除热漂移。
// 红线校验:两版本 --json stdout 必须逐字节相等。
// 结果行:##RESULT## {json}
//
//   node benchmark/bench-cli.mjs [small|medium|large]   BENCH_RUNS=15

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
const stateFile = path.join(TEMP, "state.json");
if (!fs.existsSync(dbFile)) {
  console.error("夹具不存在,先运行: node benchmark/fixture-gen.mjs");
  process.exit(1);
}

const VARIANTS = {
  baseline: path.join(ROOT, "benchmark", "baseline-v0.9.0", "scripts", "token-rate.mjs"),
  current: path.join(ROOT, "plugins", "zcode-tps-monitor", "scripts", "token-rate.mjs"),
};

const env = {
  ...process.env,
  ZCODE_USAGE_DB: dbFile,
  TPS_MONITOR_STATE_FILE: stateFile,
  ZCODE_SESSION_ID: "sess_cur",
};

function runOnce(script, args) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "buffer", env });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.status !== 0) throw new Error(`${script} ${args.join(" ")} 退出码 ${r.status}: ${r.stderr}`);
  const stdout = r.stdout.toString("utf8");
  if (process.env.BENCH_DEBUG) console.error(`[debug] ${path.basename(script)} ${args.join(" ")} → ${JSON.stringify(stdout.slice(0, 160))}`);
  return { ms, stdout };
}

const scenarios = {
  "turn-current-json": ["--turn", "--current", "--json"],
  "turn-current-line": ["--turn", "--current"],
  "session-json": ["--json"],
};

const result = { bench: "cli", size, runs: RUNS, baseline: {}, current: {}, speedup: {} };
for (const [name, args] of Object.entries(scenarios)) {
  const samples = { baseline: [], current: [] };
  const outs = {};
  for (let i = 0; i < RUNS; i++) {
    // 交错执行:A B B A(消除时间方向的系统漂移)
    for (const v of i % 2 === 0 ? ["baseline", "current"] : ["current", "baseline"]) {
      const { ms, stdout } = runOnce(VARIANTS[v], args);
      samples[v].push(ms);
      (outs[v] ??= []).push(stdout);
    }
  }
  // 红线:同版本内部输出稳定,且两版本输出一致(--json 场景逐字节;文本行含时间取自数据,同样确定)
  assert.deepEqual([...new Set(outs.baseline)], [...new Set(outs.current)], `${name}: 两版本输出不一致`);
  if (outs.baseline.length) assert.equal(outs.baseline[0], outs.current[0], `${name}: 输出漂移`);
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const b = med(samples.baseline), c = med(samples.current);
  result.baseline[name] = +b.toFixed(2);
  result.current[name] = +c.toFixed(2);
  result.speedup[name] = +(b / c).toFixed(3);
}
result.sampleCounts = { baseline: RUNS, current: RUNS };
console.log(`[cli/${size}] ` + Object.entries(result.speedup).map(([k, v]) => `${k}×${v}`).join("  "));
console.log("##RESULT## " + JSON.stringify(result));
