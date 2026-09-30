---
description: 自检 zcode-tps-monitor 插件:数据库、依赖与运行状态排查
---

运行自检脚本(本命令文件所在目录的 `../../scripts/doctor.mjs`),中文逐项解读输出(✅/❌):Node 版本、usage 数据库、会话状态文件、配置文件;❌ 项按脚本给出的 hint 给修复建议(常见:Node 升级到 ≥22.5、设置 ZCODE_USAGE_DB、重装插件后重开会话)。

用户想关闭每轮速率行时,告知:写入 `~/.zcode/tps-monitor.config.json` 内容 `{"tokenRateLine": false}`,重开会话生效。

用户附加要求:$ARGUMENTS
