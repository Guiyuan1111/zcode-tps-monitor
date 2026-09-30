---
name: zcode-tps-monitor
description: 当用户询问 token 速率、生成速度、tok/s、模型输出快慢、TTFT(首 token 延迟),或 TPS、QPS、吞吐、接口延迟时使用。
---

# TPS Monitor(token 速率 + 业务吞吐)

两类指标:

- **Token 输出速率(真实)** — 读 ZCode usage 库(`model_usage` 表):每轮 tok/s、输出 token、生成耗时、TTFT、会话均/峰。用户问"生成速度/token 速率/tok/s"时用这个。
- **业务 TPS(demo/remote)** — 未配置接口为演示数据;配置 `metrics_url` 后为真实吞吐。

## 取数方式

1. Token 速率(推荐,真实数据):
   ```
   node <插件目录>/scripts/token-rate.mjs                  # 最近一次请求 + 会话统计
   node <插件目录>/scripts/token-rate.mjs --turn --current # 最新一问(本问)即时统计
   node <插件目录>/scripts/token-rate.mjs --json           # JSON
   ```
   可设 `ZCODE_SESSION_ID` 只统计当前会话(钩子已自动设置)。
2. 业务 TPS:MCP 工具 `tps_snapshot`/`tps_watch`,或 `node <插件目录>/scripts/collect.mjs [--watch N]`。

## 展示规范

- 中文回复,指标用表格或列表;token 速率需注明模型名;TTFT>5s 或速率骤降可一句简评。
- 上下文含【本轮统计】:按指令在回复收尾时运行脚本,输出行原样放入引用块贴回复最末;脚本没有输出则不显示任何统计行。
- demo 模式的业务 TPS 要主动标注,并提示可配置 `metrics_url`。
