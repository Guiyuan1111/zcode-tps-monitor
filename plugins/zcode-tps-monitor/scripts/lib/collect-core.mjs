// 采集核心:CLI(scripts/collect.mjs)与 MCP server(mcp/tps-server.mjs)共用。
// 零第三方依赖,要求 Node >= 18(全局 fetch)。

import os from "node:os";

// ---------- 工具 ----------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

export function resolveUrl(env = process.env) {
  // 未配置的 user_config 占位符原样传入时视为未配置
  const url = (env.TPS_URL || "").trim();
  if (!url || url.startsWith("${")) return null;
  return url;
}

// ---------- 演示数据(随机游走,数值连续且逼真) ----------

const demo = { tps: 820, p50: 12.4, err: 0.12 };

function demoStep() {
  demo.tps = clamp(demo.tps + (Math.random() * 120 - 60), 240, 1560);
  demo.p50 = clamp(demo.p50 + (Math.random() * 2 - 1), 6, 40);
  demo.err = clamp(demo.err + (Math.random() * 0.08 - 0.04), 0.01, 2.5);
  return {
    tps: Math.round(demo.tps),
    p50: r1(demo.p50),
    p95: r1(demo.p50 * 2.6),
    p99: r1(demo.p50 * 4.1),
    errorRate: r2(demo.err),
  };
}

// ---------- 远程接口(字段名宽松匹配,支持一层嵌套) ----------

const TPS_KEYS = ["tps", "qps", "throughput", "transactionsPerSecond"];
const LAT_KEYS = { p50: ["p50", "latency_p50"], p95: ["p95", "latency_p95"], p99: ["p99", "latency_p99"] };
const ERR_KEYS = ["error_rate", "errorRate", "err_rate"];

