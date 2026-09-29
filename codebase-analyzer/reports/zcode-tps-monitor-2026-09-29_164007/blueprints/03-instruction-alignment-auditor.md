# Skill Blueprint: 指令文案一致性审计（instruction-alignment-auditor）

> 自动生成自 codebase-analyzer
> 分析时间：2026-09-29_164007
> 源模块路径：`D:\Guiyuan1111\GitHub\zcode-tps-monitor\plugins\zcode-tps-monitor\hooks\`、`skills\`、两份 README

---

## 1. 基本信息

| 字段 | 值 |
|------|-----|
| **推荐 Skill 名称** | `zcode-tps-monitor-copy-audit` |
| **用途** | 审计全部「指令表面」对收尾自测机制的描述与机制真源的一致性，拦截 v0.8.3 级别的文案漂移 |
| **AI 替代等级** | 🧑‍💻 AI 辅助（AI 找分歧，人工裁对错） |
| **实施优先级** | 🥈 Strategic（本项目特有价值最高） |
| **源文件数** | 6+ |
| **源代码行数** | 涉及文案 ~150 行 |

## 2. 触发场景与关键词

- 改动了 hooks / SKILL.md / 任一 README 之后：「跑一下文案审计」
- 发版前例行：「发版前检查」
- 用户反馈「模型行为不对」（如又把上轮行贴出来）：「审计指令一致性」

**推荐 description 触发词（用于 SKILL.md frontmatter）：**

```yaml
description: >-
  Audit all instruction surfaces (hooks, SKILL.md, READMEs) of zcode-tps-monitor
  against the canonical mechanism description; report wording drift before
  release. Triggered by: "文案审计", "指令一致性", "口径检查",
  "copy audit", "发版前检查".
```

## 3. 输入输出契约

### 审计对象清单（表面 → 代码位置）

| # | 表面 | 位置 | 审计要点 |
|---|------|------|---------|
| 1 | SessionStart 欢迎语 | `hooks/session-start.mjs:30-35` | 不得宣称「速率自动显示/无需转发」；须含收尾自测指令 |
| 2 | UserPromptSubmit 注入 | `hooks/prompt-submit.mjs:35-41` | 【本轮统计指令】五要素完整（见下）；【内部背景·勿展示】前缀在位 |
| 3 | SKILL.md 展示规范 | `skills/zcode-tps-monitor/SKILL.md:30-33` | 无「原样附上注入行」类旧要求；禁展示规则在位 |
| 4 | 仓库 README | `README.md:92-117` | 工作原理流程图与实际机制一致；Stop 钩子标注「兼容保留」 |
| 5 | 插件 README | `plugins/zcode-tps-monitor/README.md:7-18` | 能力一览表各行与现状一致 |
| 6 | CHANGELOG 最新版 | `CHANGELOG.md` 头部 | 描述的机制与代码现状无矛盾 |
| 7 | 清单描述 | 两个 `plugin.json` + `marketplace.json:11` | description 与机制一致（v0.8.3 重写过） |

### 机制真源（canonical description，审计基准）

收尾自测机制的规范表述（当前以 `README.md:94-117` 为最完整实现，建议抽出独立文件作为真源）：

1. 每条**调用了工具**的回复，收尾时模型运行 `token-rate.mjs --turn --current` 自测本问速率，输出行放入 Markdown 引用块贴回复末尾；
2. `--current` 守卫：本问尚无入库数据（纯问答轮）时脚本无输出，模型不显示任何统计行——**任何情况下不显示上一轮**；
3. 注入的上一轮行是【内部背景·勿展示】的模型上下文，非用户可见内容；
4. Stop 钩子是兼容保留（当前客户端不触发），文案不得依赖其生效。

### 「本问统计指令」五要素（prompt-submit.mjs:35-41 为基准）

```text
① 时机：所有其他工作完成之后、输出最终总结之前
② 命令：node "<绝对路径>" --turn --current（路径须与 RATE_SCRIPT 拼接结果一致）
③ 呈现：输出行原样放入 Markdown 引用块（行首加「> 」）贴回复最末尾
④ 禁改：不改写数字、不追加内容
⑤ 空输出规则：脚本无输出或未调用过工具 → 不显示任何统计行、不为此调用工具
```

### 输出模型

```typescript
interface AuditFinding {
  surface: string;        // 表面名
  file: string;           // 文件:行
  severity: "blocker" | "warn" | "info";
  quote: string;          // 原文摘录
  divergence: string;     // 与真源哪一条冲突
  suggestion?: string;    // 修改建议（供人工裁决）
}

