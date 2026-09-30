---
description: 查看 TPS 吞吐、延迟分位数、错误率与系统资源快照
---

用 zcode-tps-monitor 取数并以中文清晰展示。

1. 优先 MCP 工具 `tps_snapshot`(即时快照);数字参数 N(如 `/tps 10`)时改用 `tps_watch`(seconds=N,2-30),展示采样统计(平均/峰值)。
2. 用户问的是 **token 速率**(而非业务 TPS)时,改运行 token 速率脚本(本命令文件所在目录的 `../../scripts/token-rate.mjs`):无旗标=最近请求+会话累计;`--turn --current`=本问即时统计;`--json`=JSON。
3. MCP 工具不可用时,退回采集脚本(本命令目录的 `../../scripts/collect.mjs`,加 `--watch N` 可采样观察)。

展示要求:列表或表格列 TPS、延迟 p50/p95/p99、错误率、CPU、内存;注明数据模式 remote(真实接口)/demo(演示数据),demo 需提醒用户可在 设置 → 插件管理 → zcode-tps-monitor 配置 metrics_url 接入真实数据源。

用户附加要求:$ARGUMENTS
