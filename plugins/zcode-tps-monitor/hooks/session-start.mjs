#!/usr/bin/env node
// SessionStart hook:
// 1) 记录"用户最后所处的会话"到状态文件(供收尾自测/CLI 锁定当前会话)
// 2) 注入一行使用提示(严格 JSON 输出)

import { writeSessionState } from "./lib.mjs";

const sid = process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
writeSessionState(sid, "session-start");

// 注意力优化:机制细节以每轮注入的【本轮统计】指令为准,这里只保留一次性
// 索引(命令入口 + 关闭开关),不重复讲解机制,也不写完整命令路径。
const hint =
  "[zcode-tps-monitor] 已就绪:每轮收尾统计见每轮注入的【本轮统计】指令。命令 /tps、/tps-doctor;" +
  '关闭注入:~/.zcode/tps-monitor.config.json 设 {"tokenRateLine":false}。';

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: hint,
    },
  })
);
