# AI 注意力/上下文占用优化报告(v0.9.5 → v0.9.6)

日期:2026-09-30 · 基线:v0.9.5(冻结副本) · 优化后:v0.9.6

## 背景与目标

前一轮性能战役([2026-09-29-perf-optimization.md](2026-09-29-perf-optimization.md))优化的是
**运行时耗时**;本轮针对另一维度:**插件对 AI 的注意力与上下文占用**——即插件注入到模型
上下文里的所有文本面。目标是红线(安全性、稳定性、兼容性)不破的前提下,把每轮/每次会话
被插件占用的 token 压到最低,同时**收尾自测机制的行为契约一字不丢**。

## 量化方法

### 四个测量面

插件进入模型上下文的全部通道共四个:

| 面 | 进入时机 | 测量对象 |
|---|---|---|
| perTurn | 每轮 UserPromptSubmit 注入 | prompt-submit.mjs 输出的 additionalContext |
| session | 每次会话 SessionStart 注入 | session-start.mjs 输出的 additionalContext |
| tools | 会话建立时 MCP tools/list | tools/list 应答 JSON 全文 |
| skill | 会话建立时技能清单 | SKILL.md frontmatter description |

### estTokens 启发式(免责声明)

`estTokens = 中文字符数 × 1 + 其他字符数 ÷ 3.5`(零依赖启发式,与真实 tokenizer 有偏差,
趋势与相对比值可靠,绝对值仅供参考)。工具:benchmark/bench-attention.mjs。

### 百轮外推公式

```
百轮累计 = session×1 + perTurn×100 + tools×1 + skill×1
```

(tools/skill 是会话级一次性占用,不随轮数增长;列出供完整性。)

### 基线冻结

`benchmark/baseline-v0.9.5/` 为 v0.9.5 发布文件的逐字节冻结副本(含隐藏清单目录,
`diff -r` 校验一致),避免"边改边测"漂移。

## 优化轮次

### 轮 9:每轮注入面(最大头)——短路径副本 + 指令压缩

- **短路径副本**:新增 `ensureRateShortcut()`(hooks/lib.mjs),hook 首次运行时把
  `scripts/token-rate.mjs` 逐字节复制到 `~/.zcode/token-rate.mjs`,注入命令从带完整
  安装路径的 `node "C:\...\0.9.5\scripts\token-rate.mjs" --turn --current` 缩为
  `node ~/.zcode/token-rate.mjs --turn --current`(约省 60+ 字符/轮;路径还随版本变,
  每次升级都得更长)。副本与源不一致时自动刷新;复制失败则回退完整路径,功能不丢。
- **指令压缩**:注入文本重写为三行(条件+时机 → 命令 → 原样引用块+空输出守卫),
  五要素守卫全部保留:①只在调用过工具的回复统计 ②在输出总结前 ③输出行原样进「> 」
  引用块 ④不改写数字 ⑤无输出/未调用工具不显示任何统计行、不为此调用工具。
- 结果:**perTurn 228.1 → 108.7 est tok(×2.1)**。

### 轮 10:一次性面瘦身(三处)

- **session-start 提示**:只留一次性索引(命令入口 /tps、/tps-doctor + 关闭开关),
  机制细节全部交给每轮注入的【本轮统计】指令,不再两处重复讲解。
  **148.3 → 60.4 est tok(×2.46)**。注入仍为无条件(与基线行为一致)。
- **MCP 工具描述**:去掉与 SKILL.md 重复的实现细节,保留参数约束与语义关键词,
  inputSchema 不变。**154 → 124.1 est tok(×1.24)**。
- **SKILL 触发描述**:frontmatter description 只留触发关键词(速率/tok/s/TTFT/TPS/
  QPS/吞吐/接口延迟全保留),机制讲解移入正文(正文按需加载,不进系统上下文)。
  **92.6 → 47.4 est tok(×1.95)**。

## 汇总

| 面 | 基线 v0.9.5 (est tok) | v0.9.6 (est tok) | 压缩比 |
|---|---|---|---|
| perTurn(每轮) | 228.1 | 108.7 | ×2.10 |
| session(每会话) | 148.3 | 60.4 | ×2.46 |
| tools(每会话) | 154.0 | 124.1 | ×1.24 |
| skill(每会话) | 92.6 | 47.4 | ×1.95 |
| **百轮会话累计** | **23,205** | **11,102** | **×2.09** |

字符数同期:perTurn 356→173,session 314→129,tools 374→337,skill 139→71。

## 红线核验

- **机制语义不丢**:bench-attention.mjs 对当前注入文本断言五要素守卫(命令含
  `--turn --current`、引用块要求、空输出/不额外调用守卫等);test/attention.test.mjs
  共 21 项单测全绿(副本创建/刷新/回退、注入短路径形式、五守卫逐项、配置关闭时注入
  空串且不创建副本)。
- **兼容性**:配置开关 `tokenRateLine:false` 行为不变(空注入、不建副本);注入仍为
  严格 JSON 的 hookSpecificOutput;MCP 帧序/字段序/序列化结构不变(bench-mcp 归一化
  描述文本后逐字节比对);stop 输出逐字节不变。
- **无运行时回退**:run-all medium 六项基准全绿——prompt-submit ×1.036、
  session-start ×0.997(短路径副本稳态仅一次 readFileSync 比对,内容不变不写盘)、
  stop ×1.207、snapshot seq-5 ×5.02、mcp burst ×1.25、watch slow ×1.53。
- **无越权写入**:基准与单测均以沙箱 HOME/USERPROFILE 运行,真实 `~/.zcode` 仅在
  hook 实际运行时写入那一个副本文件。

## 事故与修复

- **副本命名导致 CLI 静默无输出**(已修复,commit 14382f8):初版副本命名为
  `tps-rate.mjs`,而脚本的 CLI 守卫按 `process.argv[1]` 是否以 `token-rate.mjs`
  结尾判定是否执行命令行——副本运行正常退出但什么都不打印,收尾统计会整轮丢失。
  修复:副本定名 `~/.zcode/token-rate.mjs`,并在 lib.mjs 注释中写死该约束。

## 复现

```bash
node benchmark/bench-attention.mjs   # 四面 est tok 对比 + 百轮外推
node --test                          # 21 项单测
node benchmark/run-all.mjs medium    # 运行时回归门(六基准)
```

## 结论

插件对 AI 的上下文占用压缩约一半(百轮 23.2k → 11.1k est tok,×2.09),最大头
(每轮注入)压缩 ×2.1;收尾自测的五要素行为契约、配置开关、协议结构全部保持,
运行时六基准无回退。
