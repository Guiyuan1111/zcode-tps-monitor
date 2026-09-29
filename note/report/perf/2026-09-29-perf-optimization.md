# 性能优化对比报告:v0.9.0 → v0.9.3

日期:2026-09-29 · 环境:Windows 10 x64 · Node v24.20.0 · 22 核
目标(用户指令):在不影响安全性、稳定性、兼容性(**红线**)的前提下优化性能;量化前后对比;多轮次、每轮一个独立优化面且做完整。

## 1. 方法论

### 1.1 基准设施(`benchmark/`)

| 基准 | 对象 | 场景 |
|---|---|---|
| `bench-token-rate.mjs` | 查询层(进程内) | queryTurn/query × 显式会话/自动解析/带 --current 守卫,medium(20k 行)/large(100k 行)夹具 |
| `bench-cli.mjs` | 收尾自测 CLI 端到端 | `node token-rate.mjs --turn --current`(含 Node 启动),--json 与文本行两种输出 |
| `bench-hooks.mjs` | 钩子进程端到端 | prompt-submit / session-start / stop 逐次 spawn |
| `bench-snapshot.mjs` | 采集层 | 冷启动单次快照 + 长驻进程连续 5 次快照(demo 模式,衡量 CPU 采样) |
| `bench-mcp.mjs` | MCP stdio server | 1×initialize + 300×tools/list 分块流水(每块 25 帧)/ 200 帧单块突发;另跑 initialize+tools/list+ping 探测,归一化版本号后逐字节比对;附 tools/list 单帧序列化微基准 |
| `bench-watch.mjs` | 采集层 watch 采样 | 进程内 fake HTTP 接口(固定 JSON)三画像:fast(~50ms)/slow(~600ms)/down(端口不通),壁钟计时 |

- **夹具与生产同构**:发现初版无索引夹具完全不代表真实查询计划后,从真实 `~/.zcode/cli/db/db.sqlite` 的 `sqlite_master` 转录 `model_usage` 全部 40 列与 4 个二级索引(`model_usage_session_turn_idx` 等)重建夹具;固定种子伪随机,行按时间升序,`sess_cur` 占 60%,最新一轮含 3 段 main_turn + 1 段 sub(覆盖 scope 过滤路径)。
- **对比对象**:`benchmark/baseline-v0.9.0/`(优化前冻结副本)vs `plugins/zcode-tps-monitor/`(当前代码),同一夹具、同进程/交错执行。
- **计时纪律**:进程内基准预热后整批计时、3 轮取最小、正反双序消除顺序偏置;子进程基准 A B B A 交错、取中位数。
- **红线内建校验**:每项基准在测速前先做行为等价断言(返回值深度相等 / stdout 逐字节相等 / MCP 三应答逐字节一致 / watch 输出逐字段全等),**不等价即失败**。全部轮次中该断言始终通过。

### 1.2 已排除的方案(红线优先)

- **不建索引/不 ANALYZE**:usage 库只读打开,绝不写入用户数据。
- **不用 `INDEXED BY` 强制索引**:旧库/异构 schema 上会直接报错,破坏兼容性。
- **不缓存钩子状态文件读取**:`--current` 守卫依赖「prompt-submit 写入 → CLI 读到」的跨进程时序,缓存会破坏正确性。
- **不常驻化/不改进程模型**:为省 Node 启动(约 95ms)引入常驻守护进程,属架构变更,违背稳定性红线。
- **不重写整体结构**:零依赖小模块结构本身已是最优形态,重写只有风险没有可测收益。

## 2. 优化轮次

### 轮 1:token-rate 查询层(commit 99fc3ed)

**分析**(逐语句剖析,large 夹具):queryTurn 旧路径 4 条语句各自全表扫描 + 临时 B-tree 排序;真实库虽有索引,但规划器把窗口/SUM/turn 行查询都引向低选择性的 `query_source_idx`(≈85% 行命中),唯 `latestTurnId` 走 `session_turn_idx`。

**改动**:
1. **turn 行改走 `(session_id, turn_id)` 索引直达**——查询条件从 `status+query_source+session_id+turn_id` 改为 `session_id+turn_id`,scope 过滤(status/query_source)移到 JS 完成,行集与 SQL 过滤严格等价;无索引的库自动退化为全表扫描,结果不变。
2. **乐观 scope**:先按 main_turn 取窗口,为空再回退全量,等价于旧版「LIMIT 1 探测 + 查询」且常规路径少一次扫描。
3. **窗口瘦身**:history 实际只消费前 `min(N, HIST)` 条,按需拉取(旧版拉 60 条用 5 条)。
4. **格式化器缓存**:`fmtNum`/时间格式化缓存 `Intl` 实例(输出经逐字节比对一致)。
5. 聚合 `Math.max(...spread)` 改循环(大轮次段数不受栈限制)。

