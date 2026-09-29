#!/usr/bin/env node
// 基准 5:watch() 采样节拍(壁钟时间,单位 ms)。
// 老实现每拍「等请求返回再睡 1s」(串行,总时长 n×(单次耗时+1s));
// 新实现每秒固定节拍并发发起(总时长 ≈(n-1)×1s+单次耗时)。
// 场景 ×2 变体(基线为冻结副本),每场景 ROUNDS 轮取最小值:
//   fast  接口 ~50ms   —— 校验输出逐字段一致(固定 JSON,确定性)
//   slow  接口 ~600ms  —— 同上;节拍收益的主场景
//   down  端口不通     —— 校验回退结构(演示值随机,只比结构)
// 结果行:##RESULT## {json}
//
//   node benchmark/bench-watch.mjs    BENCH_WATCH_SECONDS=5

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import url from "node:url";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const SECONDS = Number(process.env.BENCH_WATCH_SECONDS || 5);
const ROUNDS = Number(process.env.BENCH_WATCH_ROUNDS || 2);

const baseline = await import(
  url.pathToFileURL(path.join(ROOT, "benchmark", "baseline-v0.9.0", "scripts", "lib", "collect-core.mjs"))
);
const current = await import(
  url.pathToFileURL(path.join(ROOT, "plugins", "zcode-tps-monitor", "scripts", "lib", "collect-core.mjs"))
);

const BODY = JSON.stringify({ tps: 900, p50: 10, p95: 20, p99: 30, error_rate: 0.1 });

const startServer = (delayMs) =>
  new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(BODY);
      }, delayMs);
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });

const deadPort = () =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });

// 快/慢场景:接口返回固定 JSON → 两个变体的输出除 time 外必须逐字段一致
const stripTime = (w) => {
  const { time, ...rest } = w;
  return rest;
};
// down 场景:演示值随机,只比较结构(剔除随机数值字段)
const structure = (w) => ({
  isDemo: w.mode.startsWith("demo("),
  hasFallbackNote: w.mode.includes("已回退演示数据"),
  seconds: w.seconds,
  count: w.count,
  sampleCount: w.samples.length,
  sampleKeys: Object.keys(w.samples[0]).sort().join(","),
  topLevelKeys: Object.keys(w).filter((k) => k !== "time").sort().join(","),
});

async function timeWatch(variant, tpsUrl) {
  const t0 = Date.now();
  const w = await variant.watch(SECONDS, { TPS_URL: tpsUrl });
  return { ms: Date.now() - t0, w };
}

const result = { bench: "watch", seconds: SECONDS, rounds: ROUNDS, scenarios: {} };

// --- fast / slow:固定 JSON,输出全等校验 ---
for (const [name, delay] of [["fast", 50], ["slow", 600]]) {
  const { srv, port } = await startServer(delay);
  const tpsUrl = `http://127.0.0.1:${port}/metrics`;
  try {
    const b = [], c = [];
    let bw = null, cw = null;
    for (let i = 0; i < ROUNDS; i++) {
      const rb = await timeWatch(baseline, tpsUrl);
      const rc = await timeWatch(current, tpsUrl);
      b.push(rb.ms); c.push(rc.ms);
      bw = rb.w; cw = rc.w;
    }
    assert.deepEqual(stripTime(cw), stripTime(bw), `${name}: watch 输出不一致`);
    const pick = (a) => Math.min(...a);
    const base = pick(b), cur = pick(c);
    result.scenarios[name] = { baseline_ms: base, current_ms: cur, speedup: +(base / cur).toFixed(2) };
  } finally {
    srv.close();
  }
}

// --- down:回退结构校验 ---
{
  const port = await deadPort();
  const tpsUrl = `http://127.0.0.1:${port}/metrics`;
  const rb = await timeWatch(baseline, tpsUrl);
  const rc = await timeWatch(current, tpsUrl);
  assert.deepEqual(structure(rc.w), structure(rb.w), "down: 回退结构不一致");
  result.scenarios.down = {
    baseline_ms: rb.ms,
    current_ms: rc.ms,
    speedup: +(rb.ms / rc.ms).toFixed(2),
  };
}

for (const [name, s] of Object.entries(result.scenarios)) {
  console.log(`[watch] ${name}: ${s.baseline_ms}ms → ${s.current_ms}ms (×${s.speedup})`);
}
console.log("##RESULT## " + JSON.stringify(result));
