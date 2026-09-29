// 单元测试:采集核心(collect-core.mjs)的远程取数与 watch 采样。
// node --test test/

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "zcode-tps-monitor");
const { watch, fetchRemoteMetrics } = await import(
  pathToFileURL(path.join(PLUGIN, "scripts", "lib", "collect-core.mjs"))
);

const BODY = JSON.stringify({ tps: 900, p50: 10, p95: 20, p99: 30, error_rate: 0.1 });

function startServer(delayMs) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(BODY);
      }, delayMs);
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/metrics` }));
  });
}

// 预留一个端口后立即关闭:得到一个"几乎必然连接被拒"的地址
function deadPortUrl() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(`http://127.0.0.1:${port}/metrics`));
    });
  });
}

test("fetchRemoteMetrics: 一层嵌套字段宽松匹配", async () => {
  const { srv, url } = await startServer(0);
  try {
    const m = await fetchRemoteMetrics(url, 2000);
    assert.deepEqual(m, { tps: 900, p50: 10, p95: 20, p99: 30, errorRate: 0.1 });
  } finally {
    srv.close();
  }
});

test("watch: 远程接口可用 → remote 模式,样本为接口固定值", async () => {
  const { srv, url } = await startServer(20);
  try {
    const w = await watch(2, { TPS_URL: url });
    assert.equal(w.mode, "remote");
    assert.equal(w.count, 2);
    assert.equal(w.seconds, 2);
    assert.equal(w.tps.avg, 900);
    assert.equal(w.tps.min, 900);
    assert.equal(w.tps.max, 900);
    assert.deepEqual(w.samples[0], { tps: 900, p50: 10, p95: 20, p99: 30, errorRate: 0.1 });
  } finally {
    srv.close();
  }
});

test("watch: 接口不可用 → 回退演示数据,结构完整且标注原因", async () => {
  const url = await deadPortUrl();
  const w = await watch(2, { TPS_URL: url });
  assert.ok(w.mode.startsWith("demo("), `mode=${w.mode}`);
  assert.ok(w.mode.includes("已回退演示数据"));
  assert.equal(w.count, 2);
  assert.equal(w.samples.length, 2);
  for (const s of w.samples) {
    assert.equal(typeof s.tps, "number");
    assert.ok(Number.isFinite(s.p95));
  }
});

test("watch: 未配置 TPS_URL → 纯演示模式", async () => {
  const w = await watch(2, {});
  assert.equal(w.mode, "demo");
  assert.equal(w.count, 2);
});
