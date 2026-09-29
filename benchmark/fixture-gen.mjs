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
  // 与真实 ~/.zcode/cli/db/db.sqlite 的 model_usage 表同构(列集/索引一字不差,
  // 从真实库 sqlite_master 转录),确保基准的查询计划与生产一致
  db.exec(`CREATE TABLE model_usage (
        id text primary key,
        logical_request_id text not null,
        attempt_index integer not null default 0,
        session_id text not null,
        turn_id text,
        trace_id text,
        span_id text,
        assistant_message_id text,
        parent_user_message_id text,
        query_source text not null,
        provider_id text not null,
        model_id text not null,
        variant text,
        agent text,
        mode text,
        task_type text,
        status text not null,
        started_at integer not null,
        first_token_at integer,
        completed_at integer,
        duration_ms integer,
        time_to_first_token_ms integer,
        finish_reason text,
        tool_call_count integer not null default 0,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        reasoning_tokens integer not null default 0,
        cache_creation_input_tokens integer not null default 0,
        cache_read_input_tokens integer not null default 0,
        provider_total_tokens integer,
        computed_total_tokens integer not null default 0,
        retry_count integer not null default 0,
        retryable integer not null default 0,
        cancelled_by_user integer not null default 0,
        context_exceeded integer not null default 0,
        error_type text,
        error_code text,
        error_message text,
        raw_usage_json text,
        provider_metadata_json text
      );
      CREATE INDEX model_usage_started_model_idx on model_usage(started_at, provider_id, model_id);
      CREATE INDEX model_usage_session_turn_idx on model_usage(session_id, turn_id);
      CREATE INDEX model_usage_trace_idx on model_usage(trace_id);
      CREATE INDEX model_usage_query_source_idx on model_usage(query_source);`);

  const rand = rng(42);
  const now = Date.now();
  const spanEnd = now - 30_000;                       // 全部历史数据止于 now-30s
  const t0 = spanEnd - 60 * 24 * 3600 * 1000;         // 起点:60 天前
  const span = spanEnd - t0;

  const ins = db.prepare(`INSERT INTO model_usage
    (id, logical_request_id, session_id, turn_id, query_source, provider_id, model_id,
     status, started_at, first_token_at, completed_at, duration_ms, time_to_first_token_ms,
     finish_reason, input_tokens, output_tokens, reasoning_tokens, cache_read_input_tokens)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  db.exec("BEGIN");
  for (let i = 0; i < rows; i++) {
    const r = (i + 1) / rows;
    const sid = r < 0.6 ? "sess_cur" : r < 0.85 ? "sess_a" : "sess_b";
    const source = rand() < 0.85 ? "main_turn" : "sub";
    const completed = Math.floor(t0 + span * r);
    const genMs = 500 + Math.floor(rand() * 25_000);
    const output = 100 + Math.floor(rand() * 3_900);
    const reasoning = rand() < 0.4 ? Math.floor(rand() * 2_000) : 0;
    ins.run(`r_${i}`, `lr_${i}`, sid, `t_${Math.floor(i / 3)}`, source, "bench", "bench-model",
      "completed", completed - genMs - 300, completed - genMs, completed, genMs + 300,
      200 + Math.floor(rand() * 2_000), "stop",
      120_000, output, reasoning, 118_000);
  }
  // sess_cur 最新一轮(3 段 main_turn + 1 段 sub):--turn --current 的目标数据。
  // 特意混入 sub 行:等价断言必须覆盖"main scope 下 sub 行被排除"的过滤路径
  const lastTurn = `t_${Math.ceil(rows / 3)}`;
  for (let k = 0; k < 3; k++) {
    const completed = now - 30_000 + k * 100;
    const genMs = 800 + k * 400;
    ins.run(`r_last_${k}`, `lr_last_${k}`, "sess_cur", lastTurn, "main_turn", "bench", "bench-model",
      "completed", completed - genMs - 300, completed - genMs, completed, genMs + 300,
      300 + k * 100, "stop", 120_000, 900 + k * 300, 0, 118_000);
  }
  ins.run("r_last_sub", "lr_last_sub", "sess_cur", lastTurn, "sub", "bench", "bench-model",
    "completed", now - 29_500, now - 29_400, now - 29_300, 1_000, 500, "stop", 120_000, 4_321, 0, 118_000);
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
