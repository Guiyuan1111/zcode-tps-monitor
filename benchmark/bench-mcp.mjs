#!/usr/bin/env node
// 基准 4:MCP stdio server 请求吞吐(帧解析 + 分发 + 序列化)。
// 场景(两个变体各跑一次,交错):
//   chunked  1×initialize + N×tools/list,分多次写入(每块 25 帧)——典型客户端节奏
//   burst    200 帧一次写入——压测单块多帧的解析循环
// 校验:响应数量相等;另跑一轮 initialize+tools/list+ping 探测,归一化
// serverInfo 版本号与描述文本(注意力优化面)后逐字节比对——序列化结构不得改变。
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
  for (let i = 0; i < ROUNDS; i++) {
    const rb = await runServer(VARIANTS.baseline, scenario);
    const rc = await runServer(VARIANTS.current, scenario);
    assert.equal(rb.got, rc.got, `${scenario}: 响应数不一致`);
    b.push(rb.ms); c.push(rc.ms);
  }
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  result.baseline[scenario] = +avg(b).toFixed(1);
  result.current[scenario] = +avg(c).toFixed(1);
  result.speedup[scenario] = +(result.baseline[scenario] / result.current[scenario]).toFixed(2);
}

// --- 红线:协议应答逐字节一致(归一化 serverInfo 里的版本号差异后) ---
async function probeOutputs(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", () => {});
    child.on("error", reject);
    const timer = setTimeout(() => { child.kill(); reject(new Error("probe 超时")); }, 20_000);
    const poll = setInterval(() => {
      if ((out.match(/"jsonrpc":"2\.0"/g) || []).length >= 3) {
        clearInterval(poll); clearTimeout(timer); child.kill();
        resolve(
          out.replace(/"version":"0\.\d+\.\d+"/g, '"version":"V"')
            // 工具描述文本是注意力优化面(v0.9.6 起有意精简):描述与随之变化的
            // 帧长度规范化后比对,序列化结构/帧序/字段序仍须逐字节一致
            .replace(/"description":"[^"]*"/g, '"description":"D"')
            .replace(/Content-Length: \d+/g, "Content-Length: L")
        );
      }
    }, 5);
    child.stdin.write(Buffer.concat([
      req(0, "initialize"),
      frame({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      frame({ jsonrpc: "2.0", id: 2, method: "ping" }),
    ]));
  });
}
assert.equal(await probeOutputs(VARIANTS.baseline), await probeOutputs(VARIANTS.current), "协议应答不一致");

// --- 微基准(确定性,纯 CPU):tools/list 单帧序列化成本 ---
// 从探测应答里解析出真实的 result 对象,避免在基准里复制一份会漂移的 TOOLS 定义
const probeOut = await probeOutputs(VARIANTS.current);
const body1 = /(\{"jsonrpc":"2\.0","id":1[^]*?\})(?=Content-Length:|$)/.exec(probeOut)[1];
const toolsResult = JSON.parse(body1).result;
const pre = JSON.stringify(toolsResult);
assert.deepEqual(JSON.parse(pre), toolsResult); // 预序列化串内容一致
function microBench(label, fn) {
  const iters = 20_000;
  fn(); fn(); // 预热
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const ns = Number(process.hrtime.bigint() - t0) / iters;
  return { label, nsPerOp: +ns.toFixed(0) };
}
const microWhole = microBench("object", () => JSON.stringify({ tools: toolsResult.tools }));
const microPre = microBench("preserialized", () => `{"jsonrpc":"2.0","id":${JSON.stringify(42)},"result":${pre}}`);
result.micro = {
  wholeObject_nsPerFrame: microWhole.nsPerOp,
  preserialized_nsPerFrame: microPre.nsPerOp,
};

console.log(`[mcp] chunked×${result.speedup.chunked}  burst×${result.speedup.burst}` +
  `  micro:object=${microWhole.nsPerOp}ns preserialized=${microPre.nsPerOp}ns`);
console.log("##RESULT## " + JSON.stringify(result));
