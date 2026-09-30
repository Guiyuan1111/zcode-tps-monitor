# AI 注意力/上下文占用优化报告·第二轮(v0.9.7 → v0.9.8)

日期:2026-09-30 · 基线:v0.9.7(冻结副本) · 优化后:v0.9.8
上一轮报告:[2026-09-30-attention-optimization.md](2026-09-30-attention-optimization.md)(v0.9.5→v0.9.6,轮 9-10)

## 背景与目标

延续上一轮注意力战役:红线(安全性、稳定性、兼容性)不破的前提下,继续压缩插件注入
模型上下文的全部文本面。本轮新增两个测量面(斜杠命令文件、SKILL 正文——按需加载面),
并从三个彼此独立的优化点出发完成三轮:每轮注入命令、一次性面、按需面。

## 量化方法

- 工具:`benchmark/bench-attention.mjs`(零依赖 estTokens 启发式:CJK 字符 ×1 + 其余 ÷3.5,
  相对比值可靠、绝对值仅供参考)。
- 基线:`benchmark/baseline-v0.9.7/` 为 v0.9.7 插件发布文件逐字节冻结副本(`diff -r` 校验一致);
  上一轮的 `baseline-v0.9.5/` 保留为历史基线。
- 测量面:常驻四面(perTurn/session/tools/skill,百轮外推 = perTurn×100 + 其余三项)+
  按需两面(commands/skillBody,用户调用命令或触发技能时才展开,不参与外推)。

## 优化轮次

### 轮 11:每轮注入——命令形态与措辞压缩(常驻最大头)

注入命令四段全部缩短:

| 成分 | 0.9.7 | 0.9.8 | 说明 |
|---|---|---|---|
| 会话环境变量 | `ZCODE_SESSION_ID="(36 字符)"` | `ZSID="(36 字符)"` | 脚本新增等价短别名,读取链 `ZCODE_SESSION_ID‖CLAUDE_SESSION_ID‖ZSID` 不变 |
| 脚本路径 | `node ~/.zcode/token-rate.mjs` | `node ~/.zcode/tr.mjs` | 短路径副本改名;升级时自动清理旧名副本 |
| 统计旗标 | `--turn --current` | `-c` | 组合短旗标,语义逐项等价;长旗标保留 |
| 指令措辞 | 三行 | 三行 | 去「在输出/把/任何」类冗词,五要素守卫语义不变 |

- **CLI 守卫改造**:由「`argv[1]` 以 `token-rate.mjs` 结尾」改为**基名白名单**
  (`token-rate.mjs` / `tr.mjs`)——与路径风格、大小写无关,消除 0.9.6 事故同类
  隐患(改名即静默无输出的耦合,现为显式白名单并在 `lib.mjs` 注释固化)。
- 结果:**perTurn 108.7 → 91.9 est tok(×1.18)**;命令行 101→68 ASCII 字符
  (会话 ID 的 36 字符为多窗口正确性所必需,不可再省)。

### 轮 12:一次性面——session-start 提示与 MCP 描述

- session-start 提示去冗余限定词(「已就绪/每轮注入的/命令/注入」),机制讲解仍全权
  交给每轮【本轮统计】指令:**60.4 → 50.1 est tok(×1.21)**。
- MCP 描述:tps_snapshot 去「本机/无需参数」、tps_watch 句式收紧、seconds 参数
  description 值缩为「秒数」(**键保留**——bench-mcp 归一化逐字节比对要求两代
  inputSchema 结构一致):**124.1 → 113.1 est tok(×1.10)**。
- SKILL frontmatter 触发描述**有意不动**(47.4 est tok):触发关键词(速率/tok/s/
  TTFT/TPS/QPS/吞吐/接口延迟)是技能召回的依据,再省 ~6 tok 换触发可靠性下降不划算。

### 轮 13:按需面——命令文件与 SKILL 正文(新增测量)

