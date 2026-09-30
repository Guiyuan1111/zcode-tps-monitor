# zcode-tps-monitor

项目介绍、安装与使用说明见[仓库首页 README](../../README.md)。本文件面向插件内部结构与开发测试。

## 能力一览

| 形态 | 入口 | 说明 |
|---|---|---|
| 本问统计 | `hooks/prompt-submit.mjs` + `scripts/token-rate.mjs` | 每轮注入「本轮统计」指令:模型在回复收尾时运行 `~/.zcode/tr.mjs -c`(短路径副本,= `--turn --current`),把本问即时速率行附在回复末尾;命令行内联 `ZSID`(会话 ID 短别名,多窗口锁定本会话),`--current` 守卫保证绝不显示上一轮。hook 首次运行会在 `~/.zcode/` 维护一份与插件脚本逐字节一致的短路径副本 `tr.mjs`(文件名不可改——脚本 CLI 守卫按基名白名单判定),使注入命令短且不随安装路径/版本变长;复制失败自动回退完整路径。`{"tokenRateLine": false}` 可整体关闭 |
| 会话提示 | `hooks/session-start.mjs` | 会话启动/恢复/压缩时记录会话 ID,并注入一行使用索引(命令入口+关闭开关;机制细节由每轮注入的指令携带) |
| 自检 | `/tps-doctor`(`scripts/doctor.mjs`) | 检查 Node 版本、数据库与表结构、状态/配置文件;`--json` 可编程消费 |
| 斜杠命令 | `/zcode-tps-monitor:tps` | 即时快照;`/zcode-tps-monitor:tps 10` 采样观察 10 秒 |
| 技能 | `zcode-tps-monitor` | 用户询问速率/TPS 相关问题时自动触发 |
| MCP 工具 | `tps_snapshot` / `tps_watch` | stdio MCP server(`mcp/tps-server.mjs`),供 agent 程序化取数 |
| Stop 钩子(兼容保留) | `hooks/stop.mjs` | 当前客户端版本不触发 Stop 事件;未来支持后可自动在回复结束瞬间显示本问速率 |

## 数据源

### Token 速率(真实,默认开启)

由钩子读取 ZCode usage 数据库(`model_usage` 表)计算,可手动验证:

```bash
node scripts/token-rate.mjs                  # 最近一次请求 + 会话统计
node scripts/token-rate.mjs --turn --current # 最新一问(本问)即时统计,本问无数据时不输出
node scripts/token-rate.mjs -c               # 同上(注入命令用的组合短旗标)
node scripts/token-rate.mjs --json           # JSON
```

可设置 `ZCODE_SESSION_ID`(或 `ZSID`)环境变量只统计当前会话(每轮注入命令已自动内联 `ZSID`)。

数据库路径默认按用户主目录解析(`~/.zcode/cli/db/db.sqlite`,Windows 同理),可用 `ZCODE_USAGE_DB` 环境变量覆盖;以只读方式打开 WAL 库,不影响运行中的客户端。

### 业务 TPS(demo / remote)

- **demo(默认)**:内置模拟数据(随机游走,数值连续逼真),开箱即可看到效果。
- **remote(真实)**:在 **设置 → 插件管理 → zcode-tps-monitor** 中配置 `metrics_url`,
  指向任何返回 JSON 的指标接口。字段兼容(支持最多三层嵌套):
  - 吞吐:`tps` / `qps` / `throughput` / `transactionsPerSecond`
  - 延迟:`p50` / `p95` / `p99`(或 `latency_p50` 等)
  - 错误率:`error_rate` / `errorRate` / `err_rate`

  例:`{"data":{"tps":1240,"p50":11,"p95":28,"p99":46,"error_rate":0.05}}`

## 开发与测试

```bash
# 自检
node scripts/doctor.mjs             # 人类可读(❌ 项给出修复建议)
node scripts/doctor.mjs --json      # JSON,失败时退出码 1

# 业务 TPS 采集 CLI
node scripts/collect.mjs            # 人类可读快照
node scripts/collect.mjs --json     # JSON
node scripts/collect.mjs --watch 5  # 采样 5 秒

# 单元测试(仓库根目录;临时库夹具,不读真实数据)
node --test

# 性能基准(仓库根目录 benchmark/;夹具与真实 usage 库同构,
# 内建"优化前冻结副本 vs 当前代码"的行为等价断言与只读哈希证明)
node benchmark/run-all.mjs
```

性能优化的方法论、逐语句剖析与前后对比报告见仓库根 `benchmark/README.md` 与 `note/report/perf/`。

```bash
# MCP server 冒烟
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node mcp/tps-server.mjs
```
## 目录结构

```
zcode-tps-monitor/
├── .zcode-plugin/plugin.json   # 插件清单(name / userConfig)
├── .claude-plugin/plugin.json  # 兼容清单
├── .mcp.json                   # MCP server 注册(${ZCODE_PLUGIN_ROOT})
├── commands/tps.md             # /zcode-tps-monitor:tps
├── commands/tps-doctor.md      # /zcode-tps-monitor:tps-doctor
├── skills/zcode-tps-monitor/SKILL.md  # 自动触发技能
├── hooks/hooks.json            # 钩子注册(SessionStart + UserPromptSubmit + Stop)
├── hooks/lib.mjs               # 钩子共用:状态文件写入 + 配置读取
├── hooks/session-start.mjs     # 会话启动:记录会话 ID + 使用提示
├── hooks/prompt-submit.mjs     # 每轮:记录提问时刻 + 注入本轮统计指令(内联 ZSID;维护 ~/.zcode/tr.mjs 短路径副本)
├── hooks/stop.mjs              # 兼容保留:当前客户端不触发 Stop 事件
├── mcp/tps-server.mjs          # stdio MCP server
├── scripts/
│   ├── token-rate.mjs          # token 速率 CLI(人类可读 / --json)
│   ├── collect.mjs             # 业务 TPS CLI 入口
│   ├── doctor.mjs              # 自检(人类可读 / --json)
│   └── lib/collect-core.mjs    # 采集核心(CLI/MCP 共用,零依赖)
└── docs/
    └── effect-token-rate.png   # 效果截图
```

## 修改后生效

在 **设置 → 插件管理** 中重新安装/刷新插件,并重开会话使钩子重新注册。要求 Node ≥ 22.5(需内置 `node:sqlite`)。

## License

[MIT](../../LICENSE)
