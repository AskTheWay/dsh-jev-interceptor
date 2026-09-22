# dsh-jev-interceptor

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node >= 20.3](https://img.shields.io/badge/node-%3E%3D20.3-green.svg)]()
[![dsh plugin](https://img.shields.io/badge/dsh-plugin-8A2BE2.svg)](https://github.com/topics/dsh-plugin)
[![Jev](https://img.shields.io/badge/powered%20by-Jev%20%7C%20System%20One-ff6b35.svg)](https://typesafe.ai)

> ⚡ **每个工具调用，毫秒级裁决——单次成本约百万分之二美元。**
>
> 你的 agent 最烧钱的坏习惯：拿一个会写诗的 LLM 去回答是非题。
> 本插件把 [Jev](https://typesafe.ai)——那个九月刷屏全网的非生成式"System One"模型——直接接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里 LLM 大材小用、规则又全盲的两个判断点。

中文 | [English](README.md)

**一口气说完它做什么：** 工具调用执行前，Jev 用一次约 $0.00002 的请求完成风险、可逆性、任务匹配度、注入嫌疑四重分类——高置信高危直接拒绝，中风险升级人工，明确授权且可逆的不再浪费你点审批弹窗。任何存疑、超时、没 key，都降级回 dsh 原生行为。不需要配置任何"退路"，也绝无放宽权限的可能。

## 为什么值得做

dsh 出厂**没有任何逐调用风险分类**——pre-execute 瀑布的兜底就是裸 `allow`。唯一的内置先例 `experimental/auto-review` 用*生成式* LLM 干这活：每次工具调用一个完整模型请求、temperature 0、手写 JSON 文本协议，官方自认慢、贵、实验性。这是让 System-2 抄写员去干 System-1 反射的活：

| | auto-review（生成式 LLM） | dsh-jev-interceptor（Jev） |
|---|---|---|
| 决策形态 | 逐 token 生成 JSON 再解析，全靠祈祷 | 类型化 `choice`/`noul` 答案——类型错误结构性不可能 |
| 单次成本 | 一次**完整 LLM 请求** | **约 $0.00002**（实测：501 输入 token） |
| 延迟 | 秒级 | provider 侧约 100ms（TypeSafe 报告的 p50）；美西之外端到端约 1s |
| 不确定性 | 藏在散文里 | 每问带概率分布 + 校准置信度 |
| 失败路径 | 解析兜底 → deny | 低置信 → `next()`——**绝不硬拍** |

TypeSafe 官方宣称 Jev 在分类工作负载上比 LLM 快最高 **200 倍、便宜最高 400 倍**——本插件就是把这个数字落进真实 agent harness，收据在 `/jev-stats` 里。

我们相信这是 **dsh 生态第一个 System-1 决策插件**。决策模型在 dsh 中的完整地图——本插件的两个挂点 + 另外十一个已核实挂点（语义模型路由、上下文保留打分、图像卸载预规划、工人报告核验……）——见 [docs/jev-usage-points.zh.md](docs/jev-usage-points.zh.md)。

## 60 秒上手

```sh
dsh plugin --profile <name> add dsh-jev-interceptor
```

```yaml
# 在 profile 的 cordis.patch.yml 里
- id: jev-interceptor
  name: dsh-jev-interceptor
  config:
    enabled: true
    mode: shadow            # 先观察模式：记录每个决策，不执行任何干预
    provider: typesafe      # 或 'openrouter'（今天就能用，无需候补）| 'custom'
```

正常使用你的 agent。shadow 模式下每个决策（含完整概率分布）都落入遥测；`/jev-stats` 汇总：

```
[guard] calls: 41  degraded: 0  cached: 9
  actions: delegate=33 ask=6 deny=2
  input tokens: 18234  est. cost: $0.000766
  latency: p50 247ms  p95 512ms  max 611ms
```

数字满意？把 `mode` 改成 `enforce`。这就是全部的上线方案——**先观察，再信任，绝不硬拍**。

## 安全模型（真正值得细读的部分）

- **永不返回 `allow`。** "无异议"用 `next()` 表达，链上后续 listener（外部 hook、auto-review）的否决权完好无损。
- **处处 fail-closed。** 无 key / provider 冷却 / 超时 / 解析不匹配 / 内部错误 → 委托回原生行为。审批服务的 `never` 策略在任何 listener 之前执行，本插件在结构上就无法放宽它。
- **证据门控的自动批准。** `allowed-once` 必须有参数证据：只有 guard 升级过的调用（新鲜条目、会话与工具都匹配）才可能被自动批；hook 请求与沙箱提级不携带参数，一律转人工。
- **注入感知。** 工具参数只进 Jev `state` 数据字段；`instructions` 是固定文案；疑似注入的答案触发*升级*而非压制。（Jev 官方承认可被对抗内容影响——所以本插件的拦截是加速器，永远不是最后防线。）
- **输入限界。** 参数头尾预览 + 尾部消息摘要——Jev 官方指引就是"代码先过滤，只发问题需要的字段"。
- **构造级韧性。** 每次尝试墙钟超时、429/529 单次重试、连续失败进冷却（超时也计数）、并发上限、LRU 决策缓存、排队有界的信号量。provider 挂掉的代价是零行为差异，不是你的 harness。
- **可观测。** 每个决策落入 `<dsh-home>/plugins/dsh-jev-interceptor/telemetry.jsonl`（遵循 `$DSH_HOME`）；`/jev-stats` 按挂点汇总。

以上全部由 **52 个测试**锁定，包括对抗评审的回归用例（曾可能挂死工具管线的并发泄漏、跨会话 callId 碰撞、无证据自动批准）。

## 配置

一切皆配置项——超时、冷却、并发、缓存、各挂点阈值、工具名单——见 `src/config.ts` 的 `Config` schema。值得注意的默认值：

- 只读工具（`read`、`read_image`、`grep`、`glob`、`todo_write`）**零成本**直通；
- Auto 权限预设完全让位给 `auto-review`（不双重审查、不双重计费）；
- 预批白名单默认**为空**——在 `preapproveToolAllowlist` 里点名工具之前，任何调用都不会被自动批准。

OpenRouter 今天就能用、无需候补（decisions 模型在那里走专用端点）：

```yaml
    provider: openrouter
    apiKeyEnv: OPENROUTER_API_KEY
```

客户端直说 `state + questions` 线协议，TypeSafe 直连、OpenRouter 与 Apache-2.0 本地平替 [Laya](https://huggingface.co/convaiinnovations/laya) 完全同构——provider 可随时切换，闭源供应商永远成不了锁定。

## 开发

```sh
npm install --legacy-peer-deps   # devDeps 钉在当前一代 dsh API
npm run typecheck                # src + tests，对真实 @deepseek-ai 类型
npm test                         # vitest，52 个测试，无需网络
npm run build                    # tsc -> lib/
node scripts/smoke.mjs           # 对真实 provider 跑一次决策
```

## 路线图：另外十一个挂点

v0.1 守住审批闭环。已核实的下一战场——让"选择"而不只是"安全"用上 System-1（[完整目录](docs/jev-usage-points.zh.md)）：

- **语义上下文保留**——`@session` 快照注入时逐消息打分，让*错误堆栈*活过字节预算，而不是*最旧的寒暄*
- **图像卸载预规划**——dsh 自己的 README 承认"nothing plans an offload before dispatch"；Jev 来规划
- **内容感知模型路由**——例行步骤走便宜档，硬仗上强模型
- **工人报告核验**——子代理说"做完了"，得有东西查一查

## 许可证

[MIT](LICENSE)
