# Skill Blueprint: 发布说明撰写（release-notes-writer）

> 自动生成自 codebase-analyzer
> 分析时间：2026-09-29_164007
> 源模块路径：`D:\Guiyuan1111\GitHub\zcode-tps-monitor\CHANGELOG.md`（输出目标）

---

## 1. 基本信息

| 字段 | 值 |
|------|-----|
| **推荐 Skill 名称** | `zcode-tps-monitor-release-notes` |
| **用途** | 从 git 历史生成符合项目文风的 CHANGELOG 条目与 GitHub Release 描述，可联动 gh 发布 |
| **AI 替代等级** | 🤖 完全 AI 化（人工 10 秒过目） |
| **实施优先级** | 🥇 Quick Win |
| **源文件数** | 1（输出）+ git 历史（输入） |
| **源代码行数** | CHANGELOG 现有 8 个版本条目 ~83 行 |

## 2. 触发场景与关键词

- 「写一下 0.9.0 的 CHANGELOG」
- 「发 Release」/「发布 0.9.0」
- 「总结一下这次更新」

**推荐 description 触发词（用于 SKILL.md frontmatter）：**

```yaml
description: >-
  Draft CHANGELOG entries and GitHub Release notes for zcode-tps-monitor from
  git history, matching the project's established voice. Triggered by:
  "写变更日志", "发 Release", "发布说明", "release notes", "changelog".
```

## 3. 输入输出契约

### 输入

| 输入 | 来源 | 说明 |
|------|------|------|
| 版本范围 | `git log <上一版本tag或commit>..HEAD` | 默认上一 CHANGELOG 版本对应提交 |
| 变更明细 | `git log --stat` / `git show` 按需 | 判断每条 commit 属于修复/新增/变更 |
| 文风格样 | `CHANGELOG.md` 既有 8 条 | 四段式：修复 / 新增 / 变更 / 测试 |

### 输出结构（两件交付物）

```markdown
<!-- CHANGELOG 条目（插到 "# Changelog" 之后） -->
## X.Y.Z — YYYY-MM-DD

### 修复
- **一句话主题**：行为描述（引用涉及文件/命令名，不贴大段代码）

### 新增
- ...

### 变更
- ...

### 测试（可选，仅当有测试改动）
- ...
```

GitHub Release 描述：按用户全局规范——「一个点一句话、精简专业、不强调测试过程、不写用户体验不到的内容」。Tag 用版本号（如 `v0.9.0`）。

### 文风硬约束（从 CHANGELOG.md 提炼）

| 规则 | 正例（0.8.3 条目） | 反例 |
|------|-------------------|------|
| 每条以加粗主题开头 | **SessionStart 欢迎语重写**：…… | 「我们修复了……」 |
| 说明「为什么」而非「改了什么文件」 | 「该表述会在每个会话开始时误导模型」 | 「修改了 session-start.mjs 第 30 行」 |
| 专有词保持项目口径 | 守卫、收尾自测、本问、上轮、表面 | 「检查逻辑」「提示词」（口径漂移） |
| 中文为主，代码/命令保持原文 | `--turn --current` | 翻译命令名 |

### 错误场景

| 错误 | 触发条件 | 处置 |
|------|---------|------|
| 范围为空 | HEAD 与上一版本间无提交 | 询问版本号是否已错 |
| 无法归类的 commit | 提交信息含糊（如 "wip"） | 读 diff 判断；仍不明则标「待确认」交人工 |
| 版本号缺失 | 用户未给且 CHANGELOG 无草稿 | 询问，不猜测 |

## 4. 依赖清单

| 类型 | 名称 | 用途 | 接口 |
|------|------|------|------|
| git | `log` / `show` / `diff` | 变更输入 | CLI |
| gh CLI | `release create` | 可选发布 | `gh release create vX.Y.Z --title ... --notes-file ...` |
| 内部文件 | `CHANGELOG.md` | 文风格样 + 写入目标 | Markdown |
| 内部规范 | 用户全局 AGENTS.md 的 Release 规则 | Release 描述风格 | 「一个点一句话」等 |

## 5. Skill 工作流设计

```markdown
## Workflow / Steps

### Step 1: 解析输入
确定版本号与范围（git log <prev>..HEAD --oneline）。

### Step 2: 验证输入
确认 CHANGELOG 无该版本既有条目；确认范围非空。

### Step 3: 执行业务逻辑
逐条 commit 归类（修复/新增/变更/测试），必要时 git show 读 diff；
按文风硬约束起草 CHANGELOG 条目；同一主题的多个 fix commit 合并为一条
（参照 0.8.1 期间 5 个 icon fix 在 CHANGELOG 中合并为一条的先例）。

### Step 4: 处理结果
展示草稿 → 用户确认后写入 CHANGELOG 头部；
若用户要求发布：先调 version-sync 技能同步版本号，再 gh release create。

### Step 5: 错误处理
含糊提交标「待确认」；绝不虚构用户可感知不到的内容。
```

### 建议的 Constraints

```markdown
## Constraints
- Always 通读 CHANGELOG 既有条目后再动笔（文风是硬约束）
- Always 把多个同主题 fix commit 合并为一条
- Never 在 Release 描述里写测试过程、内部返工等用户无感内容
- Never 虚构功能或夸大影响；一条 commit 说一条的事
- 发布前 Always 确认版本号四处同步（联动 version-sync）
```

## 6. 所需工具权限

| 工具 | 用途 | 必需性 |
|------|------|--------|
| `Bash(git log/show/diff)` | 读取变更历史 | 必需 |
| `Read` / `Edit` | CHANGELOG 读写 | 必需 |
| `Bash(gh release ...)` | 发布 | 可选（用户明确要求时） |

**建议 allowed-tools：** `Read Edit Bash(git log:*) Bash(git show:*) Bash(gh release:*)`

## 7. 使用示例

### ✅ Do This

```
用户：给 0.9.0 写 CHANGELOG
→ git log v0.8.3..HEAD 归类出 2 修复 1 新增
→ 草稿：
  ## 0.9.0 — 2026-09-30
  ### 新增
  - **collect-core 测试**：补齐 demo 降级与 deepFind 边界用例……
→ 用户确认后写入
```

### ❌ Not This

```
→ 「本次更新经过大量测试，修复了若干问题，稳定性显著提升」（❌ 空泛、
  强调测试、无主题句，三条文风规则全违反）
```

## 8. 参考材料

- 源文件：`CHANGELOG.md`（8 个版本条目即文风训练样例）
- 用户全局规范：AGENTS.md「GitHub 与发布」节
- 历史参照：v0.8.3 条目（`CHANGELOG.md:3-20`）是最完整的四段式样例
