#!/usr/bin/env node
// 一键跑全部基准:缺夹具先生成,逐个执行并收集 ##RESULT## 行,
// 汇总为 Markdown 表打印,并落盘 benchmark/TEMP/results.json 供报告引用。
//
//   node benchmark/run-all.mjs                 # 默认 medium
//   BENCH_SIZE=large node benchmark/run-all.mjs
//   BENCH_SKIP=mcp node benchmark/run-all.mjs  # 跳过指定项(逗号分隔:token-rate,cli,hooks,snapshot,mcp,watch)

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const TEMP = path.join(HERE, "TEMP");
const size = process.env.BENCH_SIZE || "medium";
const skip = new Set((process.env.BENCH_SKIP || "").split(",").filter(Boolean));
const node = process.execPath;

const dbFile = path.join(TEMP, `fixture-${size}.sqlite`);
if (!fs.existsSync(dbFile) || !fs.existsSync(path.join(TEMP, "state.json"))) {
  console.error(`> 生成 ${size} 夹具...`);
  const g = spawnSync(node, [path.join(HERE, "fixture-gen.mjs"), size], { encoding: "utf8", stdio: "inherit" });
  if (g.status !== 0) process.exit(g.status ?? 1);
}

const benches = [
  { name: "token-rate", script: "bench-token-rate.mjs", args: [size] },
  { name: "cli", script: "bench-cli.mjs", args: [size] },
  { name: "hooks", script: "bench-hooks.mjs", args: [size] },
  { name: "snapshot", script: "bench-snapshot.mjs", args: [] },
  { name: "mcp", script: "bench-mcp.mjs", args: [] },
  { name: "watch", script: "bench-watch.mjs", args: [] },
];

const results = {};
for (const b of benches) {
  if (skip.has(b.name)) { console.log(`> 跳过 ${b.name}`); continue; }
  console.log(`\n> ${b.name} (${size})`);
  const r = spawnSync(node, [path.join(HERE, b.script), ...b.args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, BENCH_SIZE: size },
  });
  if (r.status !== 0) { console.error(`${b.name} 失败`); process.exit(r.status ?? 1); }
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("##RESULT## ")) results[b.name] = JSON.parse(line.slice(11));
  }
}

// --- 汇总表 ---
const lines = [`# 基准汇总(${size})`, "", `运行时间: ${new Date().toISOString()}`, ""];
for (const [name, r] of Object.entries(results)) {
  lines.push(`## ${name}`);
  lines.push("");
  const keys = Object.keys(r.baseline || {});
  lines.push("| 场景 | 基线 | 当前 | 加速比 |");
  lines.push("|---|---|---|---|");
  for (const k of keys) {
    lines.push(`| ${k} | ${r.baseline[k]} ms | ${r.current[k]} ms | ×${r.speedup[k]} |`);
  }
  lines.push("");
}
fs.writeFileSync(path.join(TEMP, "results.json"), JSON.stringify({ size, at: new Date().toISOString(), results }, null, 2));
console.log(lines.join("\n"));
console.log(`\nJSON 已写入 ${path.join(TEMP, "results.json")}`);