**过程插曲**:初版把 scope 过滤条件写反(main scope 下放行了 sub 行),被新增的「无 main_turn 会话回退」单测当场捕获并修复;夹具同步补入 sub 行使基准等价断言也覆盖该分支。

**结果**(large,100k 行):

| 场景 | 前 | 后 | 加速比 |
|---|---|---|---|
| queryTurn(sid) | 286ms | 207ms | ×1.38 |
| queryTurn(sid,current)(收尾自测路径) | 299ms | 228ms | ×1.31 |
| query(sid) | 122ms | 111ms | ×1.09 |
| CLI `--turn --current`(端到端) | 320ms | 268ms | ×1.19 |

medium(20k 行)同向:queryTurn ×1.3~1.5。

### 轮 2:采集层(commit 3cefdf7)

**分析**:`snapshot()` 每次都要阻塞一个 250ms 的 CPU 采样窗;MCP server 是长驻进程,连续快照重复付出该代价。核数/总内存/平台是进程生命周期常量,却在每次快照重新查询(`os.cpus()`/`os.totalmem()` 在 Windows 上开销显著)。

**改动**:CPU% 进程内缓存(1s TTL + 在途去重,首次调用永远真实采样;监控语义上 ≤1s 陈旧可接受);静态主机信息模块级缓存。

**结果**:

| 场景 | 前 | 后 | 加速比 |
|---|---|---|---|
| 冷启动单次快照 | 266ms | 265ms | ×1.00(设计如此) |
| 长驻进程连续 5 次快照 | 1320ms | 265ms | **×4.99** |

### 轮 3:MCP stdio server(commit 5f50738)

**分析**:帧模式下每收到一个分块都对整个缓冲做 UTF-8 解码 + 行拆分探测(裸 JSON 行客户端兼容);每条响应独立 `stdout.write`(burst 时几十次系统调用)。

**改动**:见到首个 `Content-Length` 帧后不再做裸行探测(单一协议客户端行为不变);同 tick 的多条响应合并为一次写出(每条仍是独立标准帧)。

**结果**:chunked 300 请求 64.5→53.4ms(×1.21);burst ×1.0(墙钟持平,stdout 数据事件 40+→2,系统调用数大幅下降)。注:一次 burst ×0.36 的读数经隔离剖析确认是本机高负载伪影(直接测量两版本均 ≈52ms 完成),复跑 ×1.0/×0.97。

### 轮 4:钩子层测量 + 复合验证

**结论(测量)**:prompt-submit / session-start 与优化前持平(×1.0,代码未动)——它们的耗时 ~95-105ms 几乎全部是 Node 进程启动,模块内工作(状态文件写入 + JSON 输出)微秒级;v0.9.0 已把 prompt-submit 做到零数据库访问,本轮确认无进一步可优化空间(常驻化属红线排除项)。
**复合效应**:stop 钩子动态导入 token-rate,自动继承轮 1 收益:

| 场景 | 前 | 后 | 加速比 |
|---|---|---|---|
| stop 钩子(medium) | 164ms | 153ms | ×1.07 |
| stop 钩子(large) | 299ms | 256ms | ×1.17 |

### 轮 5:MCP 响应序列化(commit bc0687f)

**分析**:tools/list 是 MCP server 里唯一应答内容恒定的方法(tools 数组启动即固定),但每帧都要 `JSON.stringify` 整个对象——微基准实测 852ns/帧,客户端批量拉取工具列表时纯属重复劳动。
**改动**:启动时预序列化一份 result 常量,应答改用模板字符串拼接(67ns/帧);initialize/ping/tools/call 路径不变。
**结果**:微基准(确定性,纯 CPU)单帧序列化 852→67ns(×12.7);端到端 chunked ×1.11~×1.21、burst ×0.95~×1.12(噪声带内,不回退)。等价保障:基准新增探测断言——两变体各跑 initialize+tools/list+ping,归一化 serverInfo 版本号后**逐字节比对**全量输出,序列化改造零协议差异。

### 轮 6:watch() 采样节拍对齐(commit 6d36881)

**分析**:老 watch 每拍「等请求返回再睡 1s」,串行节拍随接口延迟线性累积——5 秒采样在 600ms 接口下要 7.1s 才出报告,且样本时刻漂移出 1s 网格。
**改动**:每秒固定节拍并发发起采样(`Promise.all` 按发起序收结果),总时长 ≈(n-1)×1s+单次耗时;失败回退语义保持「一旦失败即回退」,仅慢失败端点(挂到超时才报错)最多滞后一拍、多发出个位数并发请求,每个都有 3s 超时兜底,不影响总时长与结果结构。
**结果**(bench-watch,固定 JSON 接口):

| 画像 | 前 | 后 | 加速比 |
|---|---|---|---|
| slow(接口 600ms) | 7099ms | 4635ms | ×1.53 |
| fast(接口 50ms) | 4333ms | 4084ms | ×1.06 |
| down(端口不通) | 4027ms | 4022ms | ×1.00 |

