#!/usr/bin/env node
// UserPromptSubmit hook: 每次用户发消息时
// 1) 记录"用户最后所处的会话"与提问时间戳到状态文件(--current 守卫依赖该时间戳)
// 2) 注入"本问统计"指令:模型在回答收尾时运行 token-rate.mjs --turn --current,
//    把输出的"本问"速率行原样引用在回复末尾。--current 保证绝不把上一轮数据
//    冒充本问(纯问答轮无输出)。
//    指令命令行内联 ZCODE_SESSION_ID:多开 ZCode 窗口交替提问时,收尾自测锁定
//    本会话,不受状态文件里"最后所处会话"被其他窗口覆盖的影响。
// 输出必须为严格 JSON;任何失败注入空串,绝不阻塞对话。
// 可选配置 ~/.zcode/tps-monitor.config.json:
//   {"tokenRateLine": false} 关闭速率注入。

import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeSessionState, readConfig } from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RATE_SCRIPT = path.join(HERE, "..", "scripts", "token-rate.mjs");

const sid = process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
writeSessionState(sid, "prompt-submit");

// 本问统计指令:模型在收尾时自测当前提问的速率并引用。
// --current 守卫确保:最新 turn 的数据早于本次提问时刻时脚本输出为空,
// 此时模型不显示任何统计行 —— 任何情况下都不把上一轮数据当作本问展示。
const WRAP_UP_CMD = `${sid ? `ZCODE_SESSION_ID="${sid}" ` : ""}node "${RATE_SCRIPT}" --turn --current`;
const TURN_STATS_INSTRUCTION = [
  "",
  "【本轮统计指令】若你在本次回答中已经调用过工具,请在收尾时(所有其他工作完成之后、输出最终总结文字之前)运行一次:",
  WRAP_UP_CMD,
  "它会输出一行「本提问从提出到最近一次工具调用」的真实 token 速率统计。把该行原样放入 Markdown 引用块(在新行行首加「> 」)贴在回复最末尾;不要改写数字、不要追加任何其他内容。",
  "若脚本没有输出任何统计行,或本次回答你没有调用过任何工具,则不要显示任何统计行、也不要为此额外调用工具。",
].join("\n");

function emit(ctx) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ctx } })
  );
}

try {
  const cfg = readConfig();
  emit(cfg.tokenRateLine === false ? "" : TURN_STATS_INSTRUCTION);
} catch {
  emit("");
}
