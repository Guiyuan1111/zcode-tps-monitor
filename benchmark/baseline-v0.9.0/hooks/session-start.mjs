#!/usr/bin/env node
// SessionStart hook:
// 1) 记录"用户最后所处的会话"到状态文件(供收尾自测/CLI 锁定当前会话)
// 2) 注入一行使用提示(严格 JSON 输出)

import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeSessionState } from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RATE_SCRIPT = path.join(HERE, "..", "scripts", "token-rate.mjs");

const sid = process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
writeSessionState(sid, "session-start");

// 与 prompt-submit 的「本问统计指令」保持一致:回复收尾时模型自测本问速率
// (--turn --current 有守卫,纯问答轮不输出、绝不显示上一轮)。
// 机制细节以每轮注入的指令为准,这里只保留一次性的简短提示,不逐轮重复。
// 注意不要写"速率会自动显示/无需转发"——当前客户端版本不触发 Stop 钩子,
// 那类表述会让模型收尾时什么都不做。
const hint = [
  `[zcode-tps-monitor] 已就绪。每条回复收尾时(若该回复调用过工具)运行一次:node "${RATE_SCRIPT}" --turn --current,`,
  "把输出的一行原样放入 Markdown 引用块(行首加「> 」)贴在回复最末尾;脚本没有输出(如纯问答)则不显示任何统计行。",
  "命令:/tps(快照)、/tps-doctor(自检)。关闭注入:~/.zcode/tps-monitor.config.json → {\"tokenRateLine\":false}。",
].join("");

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: hint,
    },
  })
);
