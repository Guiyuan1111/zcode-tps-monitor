# Skill Blueprint: 版本号同步（version-sync）

> 自动生成自 codebase-analyzer
> 分析时间：2026-09-29_164007
> 源模块路径：`D:\Guiyuan1111\GitHub\zcode-tps-monitor\marketplace.json` 等 4 处

---

## 1. 基本信息

| 字段 | 值 |
|------|-----|
| **推荐 Skill 名称** | `zcode-tps-monitor-version-sync` |
| **用途** | 发版前把同一版本号统一写入 4 处清单/变更日志，并校验一致性 |
| **AI 替代等级** | 🤖 完全 AI 化 |
| **实施优先级** | 🥇 Quick Win |
| **源文件数** | 4 |
| **源代码行数** | ~40（受影响区域） |

## 2. 触发场景与关键词

- 「发版 0.9.0，同步版本号」
- 「把版本升到 X.Y.Z」
- 「检查四处版本号是否一致」
- 提交信息包含 `v\d+\.\d+\.\d+` 或用户提及 CHANGELOG 新条目时

**推荐 description 触发词（用于 SKILL.md frontmatter）：**

```yaml
description: >-
  Sync the plugin version across marketplace.json, both plugin manifests and
  CHANGELOG for zcode-tps-monitor releases. Triggered by: "版本号同步",
  "发版", "升级版本到", "version sync", "bump version".
```

## 3. 输入输出契约

### 版本号出现位置（完整清单，缺一即错）

| # | 文件 | 字段/形态 | 当前值示例 |
|---|------|----------|-----------|
| 1 | `marketplace.json` | `plugins[0].version` | `"0.8.3"`（`marketplace.json:12`） |
| 2 | `plugins/zcode-tps-monitor/.zcode-plugin/plugin.json` | `version` | `"0.8.3"`（第 3 行） |
| 3 | `plugins/zcode-tps-monitor/.claude-plugin/plugin.json` | `version` | `"0.8.3"`（第 3 行） |
| 4 | `CHANGELOG.md` | 新条目 `## X.Y.Z — YYYY-MM-DD` | `## 0.8.3 — 2026-09-25`（`CHANGELOG.md:3`） |

### 数据模型

```typescript
interface VersionSyncInput {
  version: string;        // 语义化版本，/^\d+\.\d+\.\d+$/
  date?: string;          // 默认当天，格式 YYYY-MM-DD
  changelogEntry?: string; // 可选：已有草稿；缺省时只同步版本号不动 CHANGELOG
}

interface VersionSyncReport {
  updated: Array<{ file: string; from: string; to: string }>;
  skipped: Array<{ file: string; reason: string }>;
  consistent: boolean;    // 同步后四处一致才为 true
}
```

### 错误场景

| 错误 | 触发条件 | 处置 |
|------|---------|------|
| 版本格式非法 | 不匹配 `/^\d+\.\d+\.\d+$/` | 拒绝执行并向用户确认 |
| 版本号倒退 | 新版本 ≤ git tag 最新版 | 警告并要求确认 |
| CHANGELOG 已有同版本条目 | 重复发版 | 询问是补条目还是升版本 |
| 找不到全部 4 处 | 文件被移动/重构 | 列出缺失项，禁止部分更新 |

## 4. 依赖清单

| 类型 | 名称 | 用途 | 接口 |
|------|------|------|------|
| 内部文件 | 上述 4 文件 | 读写目标 | JSON/Markdown |
| git | `git tag --list 'v*'` / `git describe` | 防倒退校验 | CLI |
| 内部模块 | `mcp/tps-server.mjs:17-22` | 运行时读 #2 的版本号做 MCP 握手——漏改 #2 的后果参照 | 只读理解 |

## 5. Skill 工作流设计

```markdown
## Workflow / Steps

### Step 1: 解析输入
从用户消息提取目标版本；无则读取未发布 CHANGELOG 草稿的 `## X.Y.Z` 推断；仍无则询问。

### Step 2: 验证输入
- 正则校验语义化版本
- `git tag --list` 校验不倒退
- 确认 4 个文件全部存在且可定位目标字段

### Step 3: 执行同步
- 三处 JSON：精确替换 `version` 字段值（保持缩进与键序不变）
- CHANGELOG：若无该版本条目且用户提供了 changelogEntry 草稿，插入
  `## <版本> — <日期>` 于文件头部（`# Changelog` 之后）

### Step 4: 处理结果
输出 VersionSyncReport（每文件 from → to）+ `git diff --stat` 摘要。

### Step 5: 错误处理
任何一步失败：不写半程状态（先全读、后校验、再写），报告缺失项。
```

### 建议的 Constraints

```markdown
## Constraints
- Always 同步全部 4 处；禁止只改部分文件
- Always 保持 JSON 文件原有缩进、键序与中文注释原样
- Never 修改 `marketplace.json` 的 icon URL 或 description 等无关字段
- Never 在版本倒退时静默继续（必须先警告）
- Never 替换 CHANGELOG 中历史版本的既有条目
```

## 6. 所需工具权限

| 工具 | 用途 | 必需性 |
|------|------|--------|
| `Read` | 读 4 个目标文件与 git tag | 必需 |
| `Edit` | 精确替换版本字段 | 必需 |
| `Bash(git tag)` | 防倒退校验 | 可选 |

**建议 allowed-tools：** `Read Edit Bash(git tag:*)`

## 7. 使用示例

### ✅ Do This

```
用户：发版 0.9.0，版本号同步一下
→ 更新 marketplace.json / 两个 plugin.json 的 version 为 "0.9.0"
→ 输出：3 处已更新（0.8.3 → 0.9.0）；CHANGELOG 未提供草稿，跳过
→ 校验：git tag 无 v0.9.0，无倒退 ✓
```

### ❌ Not This

```
用户：升到 0.9.0
→ 只改了 marketplace.json（❌ 漏两处 plugin.json，MCP 握手版本将漂移）
→ 或把版本写成 "0.9"（❌ 非语义化三段式）
```

## 8. 参考材料

- 源文件：`marketplace.json`、`plugins/zcode-tps-monitor/.zcode-plugin/plugin.json`、`plugins/zcode-tps-monitor/.claude-plugin/plugin.json`、`CHANGELOG.md`
- 行为参照：`plugins/zcode-tps-monitor/mcp/tps-server.mjs:16-22`（版本号被运行时消费的证据）
- 历史样例：commit `60c0e19`（v0.8.3 发版提交，可观察 4 处联动）
