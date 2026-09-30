#!/usr/bin/env node
// 钩子共用:跨进程状态文件写入与用户配置读取。
// (此前三个钩子各持一份拷贝,是口径漂移的温床——统一到此处。)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 路径契约与 scripts/token-rate.mjs 保持一致(可用环境变量覆盖,便于测试/多实例)
const STATE_FILE =
  process.env.TPS_MONITOR_STATE_FILE ||
  path.join(os.homedir(), ".zcode", "tps-monitor.last-session.json");
const CONFIG_FILE = path.join(os.homedir(), ".zcode", "tps-monitor.config.json");

// 记录"用户最后所处的会话"与时刻:
// token-rate 的会话跟随与 --current 守卫都以 ts 为基准,缺失则守卫退化为放行。
export function writeSessionState(sid, source) {
  if (!sid) return;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ sessionId: sid, ts: Date.now(), source }));
  } catch {}
}

export function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

// AI 收尾自测命令用的短路径副本:注入文本里的完整插件安装路径(反斜杠密集、
// 分词很差)占指令近半 token;把零依赖独立的 token-rate.mjs 复制到
// ~/.zcode/tr.mjs 后,命令缩短到 ~30 字符。副本文件名必须为 tr.mjs——脚本的
// CLI 守卫按 process.argv[1] 基名白名单判定(token-rate.mjs / tr.mjs),改名即
// 与守卫失配、静默无输出。每次注入前校验内容,不一致(插件升级/换缓存版本)即
// 刷新并顺手清理 0.9.7 及更早版本的旧名副本;任何失败返回 null,调用方回退完整路径。
export function ensureRateShortcut(rateScriptPath) {
  try {
    const dest = path.join(os.homedir(), ".zcode", "tr.mjs");
    const src = fs.readFileSync(rateScriptPath);
    let cur = null;
    try {
      cur = fs.readFileSync(dest);
    } catch {}
    if (!cur || !cur.equals(src)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, src);
      try {
        fs.unlinkSync(path.join(os.homedir(), ".zcode", "token-rate.mjs")); // 旧名副本升级清理
      } catch {}
    }
    return dest;
  } catch {
    return null;
  }
}
