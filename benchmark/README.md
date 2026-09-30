# benchmark/ — 性能基准与优化对比

量化 `zcode-tps-monitor` 各性能敏感面的优化前后对比。全部零依赖(Node 内置模块),Windows/macOS/Linux 通用。

## 目录结构

```
benchmark/
├── baseline-v0.9.0/     # 运行时基线(v0.9.0 冻结副本)——仅供对比,禁止修改
├── baseline-v0.9.5/     # 注意力基线(v0.9.5 冻结副本,0.9.6 报告用,历史保留)——仅供对比,禁止修改
├── baseline-v0.9.7/     # 注意力基线(v0.9.7 冻结副本,含隐藏清单目录)——仅供对比,禁止修改
├── fixture-gen.mjs      # 生成模拟 ZCode usage 库的夹具(固定种子,可复现)
├── bench-token-rate.mjs # 基准1:token-rate 查询层(进程内;含只读哈希断言)
├── bench-cli.mjs        # 基准2:收尾自测 CLI 端到端(含进程启动)
├── bench-hooks.mjs      # 基准3:钩子进程端到端(prompt-submit/session-start/stop)
├── bench-snapshot.mjs   # 基准4:采集层 snapshot()(demo 模式,CPU 采样开销)
├── bench-mcp.mjs        # 基准5:MCP stdio server 帧解析与分发吞吐(+序列化微基准+逐字节探测)
├── bench-watch.mjs      # 基准6:watch() 采样节拍(fake HTTP 接口 fast/slow/down 三画像)
├── bench-attention.mjs  # 基准7:AI 上下文占用(四常驻+两按需面 est tok 对比 + 语义守卫断言)
├── run-all.mjs          # 一键全量(运行时六基准)+ Markdown 汇总
└── TEMP/                # 运行时产物(夹具库/结果 JSON),已 gitignore
```

## 用法

```bash
node benchmark/run-all.mjs                  # 全量(medium 夹具)
BENCH_SIZE=large node benchmark/run-all.mjs # 大夹具(100k 行)
BENCH_SKIP=mcp,hooks node benchmark/run-all.mjs
node benchmark/bench-token-rate.mjs small   # 单跑
BENCH_ITERS=500 node benchmark/bench-token-rate.mjs
node benchmark/bench-attention.mjs          # 注意力占用(独立于 run-all)
```

## 方法论

- **夹具**:固定种子的伪随机生成 3 个会话 ×(small 2k / medium 20k / large 100k)行 `model_usage`,85% main_turn,每 3 行一个 turn_id;`sess_cur` 末尾有贴近"现在"的最新一轮,配套 `state.json`(ts=now-60s)使 `--current` 守卫路径可测。两个变体使用同一夹具文件。
- **对比对象**:运行时基准对 `baseline-v0.9.0/`,注意力基准(bench-attention)对 `baseline-v0.9.7/`(注入文本自 v0.9.6 起有意精简,须以最近文本面为基线;v0.9.5 副本为 0.9.6 报告的历史基线,保留)。子进程类基准交错执行(A B B A)消除系统热漂移,取中位数。
- **注意力基准**(bench-attention):以 estTokens 启发式(中文字符×1+其他÷3.5,与真实 tokenizer 有偏差、相对比值可靠)量化六个注入面——常驻四面(每轮注入/会话提示/MCP tools/list/SKILL 描述,给出百轮会话外推)+ 按需两面(斜杠命令文件/SKILL 正文,调用时展开);同时对当前注入断言收尾自测五要素语义守卫(命令、引用块、空输出守卫等)。
- **红线内建校验**:每个基准在测速前先做行为等价断言(返回值深度相等 / stdout 一致 / watch 输出逐字段全等);基准 1 另有只读证明——全程跑完后夹具库文件 SHA-256 哈希不变且目录内无 `-wal`/`-shm` 旁文件(连接级 PRAGMA 等一切改动均不得写入)。文本面(注入指令/工具描述)是注意力优化对象,等价口径为"结构逐字节 + 文本语义":bench-hooks 的 stop 逐字节比对、注入钩子校验严格 JSON 结构与注入非空;bench-mcp 归一化描述文本与随之变化的帧长后逐字节比对(帧序/字段序不得改变)。**等价性/只读性不通过时基准直接失败**,确保优化不改变行为且零写入(安全与兼容性红线)。
- **输出**:每台基准机打印一行 `##RESULT## {json}`,`run-all.mjs` 汇总为 Markdown 并落盘 `TEMP/results.json`,对比报告见 `note/report/perf/`。

## 已知边界

- 夹具复刻真实 `~/.zcode/cli/db/db.sqlite` 的 `model_usage` 全 40 列与 4 个二级索引(从 `sqlite_master` 转录),查询计划与生产同构;large 档用于观察"扫描次数 × 表规模"的放大效应。
- snapshot 基准使用 demo 模式(无网络依赖),衡量的是本机 CPU 采样开销;watch 基准用进程内 fake HTTP 服务把网络耗时固定化(50ms/600ms 画像),不依赖外网。
- 进程内基准(基准1/4/6)在同一 Node 进程先后加载两个模块副本,共享同一环境变量与夹具文件,对比公平。
