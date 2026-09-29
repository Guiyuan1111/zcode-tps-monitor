# 性能优化对比报告:v0.9.0 → v0.9.1

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
| `bench-mcp.mjs` | MCP stdio server | 1×initialize + 300×tools/list 分块流水(每块 25 帧)/ 200 帧单块突发 |

- **夹具与生产同构**:发现初版无索引夹具完全不代表真实查询计划后,从真实 `~/.zcode/cli/db/db.sqlite` 的 `sqlite_master` 转录 `model_usage` 全部 40 列与 4 个二级索引(`model_usage_session_turn_idx` 等)重建夹具;固定种子伪随机,行按时间升序,`sess_cur` 占 60%,最新一轮含 3 段 main_turn + 1 段 sub(覆盖 scope 过滤路径)。
- **对比对象**:`benchmark/baseline-v0.9.0/`(优化前冻结副本)vs `plugins/zcode-tps-monitor/`(当前代码),同一夹具、同进程/交错执行。
- **计时纪律**:进程内基准预热后整批计时、3 轮取最小、正反双序消除顺序偏置;子进程基准 A B B A 交错、取中位数。
- **红线内建校验**:每项基准在测速前先做行为等价断言(返回值深度相等 / stdout 逐字节相等 / MCP 响应数与 initialize 应答一致),**不等价即失败**。全部轮次中该断言始终通过。

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

## 3. 复合总表(全部基准,优化前 → 优化后)

### medium(20k 行,约等于重度使用一天的真实库规模)

| 基准·场景 | 前 | 后 | 加速比 |
|---|---|---|---|
| 查询层 queryTurn(显式会话) | 39.3ms | 29.3ms | ×1.34 |
| 查询层 queryTurn(--current 路径) | 42.1ms | 28.5ms | ×1.48 |
| 查询层 queryTurn(自动解析) | 43.2ms | 32.0ms | ×1.35 |
| 查询层 query(历史查询) | 25.7ms | 26.2ms | ×0.98(噪声带内,持平) |
| CLI --turn --current(端到端) | 129.2ms | 118.5ms | ×1.09 |
| 钩子 stop | 156.1ms | 146.8ms | ×1.06 |
| 采集 连续 5 次快照(长驻进程) | 1320.1ms | 263.6ms | ×5.01 |
| 采集 冷启动单次 | 266.8ms | 266.7ms | ×1.00 |
| MCP chunked 300 请求 | 63.2ms | 54.9ms | ×1.15 |

### large(100k 行,长期使用规模)

| 基准·场景 | 前 | 后 | 加速比 |
|---|---|---|---|
| 查询层 queryTurn(显式会话) | 182.1ms | 128.1ms | ×1.42 |
| 查询层 queryTurn(--current 路径) | 190.0ms | 146.9ms | ×1.29 |
| 查询层 queryTurn(自动解析) | 197.8ms | 140.8ms | ×1.40 |
| 查询层 query(历史查询) | 102.6ms | 108.7ms | ×0.94(噪声带内,持平) |
| CLI --turn --current --json(端到端) | 256.1ms | 215.1ms | ×1.19 |
| CLI --turn --current(文本行) | 274.1ms | 235.2ms | ×1.17 |
| 钩子 stop | 286.9ms | 246.3ms | ×1.17 |
| MCP chunked 300 请求 | 68.6ms | 50.9ms | ×1.35 |

注:①本批总测与报告撰写并行执行,机器负载高于轮次独占运行,query()/钩子等中性场景的 ±10% 波动属噪声带(同配置多次运行见 ×0.89~×1.09 漂移),结论取方向一致的轮次数据;②用户体感最直接的「收尾自测」路径(模型每轮回复末尾运行一次的命令)= CLI --turn --current,large 库上 274→235ms,加上等待侧的 Stop 钩子 ×1.17;③长驻 MCP 进程的快照类工具收益最大(×5)。

## 4. 红线核验

- **兼容性**:五项基准的全部行为等价断言通过(返回值深度相等/输出逐字节一致);`node --test` 14/14 全绿(含新增的回退 scope 单测);CLI 输出格式、钩子 JSON 契约、MCP 帧格式逐字节不变。
- **安全性**:usage 库仍只读打开;不触碰用户数据;无新依赖(零依赖约束保持)。
- **稳定性**:不引入常驻进程/缓存跨进程状态;旧库(无 turn_id 列/无索引)路径经单测与设计审查保持优雅降级;Windows/macOS/Linux 通用(CI 三平台 × Node 22/24 复验)。

## 5. 复现

```bash
node benchmark/fixture-gen.mjs        # 生成同构夹具(真实 schema+索引)
node benchmark/run-all.mjs            # 全量基准 + Markdown 汇总
BENCH_SIZE=large node benchmark/run-all.mjs
```
