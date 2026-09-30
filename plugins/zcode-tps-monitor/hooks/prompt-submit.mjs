#!/usr/bin/env node
// UserPromptSubmit hook: 每次用户发消息时
// 1) 记录"用户最后所处的会话"与提问时间戳到状态文件(--current 守卫依赖该时间戳)
// 2) 注入"本问统计"指令:模型在回答收尾时运行 token-rate.mjs --turn --current,
//    把输出的"本问"速率行原样引用在回复末尾。--current 保证绝不把上一轮数据
//    冒充本问(纯问答轮无输出)。
//    指令命令行内联 ZCODE_SESSION_ID:多开 ZCode 窗口交替提问时,收尾自测锁定
//    本会话,不受状态文件里"最后所处会话"被其他窗口覆盖的影响。
//    命令使用 ~/.zcode/tps-rate.mjs 短路径副本(见 lib.mjs ensureRateShortcut):
//    完整安装路径反斜杠密集、分词很差,占注入近半 token;副本创建失败时回退完整路径。
// 输出必须为严格 JSON;任何失败注入空串,绝不阻塞对话。
// 可选配置 ~/.zcode/tps-monitor.config.json:
//   {"tokenRateLine": false} 关闭速率注入。

import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeSessionState, readConfig, ensureRateShortcut } from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RATE_SCRIPT = path.join(HERE, "..", "scripts", "token-rate.mjs");

const sid = process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
writeSessionState(sid, "prompt-submit");

// 本问统计指令(注意力优化:五要素齐全——①若调用过工具 ②收尾时机 ③命令
// ④原样引用贴末尾不改写 ⑤无输出/未调用不显示不为此调用——但措辞压缩,
// 且命令走短路径副本;~ 不加引号才会在 bash/PowerShell 里做 tilde 展开)
function turnStatsInstruction() {
  const shortcut = ensureRateShortcut(RATE_SCRIPT);
  const cmd =
    (sid ? `ZCODE_SESSION_ID="${sid}" ` : "") +
    (shortcut ? "node ~/.zcode/tps-rate.mjs" : `node "${RATE_SCRIPT}"`) +
    " --turn --current";
  return [
    "",
    "【本轮统计】本回复若调用过工具,在输出总结前运行一次:",
    cmd,
    "把输出行原样放「> 」引用块贴在回复最末尾(不改写数字、不追加内容);无输出或未调用过工具则不显示任何统计行、不为此调用工具。",
  ].join("\n");
}

function emit(ctx) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ctx } })
  );
}

try {
  const cfg = readConfig();
  emit(cfg.tokenRateLine === false ? "" : turnStatsInstruction());
} catch {
  emit("");
}