快/慢画像输出(除 time 字段)逐字段全等,down 画像回退结构全等;新增 collect-core 单测 4 例(remote 成功/回退/纯演示/字段宽松匹配)。

## 3. 复合总表(全部基准,优化前 → 优化后;六轮全部落地后的同批复合运行)

### medium(20k 行,约等于重度使用一天的真实库规模)

| 基准·场景 | 前 | 后 | 加速比 |
|---|---|---|---|
| 查询层 queryTurn(显式会话) | 45.1ms | 34.5ms | ×1.31 |
| 查询层 queryTurn(--current 路径) | 31.0ms | 27.2ms | ×1.14 |
| 查询层 queryTurn(自动解析) | 31.4ms | 23.7ms | ×1.33 |
| 查询层 query(历史查询) | 18.5ms | 18.4ms | ×1.01(持平) |
| CLI --turn --current --json | 119.4ms | 111.6ms | ×1.07 |
| CLI --turn --current(文本行) | 132.7ms | 125.2ms | ×1.06 |
| 钩子 stop | 140.4ms | 135.7ms | ×1.04 |
| 采集 连续 5 次快照(长驻进程) | 1284.4ms | 263.7ms | ×4.87 |
| 采集 冷启动单次 | 258.9ms | 258.6ms | ×1.00 |
| MCP chunked 300 请求 | 58.4ms | 49.5ms | ×1.18 |
| MCP burst 200 帧单块 | 63.6ms | 65.2ms | ×0.98(噪声带内) |
| watch 5s·接口 600ms | 7099ms | 4635ms | ×1.53 |
| watch 5s·接口 50ms | 4333ms | 4084ms | ×1.06 |

### large(100k 行,长期使用规模)

| 基准·场景 | 前 | 后 | 加速比 |
|---|---|---|---|
| 查询层 queryTurn(显式会话) | 199.1ms | 119.4ms | ×1.67 |
| 查询层 queryTurn(--current 路径) | 185.4ms | 128.5ms | ×1.44 |
| 查询层 queryTurn(自动解析) | 172.7ms | 134.1ms | ×1.29 |
| 查询层 query(历史查询) | 117.3ms | 91.1ms | ×1.29 |
| CLI --turn --current --json | 263.5ms | 242.4ms | ×1.09 |
| CLI --turn --current(文本行) | 307.7ms | 265.6ms | ×1.16 |
| 钩子 stop | 274.3ms | 239.5ms | ×1.15 |
| 采集 连续 5 次快照(长驻进程) | 1312.5ms | 255.1ms | ×5.15 |
| 采集 冷启动单次 | 261.9ms | 257.3ms | ×1.02 |
| MCP chunked 300 请求 | 72.0ms | 59.5ms | ×1.21 |
| MCP burst 200 帧单块 | 65.4ms | 61.0ms | ×1.07 |
| watch 5s·接口 600ms | 7100ms | 4636ms | ×1.53 |
| watch 5s·接口 50ms | 4391ms | 4092ms | ×1.07 |

注:①query()/钩子等场景跨批次存在 ±10% 量级漂移(基线进程受磁盘缓存/机器负载影响),本轮 large 的 query() 读数偏快方向,轮 1 独占复跑时该场景为持平(×1.0±0.1),结论以多批次方向一致者为准;②用户体感最直接的「收尾自测」路径(模型每轮回复末尾运行一次的命令)= CLI --turn --current,large 库上 308→266ms,加上等待侧的 Stop 钩子 ×1.15;③长驻 MCP 进程的快照类工具收益最大(×5);④MCP tools/list 单帧序列化微基准 852→67ns(×12.7,确定性)。

## 4. 红线核验

- **兼容性**:六项基准的全部行为等价断言通过(返回值深度相等/CLI 与钩子 stdout 逐字节相等/MCP 三应答逐字节一致/watch 输出逐字段全等);`node --test` 18/18 全绿(含回退 scope 单测 1 例与 collect-core 采样单测 4 例);CLI 输出格式、钩子 JSON 契约、MCP 帧格式逐字节不变。
- **安全性**:usage 库仍只读打开;不触碰用户数据;无新依赖(零依赖约束保持)。
- **稳定性**:不引入常驻进程/缓存跨进程状态;旧库(无 turn_id 列/无索引)路径经单测与设计审查保持优雅降级;watch 失败回退语义保持,仅节拍对齐(慢失败端点回退最多滞后一拍,已在代码注释与基准 down 画像中固化);Windows/macOS/Linux 通用(CI 三平台 × Node 22/24 复验)。

## 5. 复现

```bash
node benchmark/fixture-gen.mjs        # 生成同构夹具(真实 schema+索引)
node benchmark/run-all.mjs            # 全量基准 + Markdown 汇总
BENCH_SIZE=large node benchmark/run-all.mjs
```
