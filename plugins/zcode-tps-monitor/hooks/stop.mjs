#!/usr/bin/env node
// Stop hook: 主回复刚结束 → 本轮(刚完成的用户轮次)的全部请求已写入 usage 库。
// 此时计算"本轮即时速率",经 systemMessage 直接显示给用户——
// 消除 UserPromptSubmit 只能看到上一轮的固有滞后(发送消息的瞬间本轮尚未发生)。
// 当前客户端版本暂不触发该事件(兼容保留)。输出严格 JSON;任何异常静默退出,不影响对话。

import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeSessionState, readConfig } from "./lib.mjs";

// stdin 是钩子入参 JSON(含 session_id);设超时兜底,客户端不给 stdin 也不挂起
function readStdin() {
  return new Promise((resolve) => {
    let raw = "";
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve(raw);
      }
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", finish);
    setTimeout(finish, 1500);
  });
}

async function main() {
  let payload = {};
  try {
    payload = JSON.parse((await readStdin()) || "{}");
  } catch {}
  const sid =
    payload.session_id ||
    process.env.ZCODE_SESSION_ID ||
    process.env.CLAUDE_SESSION_ID ||
    "";
  writeSessionState(sid, "stop");

  const cfg = readConfig();
  if (cfg.tokenRateLine === false || cfg.stopHookLine === false) return;

  // 动态导入:不支持 node:sqlite 的旧版 Node 在此优雅退出,而非模块加载即崩
  const { queryTurn, formatTurnLine } = await import("../scripts/token-rate.mjs");

  // Stop 触发与末次请求写库之间存在毫秒级竞态,短重试直到本轮出现有效样本
  let r = null;
  for (let i = 0; i < 5; i++) {
    r = queryTurn(sid || null);
    if (r.turn && r.turn.rated > 0) break;
    if (i < 4) await new Promise((res) => setTimeout(res, 250));
  }
  if (!r || !r.turn) return; // 无本轮数据(如中断轮)则不打扰
  process.stdout.write(JSON.stringify({ systemMessage: formatTurnLine(r) }));
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
