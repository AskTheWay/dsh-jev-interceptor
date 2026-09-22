# dsh-jev-interceptor

中文 | [English](README.md)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）装上 [System-1 决策](docs/jev-usage-points.zh.md)：本插件用 [Jev](https://typesafe.ai)（TypeSafe AI 的非生成式"System One"模型）对每个待执行的工具调用做一次毫秒级分类，并用带校准的答案

1. **在危险调用执行前升级给人工**（`tools/pre-execute`），以及
2. **自动批准明确在授权范围内且可逆的调用**（`approval/request`），让人从例行审批里解放出来。

一切降级都是 fail-closed：没有 key、provider 冷却、超时或任何内部错误时，所有挂点都通过 `next()` 委托，dsh 的行为与未安装本插件时完全一致。插件绝不放宽基础组合本不会授予的权限，且在你显式启用之前保持沉默。

## 为什么值得做

dsh 出厂没有任何逐调用风险分类器——pre-execute 瀑布的兜底就是裸 `allow`。唯一的内置先例 `experimental/auto-review` 用**生成式** LLM + temperature 0 + 手写 JSON 文本协议做三分类：慢、贵、官方自认实验性。本插件把同一个决策放回它该在的形态——类型化决策原语：

| | auto-review（生成式 LLM） | 本插件（Jev） |
|---|---|---|
| 决策形态 | 逐 token 生成 JSON 文本再解析 | 类型化 `choice`/`noul` 答案，类型错误结构性为零 |
| 成本 | 每次调用一个完整 LLM 请求 | 1-4k 输入 token 约 $0.00002/次（$0.042/百万 token） |
| 不确定性 | 藏在散文里 | 每问带概率分布 + 置信度 |
| 失败路径 | 解析兜底 → deny | 低置信 → 委托（`next()`），绝不硬拍 |

Jev 在 dsh 中的完整落点清单——本插件的两个挂点 + 十一个已核实的路线图挂点（模型路由、子代理默认档、工人报告核验、图像卸载预规划、会话快照保留等）——见 [docs/jev-usage-points.zh.md](docs/jev-usage-points.zh.md)。

## 安装

需要 Node ≥ 20 与一个 dsh profile。

```sh
dsh plugin --profile <name> add dsh-jev-interceptor
```

或从 git 安装（用户需在 profile 的 pnpm-workspace.yaml 里 allowBuilds 允许构建脚本，见 dsh 插件文档）：

```sh
dsh plugin --profile <name> add github:<you>/dsh-jev-interceptor
```

## 配置

插件默认关闭，启用后先进入 **shadow 模式**——只记录每个"本会怎么判"的决策（遥测 + `/jev-stats`），不实际执行。数字满意后再升级 `enforce`。

在 profile 的 `cordis.patch.yml`（或设置面板）里：

```yaml
- id: jev-interceptor
  name: dsh-jev-interceptor
  config:
    enabled: true
    mode: shadow            # 或 'enforce' 实际执行决策
    provider: typesafe      # 'typesafe' | 'openrouter' | 'custom'
    # apiKeyEnv: TYPESAFE_API_KEY   # credential-ref；用 openrouter 时配 OPENROUTER_API_KEY
    # endpoint: ...                 # provider: custom 时必填
    # model: ...                    # 各 provider 有默认；钉版本可让阈值稳定
```

OpenRouter 示例（decisions 模型在那里走专用端点）：

```yaml
    provider: openrouter
    apiKeyEnv: OPENROUTER_API_KEY
```

其余一切皆配置项（超时、冷却、并发、缓存、各挂点阈值、工具名单）——见 `src/config.ts` 的 `Config` schema。值得注意的默认值：

- 只读工具（`read`、`read_image`、`grep`、`glob`、`todo_write`）零成本直通；
- Auto 权限预设完全让位给 `auto-review`；
- 预批白名单默认**为空**——在 `preapproveToolAllowlist` 里点名工具之前，任何调用都不会被自动批准。

## 安全模型

- **永不返回 `allow`。** "无异议"用 `next()` 表达，链上后续 listener（外部 hook、auto-review）的否决权完好无损。
- **处处 fail-closed。** 无 key / 冷却 / 超时 / 解析不匹配 / 内部错误 → 委托。审批服务的 `never` 策略在任何 listener 之前执行，本插件在结构上就无法放宽它。
- **注入感知。** 工具参数只进 Jev `state` 数据字段；`instructions` 是固定文案；疑似注入的答案触发升级而非压制。
- **输入限界。** 参数头尾预览 + 尾部消息摘要——provider 官方指引就是"代码先过滤，只发问题需要的字段"。
- **可观测。** 每个决策落入 `~/.dsh-jev-interceptor/telemetry.jsonl`（动作、答案、置信度、延迟、token、成本、降级原因）；`/jev-stats` 按挂点汇总。
- **有韧性。** 每次尝试墙钟超时、429/529 单次重试、连续失败进冷却（超时也计数）、在途上限（默认 4；provider 约 8 并发即触限）、LRU 决策缓存。

## 开发

```sh
npm install --legacy-peer-deps   # devDeps 钉在当前一代 dsh API
npm run typecheck
npm test                         # vitest，40 个测试，无需网络
npm run build                    # tsc -> lib/
```

`scripts/smoke.mjs` 用构建产物对真实 provider 跑一次（设置 `TYPESAFE_API_KEY` 或 `OPENROUTER_API_KEY`）。

## 状态与路线图

v0.1 实现审批闭环（风险门 + 预批 + 遥测）。已核实的后续挂点——内容感知模型路由、子代理默认档、Ralph 报告核验、goal 续轮进展、图像卸载预规划、会话快照保留——编目于 [docs/jev-usage-points.zh.md](docs/jev-usage-points.zh.md)。Jev 是闭源早期服务：客户端直说 `state + questions` 线协议，TypeSafe 直连、OpenRouter 与 Apache-2.0 本地平替 [Laya](https://huggingface.co/convaiinnovations/laya) 完全同构，provider 可随时切换。

## 许可证

[MIT](LICENSE)
