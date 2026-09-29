# zcode-tps-monitor 代码分析报告

**分析时间**：2026-09-29_164007
**分析范围**：`D:\Guiyuan1111\GitHub\zcode-tps-monitor`（仓库根 = 本地插件市场 + 插件本体）
**分析模式**：完整分析（小项目，30 个文件全部读取，无采样）
**代码规模**：11 个 JS/MJS 文件（约 1,538 行）+ 1 个 PowerShell 脚本（225 行）+ 1 个原生 HTML 大屏（269 行）+ 13 个 Markdown/JSON 配置与文档
**技术栈**：Node.js ≥ 22.5（ESM、内置 `node:sqlite`、内置 `http`/`fetch`），**零第三方运行时依赖**；PowerShell/WPF（Windows 悬浮条）；原生 HTML/CSS/JS（大屏）
**版本**：v0.8.3（`plugins/zcode-tps-monitor/.zcode-plugin/plugin.json:3`）

## 项目快照

- **项目名称**：zcode-tps-monitor（市场名 `tps-local-marketplace`，`marketplace.json:2`）
- **一句话定位**：ZCode 会话级 Token 输出速率监控插件——读取 ZCode 自身的 usage 数据库计算真实 tok/s，在每条调用了工具的回复末尾由模型收尾自测并附上「本问」统计行；另提供斜杠命令、MCP 工具、实时大屏、Windows 悬浮条与可选的业务 TPS 监控。
- **分支策略**：单 `main` 分支，直推式开发（无 develop/PR 流）
- **贡献者**：1 人（shy3130，23 个提交）
- **CI/CD**：GitHub Actions（Node 22/24 × Ubuntu/Windows/macOS 矩阵，仅 `node --test`）
- **测试**：13 个 `node --test` 单元测试（临时 SQLite 夹具库），覆盖核心统计逻辑

## 报告目录

| 报告 | 内容概要 |
|------|---------|
| [项目架构](01-architecture.md) | 双层仓库结构（市场+插件）、5 类插件表面（钩子/命令/技能/MCP/大屏）、两个共享核心库、函数级调用链 |
| [运行原理](02-operation-principles.md) | 「收尾自测」全链路时序、`model_usage` 表结构与速率算法、`--current` 守卫、跨进程状态文件、错误处理链 |
| [工作流分析](03-workflow.md) | CI 矩阵、版本发布流程（4 处版本号同步）、核心业务决策树、大屏生命周期 |
| [AI 替代方案](04-ai-substitution.md) | 6 个开发/维护工作流的 AI 替代评估、ROI 矩阵、改造路线图 |
| [Skill Blueprint 索引](blueprints/index.md) | 4 个可 AI 替代组件的完整 Skill 设计规格 |

## 核心发现

1. **「收尾自测」是全插件的中枢机制**：`UserPromptSubmit` 钩子只负责下达指令（注入「本问统计指令」），真正的「本问」速率由模型在回复收尾时运行 `token-rate.mjs --turn --current` 自测（`hooks/prompt-submit.mjs:35-41`）。这绕开了「提问瞬间本轮尚未发生」的固有滞后，且 `--current` 守卫（`scripts/token-rate.mjs:187-195`）在结构上杜绝了把上一轮数据冒充本问。
2. **单一数据源 + 只读访问**：所有 Token 速率均来自 `~/.zcode/cli/db/db.sqlite` 的 `model_usage` 表，全部以 `readOnly: true` 打开（`token-rate.mjs:51`），WAL 模式下不影响运行中的客户端——「真实数据、非估算」是插件的立身之本。
3. **跨进程协调靠三个家目录文件**：状态文件 `tps-monitor.last-session.json`（会话跟随 + 提问时间戳）、配置文件 `tps-monitor.config.json`（注入开关）、PID 文件 `tps-monitor.dashboard.pid`（大屏探活），分别由钩子/用户/大屏写入，doctor 统一巡检。
4. **零依赖是刻意约束**：MCP stdio 协议（`mcp/tps-server.mjs:119-150`）、PNG 编码（`assets/generate-icon.mjs:152-183`）、大屏前端全部手写实现，无 package.json、无 node_modules、无构建步骤——代价是部分底层代码（帧解析、CRC32）需人工维护。
5. **历史上最大的坑是「文案口径分裂」而非代码**：v0.8.3 整版（`CHANGELOG.md:3-20`）都在修复各表面（欢迎语/SKILL/README/清单描述）对同一机制的描述不一致，导致模型收到矛盾指令。这提示「指令文案一致性」是本项目最值得 AI 辅助审计的环节（见 [blueprints/03](blueprints/03-instruction-alignment-auditor.md)）。

## 关键建议

1. **立即**：把「版本号同步」（marketplace.json + 两个 plugin.json + CHANGELOG，共 4 处）与「发布说明撰写」固化为 AI 工作流（见 blueprints/01、02），这是每次发版必做的机械劳动。
2. **短期**：为 `collect-core.mjs` 与 MCP 帧解析补测试——当前 13 个测试全部集中在 `token-rate.mjs`，业务 TPS 采集（demo 回退、deepFind 深度、watch 统计）与 MCP 协议层零覆盖。
3. **中期**：考虑把 `--current` 守卫与状态文件时间戳的量纲契约（纪元毫秒）写入 `doctor.mjs` 的显式校验（目前仅检查 `ts` 存在性，`doctor.mjs:96-103`），防患量纲回归（v0.8.3 测试修复中已出现过一次，`test/token-rate.test.mjs:37`）。
