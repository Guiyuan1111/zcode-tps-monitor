#!/usr/bin/env node
// 生成基准夹具:模拟 ZCode usage 库(model_usage 表)的 SQLite 文件 + 钩子状态文件。
// 写入 benchmark/TEMP/(已 gitignore,可随时删除重生成)。
//   node benchmark/fixture-gen.mjs            # 生成 small/medium/large 三档
//   node benchmark/fixture-gen.mjs medium     # 只生成一档
//
// 数据形态(固定种子,可复现):
//   - 3 个会话:sess_cur 占 60%、sess_a 25%、sess_b 15%,行按时间升序插入(行序=时间序)
//   - 85% main_turn / 15% sub;每 3 行共享一个 turn_id
//   - sess_cur 末尾追加"最新一轮"3 段,完成时间贴近 now-30s:
//     配套 state.json 的 ts=now-60s,使 --current 守卫正常放行

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { DatabaseSync } from "node:sqlite";

process.removeAllListeners("warning");
process.on("warning", () => {});

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const TEMP = path.join(ROOT, "benchmark", "TEMP");
const SIZES = { small: 2_000, medium: 20_000, large: 100_000 };

// 固定种子 PRNG(mulberry32):两次生成的夹具逐字节同分布,基准可复现
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genFixture(file, rows) {
  fs.rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE model_usage (
    session_id TEXT, status TEXT, query_source TEXT, model_id TEXT,
    output_tokens INTEGER, reasoning_tokens INTEGER, input_tokens INTEGER, cache_read_input_tokens INTEGER,
    first_token_at INTEGER, completed_at INTEGER, time_to_first_token_ms INTEGER, turn_id TEXT)`);

  const rand = rng(42);
  const now = Date.now();
  const spanEnd = now - 30_000;                       // 全部历史数据止于 now-30s
  const t0 = spanEnd - 60 * 24 * 3600 * 1000;         // 起点:60 天前
  const span = spanEnd - t0;

  const ins = db.prepare("INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  db.exec("BEGIN");
  for (let i = 0; i < rows; i++) {
    const r = (i + 1) / rows;
    const sid = r < 0.6 ? "sess_cur" : r < 0.85 ? "sess_a" : "sess_b";
    const source = rand() < 0.85 ? "main_turn" : "sub";
    const completed = Math.floor(t0 + span * r);
    const genMs = 500 + Math.floor(rand() * 25_000);
    const output = 100 + Math.floor(rand() * 3_900);
    const reasoning = rand() < 0.4 ? Math.floor(rand() * 2_000) : 0;
    ins.run(sid, "completed", source, "bench-model",
      output, reasoning, 120_000, 118_000,
      completed - genMs, completed, 200 + Math.floor(rand() * 2_000),
      `t_${Math.floor(i / 3)}`);
  }
  // sess_cur 最新一轮(3 段 main_turn):--turn --current 的目标数据
  const lastTurn = `t_${Math.ceil(rows / 3)}`;
  for (let k = 0; k < 3; k++) {
    const completed = now - 30_000 + k * 100;
    const genMs = 800 + k * 400;
    ins.run("sess_cur", "completed", "main_turn", "bench-model",
      900 + k * 300, 0, 120_000, 118_000,
      completed - genMs, completed, 300 + k * 100, lastTurn);
  }
  db.exec("COMMIT");
  db.close();
  return { file, rows: rows + 3 };
}

const wanted = process.argv[2];
fs.mkdirSync(TEMP, { recursive: true });
const made = {};
for (const [name, rows] of Object.entries(SIZES)) {
  if (wanted && name !== wanted) continue;
  made[name] = genFixture(path.join(TEMP, `fixture-${name}.sqlite`), rows);
}
const stateFile = path.join(TEMP, "state.json");
const stateTs = Date.now() - 60_000;
fs.writeFileSync(stateFile, JSON.stringify({ sessionId: "sess_cur", ts: stateTs, source: "bench" }));
console.log(JSON.stringify({ temp: TEMP, fixtures: made, stateFile, stateTs }, null, 2));
