# 贡献指南

中文 | [English](CONTRIBUTING.md)

感谢你参与改进 dsh-jev-interceptor。

## 开发环境

- Node **≥ 20.3**（代码用到 `AbortSignal.any`）。
- 仓库自带 `.npmrc`（`legacy-peer-deps=true`）——当前 `@deepseek-ai/*` 的 rc 版 peer 范围在裸 npm 下无法扁平解析；运行时 peers 由 dsh 安装提供。

```sh
git clone https://github.com/AskTheWay/dsh-jev-interceptor.git
cd dsh-jev-interceptor
npm ci
npm run typecheck   # src + 测试，对真实 @deepseek-ai 包类型
npm test            # vitest，离线，无需 API key
npm run build       # tsc -> lib/
```

可选的真实调用检查（花费几美分，需要 key）：

```sh
node scripts/smoke.mjs                              # 一次真实决策（TYPESAFE_API_KEY 或 OPENROUTER_API_KEY）
OPENROUTER_API_KEY=... node scripts/effect-test.mjs # 守门人电池 + 保留打分对比
```

## 如何提交

1. 从 `main` 切分支（`feat/...`、`fix/...`、`docs/...`）。
2. Commit 遵循 [Conventional Commits](https://www.conventionalcommits.org/)（`feat:`、`fix:`、`docs:`、`test:`）——发布流程会读取。
3. 提 PR。CI 必须全绿：typecheck（两套 tsconfig）、完整测试、构建、`npm pack` 产物检查。
4. **欢迎 AI 辅助的贡献——在 PR 里披露即可。** 大比例 agent 生成的代码请说明；深度证据（测试、可复现脚本）比作者身份更重要，隐瞒才损失信任。

## 仓库结构

| 模块 | 职责 |
|---|---|
| `src/index.ts` | 插件入口：挂载各钩子、共享 Jev 客户端、`/jev-stats` |
| `src/jev.ts` | 决策客户端：墙钟预算、重试、冷却、并发、缓存——降级返回 `null` 而不是抛错 |
| `src/guard.ts` | `tools/pre-execute` 风险门 + `PendingAsks` 桥接 |
| `src/preapprove.ts` | `approval/request` 证据门控的自动预批 |
| `src/session-reference.ts` | 子类化 resolver 接管会话保留 |
| `src/retention.ts` | 纯保留算法（上游 projection.ts 的改造复刻） |
| `src/matrix.ts` | 纯决策矩阵（guard / preapprove） |
| `src/resilience.ts` | 信号量、冷却门、LRU |
| `src/config.ts` | Schemastery schema + `DEFAULTS` + 显式 `resolveSettings` |
| `src/telemetry.ts` | JSONL 决策日志 + `/jev-stats` 聚合 |

`docs/jev-usage-points.zh.md` 是 dsh 中全部已核实判断点的地图与本插件的认领情况。

## 安全契约（改钩子前必读）

以下不变量就是本产品本身。每条都有回归测试锁定；如果你的改动削弱了其中一条，改动就是错的。

1. **绝不放宽权限。** 守门人永不返回 `allow`——"无异议"用 `next()` 表达。审批的 `never` 策略在上游执行，本插件必须永远够不着它。
2. **一切失败降级回原生行为。** 无 key / 冷却 / 超时 / 解析不匹配 / 内部错误 → 委托。决策钩子因 provider 故障而抛错或阻塞即是 bug；见 `test/guard.test.ts`（"delegates when classification throws"）。
3. **证据门控的自动批准。** `allowed-once` 需要新鲜的、会话与工具都匹配的 guard 捕获条目。绝不只凭 ask 理由判定授权。
4. **只发限界输入。** 工具参数以头尾预览进入 Jev state；消息摘要按字符封顶。Jev 官方指引：代码先过滤，只发问题需要的字段。
5. **打分键是原始投影索引**（`retention.ts`）——splice 位移曾导致关键消息被错误丢弃；回归测试已锁定。
6. **缓存与队列纪律。** 分数缓存按轮生效（每轮清空、降级即删）；信号量在 abort 下绝不泄漏槽位。
7. **不硬编码可调参数。** 部署间可能不同的取值一律是 `Config` 字段 + `DEFAULTS` 条目 + `resolveSettings` 映射。

## 新增决策钩子

清单（候选挂点与适配分析见 `docs/jev-usage-points.zh.md`）：

- [ ] 挂点必须是 dsh 文档化的扩展点，且优先**纯组合**（append/prepend 监听）；接管须有充分理由——接管必须继承全部上游行为且默认纯透传。
- [ ] 输入限界；答案只在置信度门之后被消费。
- [ ] 每条失败路径都降级回原生行为；shadow 模式只记录不执行。
- [ ] telemetry 新增对应 `DecisionTag` 与该钩子的动作词汇。
- [ ] 测试：行为（它做什么）、降级路径、至少一个对抗用例。
- [ ] `Config` schema + `DEFAULTS` + `resolveSettings` + README/README.zh 配置说明。

## 风格

- 全 ESM；相对导入带 `.js` 后缀。
- 遵循 dsh 约定：注册皆 effect；waterfall listener 必调 `next()` 或有意短路；封闭联合以 `assertNever` 式兜底收尾。
- 代码注释与 JSDoc 用英文；面向用户的文档英文 + 中文成对（一段一物理行，一个事实一个家）。
- 测试描述行为而非正确性表演；过时行为与其测试一起改。
- 文件以恰好一个换行符结尾。

## 安全

- 漏洞请通过 [GitHub Security Advisories](https://github.com/AskTheWay/dsh-jev-interceptor/security/advisories) 私下报告——不要开公开 issue。
- 记住数据面：限界预览与摘要会发送到配置的 provider（TypeSafe 或 OpenRouter）。扩大出境数据必须有配置开关与 README 说明。
