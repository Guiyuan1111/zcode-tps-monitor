# Skill Blueprint: 测试补齐（test-backfill）

> 自动生成自 codebase-analyzer
> 分析时间：2026-09-29_164007
> 源模块路径：`D:\Guiyuan1111\GitHub\zcode-tps-monitor\plugins\zcode-tps-monitor\scripts\lib\collect-core.mjs`、`mcp\tps-server.mjs`

---

## 1. 基本信息

| 字段 | 值 |
|------|-----|
| **推荐 Skill 名称** | `zcode-tps-monitor-test-backfill` |
| **用途** | 按既有夹具范式为 collect-core / MCP 层 / 钩子生成单元测试并跑 `node --test` 自验 |
| **AI 替代等级** | 🧑‍💻 AI 辅助（期望值必须人工把关） |
| **实施优先级** | 🥈 Strategic |
| **源文件数** | 目标 5（collect-core、tps-server、3 钩子），范式样例 1 |
| **源代码行数** | ~400 行无覆盖逻辑 |

## 2. 触发场景与关键词

- 「给 collect-core 补测试」/「补齐 MCP 测试」
- 「测试覆盖率怎么样，补一下缺口」
- 修改 collect-core / tps-server 后：「给这次改动补个测试」

**推荐 description 触发词（用于 SKILL.md frontmatter）：**

```yaml
description: >-
  Backfill node:test unit tests for zcode-tps-monitor's uncovered modules
  (collect-core, MCP server, hooks) following the existing fixture style in
  test/token-rate.test.mjs. Triggered by: "补测试", "补齐测试", "测试缺口",
  "backfill tests", "add tests for".
```

## 3. 输入输出契约

### 待测目标与优先用例清单

| 目标 | 函数 | 优先用例 | 代码位置 |
|------|------|---------|---------|
| collect-core | `resolveUrl` | 空串 / `"${user_config...}"` 占位符 / 正常 URL 三态 | `collect-core.mjs:12-17` |
| collect-core | `deepFind` | 一层命中、三层命中、超深不命中、非有限数拒绝、键优先级 | `collect-core.mjs:42-52` |
| collect-core | `demoStep` | clamp 边界（tps∈[240,1560]、p50∈[6,40]、err∈[0.01,2.5]）、p95/p99 派生比例 | `collect-core.mjs:21-34` |
| collect-core | `fetchRemoteMetrics` | 假 HTTP 服务器（node:http 临时监听）返回嵌套 JSON / 非 2xx / 超时中止 | `collect-core.mjs:54-74` |
| collect-core | `snapshot`/`watch` | remote 失败回退 demo 且 mode 标注原因；watch 一次降级后整轮保持 demo；秒数 clamp 2-60 | `collect-core.mjs:114-167` |
| tps-server | 帧解析 | Content-Length 半包、粘包双帧、裸 JSON 行混用、坏 JSON 静默丢弃 | `tps-server.mjs:119-150` |
| tps-server | 协议层 | initialize 回显版本（读 plugin.json）、tools/list 两工具、未知方法 -32601、工具异常转 isError | `tps-server.mjs:55-101` |
| 钩子 | prompt-submit | config tokenRateLine=false → 空注入；正常 → 含「【内部背景·勿展示】」与「--turn --current」 | `prompt-submit.mjs:59-69` |
| 钩子 | session-start / stop | 输出是合法 JSON 且 hookEventName 正确；stop 在无本轮数据时不输出 | `session-start.mjs:37-44`、`stop.mjs:52-76` |

### 夹具范式（必须沿用 `test/token-rate.test.mjs` 已验证的模式）

```typescript
// 模块加载时序约束：路径类 env 必须在 import 被测模块之前设置
process.env.ZCODE_USAGE_DB = fixtureDb;        // test:18
process.env.TPS_MONITOR_STATE_FILE = ...;      // test:24
const mod = await import(pathToFileURL(...).href);  // 之后才导入
// HOME 隔离（doctor 类检查用）：POSIX 读 HOME，Windows 读 USERPROFILE  test:186-189
// 强制新模块实例：import 时加 "?legacy" 查询串                  test:167
```

### 输出契约

- 新增测试文件放 `test/`（`node --test` 自动发现），或并入现有文件
- 每个用例附一行注释说明期望值的**独立推导**（不是从实现抄公式）
- 全部通过 `node --test` 后才算交付