function deepFind(obj, keys, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 3) return undefined;
  for (const k of keys) {
    if (typeof obj[k] === "number" && isFinite(obj[k])) return obj[k];
  }
  for (const v of Object.values(obj)) {
    const hit = deepFind(v, keys, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

export async function fetchRemoteMetrics(url, timeoutMs = 5000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // 超时计时覆盖到 body 读完:发完头就挂住的慢响应体同样被中止,不会悬挂调用方
    const data = await res.json();
    const tps = deepFind(data, TPS_KEYS);
    if (tps === undefined) throw new Error("响应中未找到 tps/qps 字段");
    return {
      tps: Math.round(tps),
      p50: deepFind(data, LAT_KEYS.p50) ?? null,
      p95: deepFind(data, LAT_KEYS.p95) ?? null,
      p99: deepFind(data, LAT_KEYS.p99) ?? null,
      errorRate: deepFind(data, ERR_KEYS) ?? null,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 本机系统资源(Windows 下 loadavg 恒为 0,用 CPU 时间差采样) ----------

// 进程内静态值缓存:核数/总内存/平台在进程生命周期内不会变化,
// 而 os.cpus()/os.totalmem() 在 Windows 上是相对昂贵的系统查询
const CPU_COUNT = os.cpus().length;
const TOTAL_MEM_MB = os.totalmem() / 1048576;
const PLATFORM = `${os.platform()}/${os.arch()}`;

function cpuTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.idle + c.times.user + c.times.nice + c.times.sys + c.times.irq;
  }
  return { idle, total };
}

function sampleOnce(intervalMs) {
  const a = cpuTimes();
  return new Promise((r) => setTimeout(r, intervalMs)).then(() => {
    const b = cpuTimes();
    const dIdle = b.idle - a.idle, dTotal = b.total - a.total;
    return dTotal <= 0 ? null : r1(clamp((1 - dIdle / dTotal) * 100, 0, 100));
  });
}

// CPU% 进程内短缓存(默认 1s):长驻进程(MCP server)里连续快照不再每次阻塞
// 一个完整的采样窗口;并发调用共享同一次在途采样。CLI 单发进程行为不变
// (首次调用永远真实采样)。监控语义上 ≤1s 陈旧的 CPU% 属于可接受精度。
let cpuCache = { at: 0, val: undefined };
let cpuInFlight = null;

export async function sampleCpuPercent(intervalMs = 250, opts = {}) {
  const maxAgeMs = opts.maxAgeMs ?? 1000;
  if (maxAgeMs > 0 && cpuCache.val !== undefined && Date.now() - cpuCache.at <= maxAgeMs) {
    return cpuCache.val;
  }
  if (!cpuInFlight) {
    cpuInFlight = sampleOnce(intervalMs)
      .then((val) => {
        cpuCache = { at: Date.now(), val };
        return val;
      })
      .finally(() => {
        cpuInFlight = null;
      });
  }
  return cpuInFlight;
}

async function systemMetrics() {
  const cpuPercent = await sampleCpuPercent();
  const freeMB = os.freemem() / 1048576;
  return {
    cpuPercent,
    cpuCores: CPU_COUNT,
    memTotalMB: Math.round(TOTAL_MEM_MB),
    memUsedMB: Math.round(TOTAL_MEM_MB - freeMB),
    memPercent: r1(((TOTAL_MEM_MB - freeMB) / TOTAL_MEM_MB) * 100),
    hostUptimeHours: r1(os.uptime() / 3600),
    platform: PLATFORM,
  };
}

// ---------- 快照与采样 ----------

export async function snapshot(env = process.env) {
  const url = resolveUrl(env);
  // 远程指标与本机 CPU 采样并行:总延迟取两者较大值而非求和(CPU 采样本身 250ms)
  const metricsJob = (async () => {
    if (url) {
      try {
        return { m: await fetchRemoteMetrics(url), mode: "remote" };
      } catch (err) {
        return { m: demoStep(), mode: `demo(接口不可用: ${err.message},已回退演示数据)` };
      }
    }
    return { m: demoStep(), mode: "demo" };
  })();
  const [{ m, mode }, system] = await Promise.all([metricsJob, systemMetrics()]);
  return { time: new Date().toISOString(), mode, ...m, system };
}

export async function watch(seconds, env = process.env) {
  const n = clamp(Math.round(seconds || 5), 2, 60);
  const url = resolveUrl(env);
  const samples = [];
  let mode = url ? "remote" : "demo";
  let fallbackNote = null;
  for (let i = 0; i < n; i++) {
    if (url && mode === "remote") {
      try {
        const m = await fetchRemoteMetrics(url, 3000);
        samples.push(m);
      } catch (err) {
        mode = "demo";
        fallbackNote = `接口不可用(${err.message}),已回退演示数据`;
        samples.push(demoStep());
      }
    } else {
      samples.push(demoStep());
    }
    if (i < n - 1) await new Promise((r) => setTimeout(r, 1000));
  }
  const tpsArr = samples.map((s) => s.tps).sort((a, b) => a - b);
  const stat = (arr, q) => arr[Math.min(arr.length - 1, Math.floor(arr.length * q))];
  const avg = (f) => r1(samples.reduce((s, x) => s + (x[f] ?? 0), 0) / samples.filter((x) => x[f] != null).length);
  return {
    time: new Date().toISOString(),
    mode: fallbackNote ? `demo(${fallbackNote})` : mode,
    seconds: n,
    count: samples.length,
    tps: { avg: Math.round(avg("tps")), min: tpsArr[0], max: tpsArr[tpsArr.length - 1] },
    p95avg: avg("p95"),
    p99avg: avg("p99"),
    errorRateAvg: r2(avg("errorRate")),
    samples,
  };
}

// ---------- 人类可读输出 ----------

const GB = (mb) => (mb / 1024).toFixed(1);

export function formatSnapshot(s) {
  const t = s.time.replace("T", " ").slice(0, 19);
  const lines = [
    `⏱ TPS 监控快照  ${t}   [模式: ${s.mode}]`,
    `  TPS(当前)         : ${s.tps}`,
    `  延迟 p50/p95/p99   : ${s.p50 ?? "-"} / ${s.p95 ?? "-"} / ${s.p99 ?? "-"} ms`,
    `  错误率             : ${s.errorRate ?? "-"} %`,
    `  —— 系统资源 ——`,
    `  CPU                : ${s.system.cpuPercent ?? "-"} %  (${s.system.cpuCores} 核)`,
    `  内存               : ${GB(s.system.memUsedMB)} / ${GB(s.system.memTotalMB)} GB (${s.system.memPercent} %)`,
    `  主机运行时长       : ${s.system.hostUptimeHours} 小时  (${s.system.platform})`,
  ];
  return lines.join("\n");
}

export function formatWatch(w) {
  const t = w.time.replace("T", " ").slice(0, 19);
  const head = `⏱ TPS 采样报告  ${t}   [模式: ${w.mode}]  采样 ${w.count} 次 × 1s`;
  const rows = w.samples.map((s, i) => `  #${String(i + 1).padStart(2, "0")}  tps=${String(s.tps).padEnd(6)} p95=${String(s.p95 ?? "-").padEnd(6)} err=${s.errorRate ?? "-"}%`);
  const stat = [
    `  —— 统计 ——`,
    `  TPS 平均/最小/最大  : ${w.tps.avg} / ${w.tps.min} / ${w.tps.max}`,
    `  p95 均值           : ${w.p95avg} ms`,
    `  p99 均值           : ${w.p99avg} ms`,
    `  错误率均值         : ${w.errorRateAvg} %`,
  ];
  return [head, ...rows, ...stat].join("\n");
}