interface AuditReport {
  findings: AuditFinding[];
  verdict: "clean" | "needs-review";  // 有 blocker 即 needs-review
}
```

### 严重级定义

| 级别 | 定义 | v0.8.3 历史实例 |
|------|------|----------------|
| blocker | 会直接导致模型行为错误（漏做/误做） | 欢迎语「无需转发」→ 模型收尾不执行自测 |
| blocker | 会让用户看到不该看的内容 | SKILL 旧要求 → 「(上轮)」行被贴给用户 |
| warn | 描述过时但暂不致行为错误 | Stop 钩子描述未标「兼容保留」 |
| info | 风格/措辞不一致 | 两 README 用词不统一 |

## 4. 依赖清单

| 类型 | 名称 | 用途 | 接口 |
|------|------|------|------|
| 内部文件 | 上表 7 表面 | 审计对象 | Read |
| 内部文件 | 机制真源（建议新建 `note/mechanism.md` 或以 README §工作原理为准） | 基准 | Read |
| git | `git diff` | 触发式审计时聚焦本次改动 | CLI |

## 5. Skill 工作流设计

```markdown
## Workflow / Steps

### Step 1: 解析输入
默认全量审计 7 表面；若刚有改动，用 git diff 缩小到受影响表面。

### Step 2: 验证输入
确认机制真源文件存在（缺失则先请用户确认以 README §工作原理为准）。

### Step 3: 执行业务逻辑
逐表面提取文案 → 对照真源四条 + 指令五要素 + 禁语清单：
禁语 = 「速率会自动显示」「无需转发」「原样附上注入的」「Stop 钩子会显示」
必语 = 守卫语义、纯问答不显示、引用块呈现
生成 AuditFinding 列表（含原文摘录与 file:line）。

### Step 4: 处理结果
输出 AuditReport；blocker 逐条给出 suggestion 但不直接改文件——
等待人工裁决后按裁决执行 Edit。

### Step 5: 错误处理
表面文件缺失/路径变动 → 报告并停止（清单本身失效需先修）。
```

### 建议的 Constraints

```markdown
## Constraints
- Always 引用原文摘录 + file:line 作为证据，禁止无据断言
- Always 区分「找分歧」（AI 职责）与「裁对错」（人工职责）
- Never 未经用户确认直接改指令类文案
- Never 把真源未覆盖的新表述直接判为 blocker（先问用户是否扩充真源）
```

## 6. 所需工具权限

| 工具 | 用途 | 必需性 |
|------|------|--------|
| `Read` | 读 7 表面 + 真源 | 必需 |
| `Grep` | 禁语/必语模式扫描 | 必需 |
| `Bash(git diff)` | 聚焦改动 | 可选 |
| `Edit` | 按人工裁决落盘 | 可选（需确认） |

**建议 allowed-tools：** `Read Grep Bash(git diff:*)`

## 7. 使用示例

### ✅ Do This

```
用户：（改完 hooks）跑一下文案审计
→ 报告：
  [blocker] skills/zcode-tps-monitor/SKILL.md:31
    摘录：「速率行会自动附上」
    冲突：真源 #1——速率行由模型收尾自测产生，非自动注入
    建议：改为「按【本轮统计指令】收尾自测」
→ 用户确认 → 应用修改 → 复扫 clean
```

### ❌ Not This

```
→ 直接把 7 个文件全改成统一模板（❌ 越权：AI 只报分歧，
  文案「正确版本」是设计决策）
→ 报告只写「文案基本一致」（❌ 无摘录无位置的空洞结论）
```

## 8. 参考材料

- 源文件：`hooks/session-start.mjs`、`hooks/prompt-submit.mjs`、`skills/zcode-tps-monitor/SKILL.md`、`README.md`、`plugins/zcode-tps-monitor/README.md`、`CHANGELOG.md`、两个 `plugin.json` + `marketplace.json`
- 历史缺陷库：`CHANGELOG.md:3-20`（v0.8.3 修复的全部口径分裂项 = 本审计的回归测试集）
- 相邻实践：`test/token-rate.test.mjs`（守卫行为的代码级测试）与本蓝图（守卫文案的语义级审计）互补