- bench-attention 扩展 `commands`(tps.md + tps-doctor.md 全文)与 `skillBody`
  (SKILL.md frontmatter 之后正文)两个测量面,附 `$ARGUMENTS` 占位与
  【本轮统计】标签引用守卫断言。
- 命令文件执行步骤合并、展示要求收拢(行为语义全保留):
  **618.6 → 488.0 est tok(×1.27)**。
- SKILL 正文小幅收紧(【本轮统计】标签、metrics_url 提示、注明模型名等约束全保留):
  **433.3 → 414.7 est tok(×1.04)**。

## 汇总

### 常驻面(百轮外推口径)

| 面 | 基线 v0.9.7 (est tok) | v0.9.8 (est tok) | 压缩比 |
|---|---|---|---|
| perTurn(每轮) | 108.7 | 91.9 | ×1.18 |
| session(每会话) | 60.4 | 50.1 | ×1.21 |
| tools(每会话) | 124.1 | 113.1 | ×1.10 |
| skill(每会话) | 47.4 | 47.4 | ×1.00(有意保留) |
| **百轮累计** | **11,102** | **9,401** | **×1.18** |

字符数同期:perTurn 173→134,session 129→118,tools 337→326,skill 71→71。

### 按需面(调用时展开,单次)

| 面 | 基线 v0.9.7 (est tok) | v0.9.8 (est tok) | 压缩比 |
|---|---|---|---|
| commands(两个命令文件全文) | 618.6 | 488.0 | ×1.27 |
| skillBody(SKILL 正文) | 433.3 | 414.7 | ×1.04 |

两轮战役累计(v0.9.5 → v0.9.8):百轮常驻面 23,205 → 9,401 est tok(**×2.47**)。

## 红线核验

- **机制语义不丢**:收尾自测五要素守卫(①调用过工具才统计 ②总结前时机 ③命令
  ④原样引用块+不改写数字+不追加内容 ⑤无输出/未调用不显示、不为此调用工具)
  在新措辞中逐项保留,由 bench-attention 语义断言与 test/attention.test.mjs 锁定;
  `--current` 防串轮守卫、`ZCODE_SESSION_ID` 内联锁定多窗口的机制不变。
- **兼容性**:长旗标 `--turn --current`、`--json`、旧环境名 `ZCODE_SESSION_ID`/
  `CLAUDE_SESSION_ID` 全部保留(全部基准继续用长旗标跑通即证);MCP 帧序/字段序/
  inputSchema 结构不变(bench-mcp 归一化描述后逐字节比对通过);stop 输出逐字节不变;
  `tokenRateLine:false` 行为不变(空注入、不建副本)。
- **无运行时回退**:`run-all` 六基准全绿——cli ×1.20、prompt-submit ×0.996
  (噪声带内)、session-start ×1.023、stop ×1.192、snapshot seq-5 ×5.01、
  mcp ×1.07-1.09、watch slow ×1.54。
- **无越权写入**:基准与单测以沙箱 HOME 运行;hook 运行时对真实 `~/.zcode` 的
  写入仅 tr.mjs 副本本身,旧名副本清理为一次性动作(仅在副本(重)写入分支内)。
- **安全性**:usage 库仍只读;零依赖约束保持。

## 复现

```bash
node benchmark/bench-attention.mjs   # 六面 est tok 对比 + 百轮外推 + 语义守卫
node --test                          # 21 项单测
node benchmark/run-all.mjs           # 运行时回归门(六基准,v0.9.0 冻结基线)
```

## 结论

第二轮注意力战役完成三轮独立优化:每轮注入 ×1.18、一次性面 ×1.10-×1.21、
按需面 ×1.04-×1.27;百轮常驻面累计 11,102→9,401 est tok(×1.18),两轮战役
累计较 v0.9.5 压缩 ×2.47。五要素行为契约、协议结构、配置开关全部保持,
运行时六基准无回退。
