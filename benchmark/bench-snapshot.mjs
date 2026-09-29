#!/usr/bin/env node
// 基准 3:采集层 snapshot()(demo 模式,无网络依赖,衡量本机 CPU 采样开销)。
// 场景:
//   cold-1   单次快照(进程首次调用,两版本都需真实采样 250ms)
//   seq-5    连续 5 次快照总耗时(长驻进程内的典型调用模式,如 MCP server)
// 形状校验(数据本身随机,不做逐字节比较):字段齐全、类型正确。
// 结果行:##RESULT## {json}
//
//   node benchmark/bench-snapshot.mjs

import assert from "node:assert/strict";
import path from "node:path";
import url from "node:url";

process.removeAllListeners("warning");
process.on("warning", () => {});

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const baseline = await import(url.pathToFileURL(path.join(ROOT, "benchmark", "baseline-v0.9.0", "scripts", "lib", "collect-core.mjs")).href);
const current = await import(url.pathToFileURL(path.join(ROOT, "plugins", "zcode-tps-monitor", "scripts", "lib", "collect-core.mjs")).href + "?cur");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function checkShape(s, tag) {
  assert.ok(s.time && typeof s.time === "string", `${tag}: time`);
  assert.equal(typeof s.tps, "number", `${tag}: tps`);
  assert.equal(s.mode, "demo", `${tag}: mode`);
  assert.ok(s.system && typeof s.system.cpuCores === "number", `${tag}: system`);
  assert.ok(s.system.cpuPercent === null || typeof s.system.cpuPercent === "number", `${tag}: cpuPercent`);
  assert.equal(typeof s.system.memPercent, "number", `${tag}: memPercent`);
}

async function cold1(mod, tag) {
  await sleep(1100); // 让两版本都脱离可能的缓存窗口,公平测"冷"路径
  const t = process.hrtime.bigint();
  const s = await mod.snapshot({});
  checkShape(s, tag);
  return Number(process.hrtime.bigint() - t) / 1e6;
}

async function seq5(mod, tag) {
  const t = process.hrtime.bigint();
  for (let i = 0; i < 5; i++) checkShape(await mod.snapshot({}), `${tag}#${i}`);
  return Number(process.hrtime.bigint() - t) / 1e6;
}

const result = { bench: "snapshot", baseline: {}, current: {}, speedup: {} };
const coldPairs = [];
for (let i = 0; i < 3; i++) {
  coldPairs.push([await cold1(baseline, `baseline/cold${i}`), await cold1(current, `current/cold${i}`)]);
}
const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
result.baseline["cold-1"] = +avg(coldPairs.map((p) => p[0])).toFixed(1);
result.current["cold-1"] = +avg(coldPairs.map((p) => p[1])).toFixed(1);
result.speedup["cold-1"] = +(result.baseline["cold-1"] / result.current["cold-1"]).toFixed(2);

// 连续场景:先各自做一次冷启动采样,再计时(衡量进程内的稳态)
await baseline.snapshot({});
await current.snapshot({});
result.baseline["seq-5"] = +(await seq5(baseline, "baseline")).toFixed(1);
result.current["seq-5"] = +(await seq5(current, "current")).toFixed(1);
result.speedup["seq-5"] = +(result.baseline["seq-5"] / result.current["seq-5"]).toFixed(2);

console.log(`[snapshot] cold×${result.speedup["cold-1"]}  seq5×${result.speedup["seq-5"]}`);
console.log("##RESULT## " + JSON.stringify(result));