### 错误场景（测试本身的质量红线）

| 反模式 | 说明 | 把关方式 |
|--------|------|---------|
| 重实现式断言 | 期望值用与实现相同的表达式计算，测不出错 | 人工 review：期望值必须是手写常数 |
| 夹具污染 | 未重定向 HOME/状态文件，读到真实 `~/.zcode` | 检查 env 设置先于 import |
| 时序脆弱 | 依赖真实 sleep 的长等待 | 用短超时 + 注入 env（如 timeoutMs 参数） |

## 4. 依赖清单

| 类型 | 名称 | 用途 | 接口 |
|------|------|------|------|
| 内部模块 | 上述 5 目标文件 | 被测对象 | ESM 具名导出 |
| 范式样例 | `test/token-rate.test.mjs` | 夹具/时序/隔离模式 | Read 模仿 |
| node 内置 | `node:test`、`node:assert/strict`、`node:http`（假服务器）、`node:child_process`（MCP 冒烟） | 测试设施 | 零依赖约束下不许引入第三方 |
| CI | `.github/workflows/ci.yml` | 三平台回归 | push 自动 |

## 5. Skill 工作流设计

```markdown
## Workflow / Steps

### Step 1: 解析输入
确定目标模块；无指定则按上表优先级从 collect-core 开始。

### Step 2: 验证输入
读取目标模块导出签名与 test/token-rate.test.mjs 范式；
确认无需引入第三方依赖（项目零依赖是硬约束）。

### Step 3: 执行业务逻辑
按优先用例清单逐个写用例：
- 期望值手写常数并在注释中给出独立推导
- 网络/HTTP 用 node:http 起临时端口假服务器，用完即关
- MCP 冒烟参照 plugins README:70-75 的手工命令，用子进程管道自动化
- 钩子输出校验：JSON.parse 后断言 hookSpecificOutput 结构

### Step 4: 处理结果
运行 node --test 全绿后输出：新增用例数、覆盖的函数清单、
CI 将自动覆盖三平台的提示；失败则修到绿或如实报告剩余失败。

### Step 5: 错误处理
发现被测代码疑似 bug（测试合理但不过）→ 停止改测试迁就实现，
报告疑似缺陷交人工裁决。
```

### 建议的 Constraints

```markdown
## Constraints
- Always 沿用既有夹具范式（env 先于 import、HOME 隔离、临时目录）
- Always 期望值手写并注明推导，禁止从实现表达式复制
- Never 引入任何第三方测试库或 npm 包
- Never 为让测试通过而弱化断言或改被测代码语义
- Always 以 node --test 全绿作为交付门槛
```

## 6. 所需工具权限

| 工具 | 用途 | 必需性 |
|------|------|--------|
| `Read` | 读被测模块与范式样例 | 必需 |
| `Write` / `Edit` | 写测试文件 | 必需 |
| `Bash(node --test ...)` | 自验 | 必需 |

**建议 allowed-tools：** `Read Write Edit Bash(node --test:*) Bash(node:*)`

## 7. 使用示例

### ✅ Do This

```
用户：给 collect-core 补测试
→ 新增 test/collect-core.test.mjs：resolveUrl 三态、deepFind 边界 5 例、
  假服务器 fetch 3 例、snapshot 降级 2 例（mode 断言含失败原因文本）
→ node --test 全绿（含原 13 例不回归）
→ 汇报：新增 11 例，覆盖 collect-core 全部导出
```

### ❌ Not This

```
→ 期望值写 deepFind(d,KEYS) 的返回再 assertEqual 同一调用（❌ 重实现式，
  永真断言）
→ 引入 jest / vitest（❌ 破坏零依赖约束）
→ 断言超时后把 fetchRemoteMetrics 的 timeout 参数改大（❌ 弱化断言迁就实现）
```

## 8. 参考材料

- 范式样例：`test/token-rate.test.mjs`（13 例全绿，夹具时序注释详尽）
- 被测源码：`scripts/lib/collect-core.mjs`、`mcp/tps-server.mjs`、`hooks/*.mjs`
- MCP 冒烟命令原型：`plugins/zcode-tps-monitor/README.md:70-75`
- 历史教训：v0.7.0 的注入行丢失缺陷（`CHANGELOG.md:60`）正是缺钩子输出测试的后果
