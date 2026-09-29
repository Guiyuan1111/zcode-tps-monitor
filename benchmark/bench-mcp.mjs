#!/usr/bin/env node
// 基准 4:MCP stdio server 请求吞吐(帧解析 + 分发 + 序列化)。
// 场景(两个变体各跑一次,交错):
//   chunked  1×initialize + N×tools/list,分多次写入(每块 25 帧)——典型客户端节奏
//   burst    200 帧一次写入——压测单块多帧的解析循环
// 校验:响应数量相等、initialize 应答一致(版本来自 plugin.json,两处已对齐)。
// 结果行:##RESULT## {json}
//
//   node benchmark/bench-mcp.mjs    BENCH_MCP_N=300

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import url from "node:url";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const N = Number(process.env.BENCH_MCP_N || 300);
const ROUNDS = Number(process.env.BENCH_MCP_ROUNDS || 3);

const VARIANTS = {
  baseline: path.join(ROOT, "benchmark", "baseline-v0.9.0", "mcp", "tps-server.mjs"),
  current: path.join(ROOT, "plugins", "zcode-tps-monitor", "mcp", "tps-server.mjs"),
};

const frame = (obj) => {
  const body = JSON.stringify(obj);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
};
const req = (id, method) => frame({ jsonrpc: "2.0", id, method, params: method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bench", version: "0" } } : {} });

function runServer(script, scenario) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${scenario} 超时`)); }, 60_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", () => {});
    child.on("error", reject);

    let expected = 0;
    const writes = [];
    if (scenario === "chunked") {
      const frames = [req(0, "initialize")];
      for (let i = 1; i <= N; i++) frames.push(req(i, "tools/list"));
      for (let i = 0; i < frames.length; i += 25) writes.push(Buffer.concat(frames.slice(i, i + 25)));
      expected = N + 1;
    } else {
      const frames = [req(0, "initialize")];
      for (let i = 1; i <= 200; i++) frames.push(req(i, "tools/list"));
      writes.push(Buffer.concat(frames));
      expected = 201;
    }

    const count = () => (out.match(/"jsonrpc":"2\.0"/g) || []).length;
    const t0 = process.hrtime.bigint();
    const poll = setInterval(() => {
      if (count() >= expected) {
        clearInterval(poll);
        clearTimeout(timer);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        const initBody = /"id":0[^]*?"result":\{[^]*?\}/.exec(out);
        child.kill();
        resolve({ ms, got: count(), init: initBody ? initBody[0].slice(0, 400) : null });
      }
    }, 5);
    for (const w of writes) child.stdin.write(w);
  });
}

const result = { bench: "mcp", n: N, rounds: ROUNDS, baseline: {}, current: {}, speedup: {} };
for (const scenario of ["chunked", "burst"]) {
  const b = [], c = [];
  let initB = null, initC = null;
  for (let i = 0; i < ROUNDS; i++) {
    const rb = await runServer(VARIANTS.baseline, scenario);
    const rc = await runServer(VARIANTS.current, scenario);
    assert.equal(rb.got, rc.got, `${scenario}: 响应数不一致`);
    b.push(rb.ms); c.push(rc.ms);
    initB ??= rb.init; initC ??= rc.init;
  }
  assert.equal(initB, initC, `${scenario}: initialize 应答不一致`);
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  result.baseline[scenario] = +avg(b).toFixed(1);
  result.current[scenario] = +avg(c).toFixed(1);
  result.speedup[scenario] = +(result.baseline[scenario] / result.current[scenario]).toFixed(2);
}
console.log(`[mcp] chunked×${result.speedup.chunked}  burst×${result.speedup.burst}`);
console.log("##RESULT## " + JSON.stringify(result));
