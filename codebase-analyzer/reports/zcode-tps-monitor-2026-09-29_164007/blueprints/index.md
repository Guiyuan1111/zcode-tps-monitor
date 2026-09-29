# Skill Blueprint 索引

**分析时间**：2026-09-29_164007
**分析范围**：`D:\Guiyuan1111\GitHub\zcode-tps-monitor`

| # | Blueprint | 组件 | AI 等级 | 优先级 | 文件 |
|---|-----------|------|---------|--------|------|
| 1 | version-sync | 版本号同步（4 处清单/CHANGELOG） | 🤖 完全 AI 化 | 🥇 Quick Win | [blueprints/01-version-sync.md](01-version-sync.md) |
| 2 | release-notes-writer | CHANGELOG 条目 + GitHub Release 撰写 | 🤖 完全 AI 化 | 🥇 Quick Win | [blueprints/02-release-notes-writer.md](02-release-notes-writer.md) |
| 3 | instruction-alignment-auditor | 指令文案一致性审计（7 表面） | 🧑‍💻 AI 辅助 | 🥈 Strategic | [blueprints/03-instruction-alignment-auditor.md](03-instruction-alignment-auditor.md) |
| 4 | test-backfill | collect-core / MCP / 钩子测试补齐 | 🧑‍💻 AI 辅助 | 🥈 Strategic | [blueprints/04-test-backfill.md](04-test-backfill.md) |

另有两项评估结论不产出 Blueprint：

- **doctor 诊断解读（25/30，🤖）**：已在插件内实现为 `/tps-doctor` 命令（`commands/tps-doctor.md`），是本项目 AI 工作流的成功先例与设计参照（结构化 JSON + hint + 命令 prompt 三件套）。
- **指标字段映射（20/30，🧑‍💻）**：低频（配置一次），列入 Phase 3 择机处理。

## 实施路线图

### 立即实施（Quick Win）

1. **版本号同步**（[01](01-version-sync.md)）— 纯机械零风险，下次发版即可受益；消除 4 处版本漂移（MCP 握手版本读自 `.zcode-plugin/plugin.json`，漏改即漂移）。
2. **发布说明撰写**（[02](02-release-notes-writer.md)）— CHANGELOG 8 个历史条目即文风格样；可联动 `gh release create`。

### 规划实施（Strategic）

3. **指令文案一致性审计**（[03](03-instruction-alignment-auditor.md)）— 本项目历史缺陷的众数是文案口径分裂（v0.8.3 整版修复），值得优先于测试投入；v0.8.3 的修复项清单天然构成回归测试集。
4. **测试补齐**（[04](04-test-backfill.md)）— 约 400 行无覆盖逻辑（collect-core / MCP / 钩子）；沿用既有夹具范式，零依赖约束下实施。

### 逐步推进（Incremental）

5. 指标字段映射 — 用户携带自定义 JSON 样本咨询时按需生成键映射补丁（修改 `collect-core.mjs:38-40` 词表）。

---

> 每个 Blueprint 文件包含创建对应 Skill 所需的完整设计规格（触发词、接口契约、依赖清单、Workflow、Constraints、示例）。
> 使用 `skill-for-skills` 加载对应 Blueprint 文件即可生成标准 SKILL.md。
