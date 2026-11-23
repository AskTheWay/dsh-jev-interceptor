# Jev 在 DeepSeek Harness 中的落点清单

中文 | [English](jev-usage-points.md)

本清单盘点 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）中所有适合用 System-1 决策模型（如 [Jev](https://typesafe.ai)，TypeSafe AI 的非生成式"System One"模型：文本+类型化问题进，带校准的类型化决策出，毫秒级，输入约 $0.042/百万 token）替代或辅助现有规则判断的离散决策点。清单来自对 dsh 代码库的系统扫描，下表每个挂点都经过源码 `file:line` 核实。

**适配度图例**：🟢 高（输入小而结构化、输出闭集、纯离散判断） · 🟡 中（可行但需输入限界或部分参与） · ⚪ 低（纯计算、安全边界或文本生成——不是 Jev 的活）。

## dsh 如何暴露判断点

dsh 是 everything-is-a-plugin 的 Cordis harness：每个判断点都是异步事件瀑布，第三方插件用 `ctx.on(...)` 挂入、用 `next()` 委托。两个结构性事实约束所有集成：

- **fail-closed 是全仓哲学。** 审批服务在任何 listener 之前就拒绝了 `never` 策略（`user-approval/src/index.ts:268`）；抛异常的 listener 让问题失败而不是让工具调用失败。Jev 挂点的降级方式是 `next()`，绝不是放宽权限。
- **关键位置全部允许异步注入。** `tools/pre-execute`、`approval/request`、`agent/request`、`agent/pre-step` 都是带 `AbortSignal` 的异步瀑布。仅有的同步判断点（`executionMode`、tools 的同步 `guard()` 层、投影 fold）不允许网络调用。

## 判断点清单

### 本插件（v0.1–v0.5）——审批闭环 + 会话保留 + 卸载预规划 + 停滞检测

| # | 判断点 | 现状 | Jev 的角色 | 适配 |
|---|---|---|---|---|
| 1 | **工具调用风险门** — `tools/pre-execute`（`core/tools/src/index.ts:146`，派发 `:1482-1505`） | 瀑布兜底就是 `allow`，出厂组合没有任何逐调用分类器；唯一先例 `experimental/auto-review` 用*生成式* LLM + temperature 0 + 手写 JSON 文本协议做低/中/高三分类 | 每次调用一次 fan-out：risk `choice` + irreversible / matches-task / injection-suspect `noul`。高置信+不可逆 → deny；中风险 → ask；低风险 → 委托 | 🟢 |
| 2 | **审批预答** — `approval/request`（`user-approval/src/types.ts:85-89`） | 只有人工 answerer（Web UI / ACP 桥），每次 `ask` 都耗一次人工往返 | 链上第一 answerer：within-granted-scope + reversible 双 `noul`；仅对白名单工具高置信时自动批，否则转人工 | 🟢 |
| 3 | **会话快照保留**（v0.2）— `session-reference/src/projection.ts:93-128` | FIFO 丢弃 + 最长优先截断，零语义 | 子类化 resolver，一次 fan-out 给每条可丢弃消息打分（*噪音→关键*）；最没价值先丢、截断先砍废话；关闭/shadow 模式逐字节等同上游 | 🟢 |
| 8 | **图像卸载预规划**（v0.4）— `compaction-image-offload`（README 自认"nothing plans an offload before dispatch"） | 失败请求后 FIFO 卸载 | 请求前逐图残余价值 `score`，只卸高置信可牺牲的图 | 🟢 |
| 10 | **语义停滞检测**（v0.5）— `tools/post-execute`（repeat-tool-reminder 只覆盖精确重复） | 精确匹配检测，换参数的循环不可见 | 有界失败窗口内"无进展 + 同类失败"双 `noul`；高置信注入一条提醒让 agent 换路（observe-and-enrich，绝不否决结果） | 🟡 |

挂点 1+2 是同一个闭环：出厂组合没有内置 `ask` 源，审批流量大部分正是风险门自己升级上去的。

### 路线图——已核实、本插件尚未认领的挂点

| # | 判断点 | 现状 | Jev 的角色 | 适配 |
|---|---|---|---|---|
| 4 | **内容感知模型路由** — `agent/request`（`core/agent/src/runtime-types.ts:337`） | 现有两个 listener 全是用户/UI 显式指定，没有内容驱动路由 | 复杂度 `score` + 路由 `choice`（白名单内）；需 hysteresis 粘性（路由切换使 KV cache 前缀失效） | 🟢 |
| 5 | **子代理模型默认档** — `tool-subagent/src/model-selection.ts:99` | 模型省略时静默继承父路由 | 子代理首步按 delegation prompt 做一次 `choice` | 🟢 |
| 6 | **Ralph 工人报告核验** — `workflow/tool-ralph/src/index.ts:281-331` | 脚本自己的注释承认"Completion and blockers are worker reports, not independent evaluation"（`:408`）；status 完全靠工人自报 | 对有界报告（16k 字符硬上限）做 confirm / overturn `choice` | 🟢 |
| 7 | **Goal 续轮进展判断** — `goal-round-driver/src/index.ts:164-192` | `roundsStarted < maxGoalRounds` 无条件续轮，零进展判断 | objective + 上轮输出 → 进展 `score` + continue `noul` | 🟢 |
| 9 | **溢出预览档位** — `spill/spill-policy/src/index.ts:197-220` | 固定字节预算头尾预览 | 按任务价值 `choice` 档位（tiny/short/standard/generous）；必须保留不超 cap、绝不 isError 不变量 | 🟡 |
| 11 | **检索重排** — `session-query-sqlite/src/index.ts:670-707` | FTS5 match_count 排序，无语义 | query×snippet 相关度 `score`，仅页内重排（分页确定性） | 🟡 |
| 12 | **计划就绪预检** — `plan-mode/src/index.ts:295-348` | 人工 approve / keep planning | 提交评审前 complete/needs-revision 预检，减少无效评审往返（人类保留最终批准权） | 🟡 |
| 13 | **沙箱提级必要性** — `sandbox/src/escalation.ts:153-186` | 变宽表 + 一句话理由 + 人工 | "该提级是否必要且最小" `noul` 预检 answerer | 🟡 |

### 明确不是 Jev 的领域

- **硬安全边界** — fs 沙箱路径围栏、工作区 cwd 授权、同步 `tools.guard()` 层、`never` 审批策略：必须确定性、可审计；概率分类器最多站在它们*前面*。
- **纯计算** — 压缩触发阈值（token 计数）、重试计数、shrink 不变量、spill 过期清理、FTS surface 分类：没有可加的语义信号。
- **文本生成** — 压缩摘要、会话标题、纠正反馈：System-1 不产文本；Jev 官方文档明示把 choice 链成文本又慢又差。
- **按键级频率挂点** — @file/@session 补全排序：形态合适，但每次按键的成本/频率更适合本地推理（Laya）而非远程 API。

## 塑造本插件设计的约束

来自 Jev 官方限制（2026-09 经 docs.typesafe.ai 核实）：

- **每请求 64k token、state+最长单问 ≤32k** — 上表每个挂点都限界输入（参数头尾预览、尾部消息摘要），不发送无界的原始数据。
- **约 8 并发即可能触限** — 共享客户端限制在途调用（默认 4）并在连续失败后进入冷却。
- **有校准但非全知** — 每个动作都有置信度门；低置信委托，绝不硬拍。Jev 官方指引：数值判断留在代码里，别交给模型。
- **英语优先** — CJK 准确率偏低；阈值全部可配置，双语回归集在路线图上。
- **官方承认可被提示注入操纵** — 工具参数只进 `state` 数据字段、`instructions` 是固定文案，injection-suspect 答案触发升级而非压制。

## 替代与降级

客户端直接说 `state + questions` 线协议，三种入口完全同构：

- **TypeSafe 直连**使用 `POST /v1/systemone` 和 `jev-1.14.0`。默认凭据引用为 `TYPESAFE_API_KEY`。 [TypeSafe 模型文档](https://docs.typesafe.ai/models)
- **OpenRouter** 使用 `POST /api/v1/systemone` 和 `typesafe/jev-1.14-20261014`。默认凭据引用为 `OPENROUTER_API_KEY`。显式设置的旧 alpha 端点继续使用对应的旧默认模型。 [接口文档](https://openrouter.ai/docs/api/api-reference/systemone/submit-a-system-one-request) · [Jev 版本](https://openrouter.ai/typesafe/jev-1.14)
- **本机候选**包括可经 llama.cpp 提供 System One 接口的 Laya。用同一组问题验证响应结构、中文效果、延迟和阈值后，再考虑用于只读任务。 [llama.cpp 服务文档](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#post-v1systemone-typesafe-compatible-system-one-api) · [Laya 模型卡](https://huggingface.co/convaiinnovations/laya-typed-decisions)

配置 `provider`/`endpoint`/`model` 即可切换；示例见 README。

## 2026-11 生态调研与验证顺序

截至 2026-11-23，TypeSafe 的模型文档仍把 10 月 14 日发布的 Jev 1.14 列为最新版本。官方预计这一版最大的改善在多语言。图像输入、`box` 和扩展上下文可以用于独立原型，现有图像卸载只需要判断保留价值。项目本地基线为 v0.10.0，开发依赖基于 DSH 0.2.2-rc.3。上游已发布 0.2.2-rc.5 和 0.2.3-alpha.2，新增挂点应分别验证这两条宿主版本线。 [TypeSafe 模型日志](https://docs.typesafe.ai/changelog) · [1.14 发布说明](https://typesafe.ai/blog/jev-1-14) · [DSH rc.5](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.5) · [DSH alpha.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.3-alpha.2)

| 项目或应用 | 可借鉴的做法 | 对本插件的对应落点 |
|---|---|---|
| Jevcore 与早期 dsh-jev | Jevcore 提供 DSH、MCP 和 Node 入口，默认使用离线 mock，并公开各入口会发送哪些字段。早期 dsh-jev 已停止维护，作者指向 Jevcore。 [Jevcore](https://github.com/PerryLink/jevcore) · [dsh-jev](https://github.com/buberlo/dsh-jev) | 用演示模式和诊断说明降低接入成本，在配置页明确实际决策来源。 |
| OpenCode Decision Models | 提供模型能力列表、单条判断和有并发上限的批量判断。 [项目源码](https://github.com/third774/opencode-decision-models#tools) | 先做维护者主动运行的离线对照工具，复用固定问题和输入。 |
| Jev Router for OpenCode/Cursor 与 Claude Code Jev Router | 前者做轮次、技能和工具建议，后者从账号真实模型列表选档。 [OpenCode/Cursor](https://github.com/drmaas/jev-router) · [Claude Code](https://github.com/gargpratyush/jev-router) | 借鉴候选白名单和低置信退回，用 DSH 的实际路由和缓存特征测试。 |
| Perplexity Decider v1.3、Cloudflare Clef、Laya | Decider v1.3 有开放权重并增加文本定位，厂商也发布了重排评测。Clef 提供多模态变体。Laya 有轻量模型和本机服务方案。 [Decider v1.3](https://www.perplexity.ai/en-GB/hub/blog/perplexity-decider) · [Clef](https://blog.cloudflare.com/clef-faster-cheaper-multimodal/) · [Laya](https://huggingface.co/convaiinnovations/laya-typed-decisions) | 适合作为中文、会话重排和延迟对照组。每个模型用同一份任务样本重新验证阈值。 |

面板保存、连接测试、实际工具判断与 `/jev-status` 共用同一连接。切换后清空旧连接的缓存和冷却状态，当日成本跨连接累计。面板会标明更改是否保存到当前 DSH 配置。

校准默认回放当前模型的决策与一致率记录，按服务返回的模型 ID 匹配。官方固定版本可在连接测试前展示对应的已有样本。未标明版本或只记录滚动别名的记录可在日志中查看。面板和 `/jev-calibrate --model <id>` 支持回看历史版本。面板上应用建议时，服务端会检查当前模型和原阈值是否仍与报告一致。

1. **补上中英对照与留出评估。** 在按模型回放的基础上记录题目版本、工具类型与输入语言。将调参与留出集按会话或时间划分，对照误拒、额外确认、覆盖率、降级、端到端 p50/p95 和成本。用中英成对的可逆操作、明确授权和歧义样本，对比简短规则与含正反例的规则。公开策略门研究在合成样本中观察到了改善，插件可在自己的任务分布上复核。 [策略门研究](https://arxiv.org/abs/2611.02155) · [配对评估](https://arxiv.org/abs/2610.02267)
2. **先试只读语义增强。** 基于现有停滞和会话引用能力，用实际结果选一个入口做观察实验，例如只在当前检索页重排候选，或在人工查看 Ralph 报告前核对是否给出可验证的证据。验收用相关项保留率、找证据所需时间和额外延迟。证据不足时保留原有顺序或状态。
3. **模型路由先记录建议。** 用 `agent/request` 的显式模型选择作为边界，先比较现有固定路由、简单规则和 Jev 的首轮建议。统计任务通过率、总账单、墙钟时间与前缀缓存命中。配对评估中的零样本路由未超过随机对照，多轮路由研究也把可复用前缀列为决策成本。达到留出集质量要求后，再考虑让建议影响实际模型。 [配对评估](https://arxiv.org/abs/2610.02267) · [MultiTurnRoute](https://arxiv.org/abs/2611.10848)
