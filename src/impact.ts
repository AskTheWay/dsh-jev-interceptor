/**
 * 效果归因：把遥测记录翻译成「这个插件值不值」的净收益叙事。
 *
 * 核心口径（全部由既有遥测字段推导，无新数据依赖）：
 * - 省掉的点击 = enforce 期 preapprove 的 auto-approve 次数（每次
 *   allowed-once 就是一次人工审批点击被省掉）；
 * - 误批 = enforce 期 would-over-approve（Jev 自动批了、人拒绝）——理想为 0；
 *   shadow 期的同名桶是假设性对照（Jev 未生效），单独呈现、绝不混入
 *   「实际生效」段；
 * - 拦截 = enforce 期 guard deny（高置信风险直接否决）；
 * - 多余人工 = enforce 期 friction-human-approved（Jev 转人工、人放行）；
 * - 成本 = 遥测记录的 inputTokens/costUsd 汇总（缓存命中不重复计费；
 *   降级不计成本——降级记录不带计费字段）；
 * - 延迟 = 与 /jev-stats 同口径：非 cache 决策全部计入（含降级等待——
 *   timeout 降级的 latency ≈ 全额预算等待，剔除会系统性美化尾部）。
 *
 * 纯函数、不 IO、永不抛：空窗口自然产生零计数，命令与面板共用。
 * @module dsh-jev-interceptor/impact
 */

import type { TelemetryEntry } from './telemetry.js'

/** 一致率分桶（与 approval-loop 的 detail token 对齐）。 */
const BUCKET_KEYS = [
  'would-over-approve',
  'aligned-approve',
  'aligned-reject',
  'friction-human-approved',
  'neutral',
] as const

/** 净收益与成本汇总。 */
export interface ImpactSummary {
  /** 分析窗口内的记录总数。 */
  readonly windowSize: number
  /** 窗口时间范围（ISO；空窗口为 undefined）。 */
  readonly firstTs: string | undefined
  readonly lastTs: string | undefined
  /** 窗口覆盖的自然日数（按记录的 UTC 日期去重）。 */
  readonly days: number
  /** 窗口内出现过的会话数（unique sessionId）。 */
  readonly sessions: number
  readonly modeSplit: { readonly shadow: number; readonly enforce: number }
  /** enforce 期（实际生效）的关键动作。 */
  readonly enforce: {
    readonly denied: number
    readonly asked: number
    readonly autoApproved: number
    readonly stagnationAlerts: number
  }
  /** 一致率分桶（按模式拆开：enforce = 实际发生；shadow = 假设性对照）。 */
  readonly agreement: {
    readonly enforce: Readonly<Record<(typeof BUCKET_KEYS)[number], number>>
    readonly shadow: Readonly<Record<(typeof BUCKET_KEYS)[number], number>>
  }
  /** 成本（缓存命中不重复计费；估算仅在全部记录都缺失 costUsd 时给出）。 */
  readonly cost: {
    readonly inputTokens: number
    readonly costUsd: number
    readonly cachedDecisions: number
    /** costUsd 全缺（非"和为 0"）且有 token 计数时的估算（按 Jev 公开输入价）。 */
    readonly estimatedCostUsd: number | undefined
  }
  /** 非 cache 决策的延迟分位（毫秒；含降级等待，与 /jev-stats 同口径）。 */
  readonly latency: { readonly p50: number | undefined; readonly p95: number | undefined }
  /** 降级汇总（按 reason 分桶）。 */
  readonly degraded: { readonly total: number; readonly byReason: Readonly<Record<string, number>> }
}

/**
 * 汇总一个遥测窗口的效果。
 * @param entries - 遥测记录（全量或尾部窗口）。
 * @returns 效果汇总；空窗口全零。
 */
export function summarizeImpact(entries: readonly TelemetryEntry[]): ImpactSummary {
  const enforce = { denied: 0, asked: 0, autoApproved: 0, stagnationAlerts: 0 }
  const emptyBuckets = () => Object.fromEntries(BUCKET_KEYS.map(key => [key, 0])) as Record<(typeof BUCKET_KEYS)[number], number>
  const agreement = { enforce: emptyBuckets(), shadow: emptyBuckets() }
  const cost = { inputTokens: 0, costUsd: 0, cachedDecisions: 0, estimatedCostUsd: undefined as number | undefined }
  const latencies: number[] = []
  const byReason: Record<string, number> = {}
  const sessions = new Set<string>()
  const days = new Set<string>()
  let shadow = 0
  let enforceCount = 0
  let firstTs: string | undefined
  let lastTs: string | undefined
  let costReported = 0

  for (const entry of entries) {
    if (firstTs === undefined || entry.ts < firstTs) firstTs = entry.ts
    if (lastTs === undefined || entry.ts > lastTs) lastTs = entry.ts
    days.add(entry.ts.slice(0, 10))
    if (entry.sessionId !== undefined) sessions.add(entry.sessionId)
    if (entry.mode === 'shadow') shadow += 1
    else enforceCount += 1

    if (entry.mode === 'enforce') {
      if (entry.tag === 'guard' && entry.action === 'deny') enforce.denied += 1
      else if (entry.tag === 'guard' && entry.action === 'ask') enforce.asked += 1
      else if (entry.tag === 'preapprove' && entry.action === 'auto-approve') enforce.autoApproved += 1
      else if (entry.tag === 'stagnation' && entry.action === 'stagnation-alert') enforce.stagnationAlerts += 1
    }
    if (entry.tag === 'approval-loop' && entry.action === 'agreement') {
      const bucket = entry.mode === 'shadow' ? agreement.shadow : agreement.enforce
      for (const key of BUCKET_KEYS) {
        if (entry.detail?.includes(key) === true) bucket[key] += 1
      }
    }
    if (entry.action === 'degraded') {
      byReason[entry.detail ?? 'unknown'] = (byReason[entry.detail ?? 'unknown'] ?? 0) + 1
    } else {
      if (entry.inputTokens !== undefined) cost.inputTokens += entry.inputTokens
      if (entry.costUsd !== undefined) {
        cost.costUsd += entry.costUsd
        costReported += 1
      }
      if (entry.cached === true) cost.cachedDecisions += 1
    }
    // 延迟与 /jev-stats 同口径：只排除 cache；降级等待（timeout ≈ 全额预算）
    // 计入尾部——no-key/cooldown 类降级本就不带 latencyMs，自然排除。
    if (entry.latencyMs !== undefined && entry.cached !== true) latencies.push(entry.latencyMs)
  }
  if (costReported === 0 && cost.inputTokens > 0) {
    cost.estimatedCostUsd = (cost.inputTokens / 1_000_000) * 0.042
  }
  const sorted = [...latencies].sort((left, right) => left - right)
  const at = (fraction: number): number | undefined =>
    sorted.length === 0 ? undefined : sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]

  return {
    windowSize: entries.length,
    firstTs,
    lastTs,
    days: days.size,
    sessions: sessions.size,
    modeSplit: { shadow, enforce: enforceCount },
    enforce,
    agreement,
    cost,
    latency: { p50: at(0.5), p95: at(0.95) },
    degraded: { total: Object.values(byReason).reduce((sum, n) => sum + n, 0), byReason },
  }
}

/** 数字格式化：千分位。 */
function num(value: number): string {
  return value.toLocaleString('en-US')
}

/** 美元格式化：保留有效精度。 */
function usd(value: number): string {
  return `$${value < 0.01 ? value.toFixed(6) : value.toFixed(4)}`
}

/**
 * 渲染中文效果报告（自带 ``` 包裹，风格与 renderCalibration 一致）。
 * @param summary - summarizeImpact 的输出。
 * @returns 聊天友好的纯文本报告。
 */
export function renderImpact(summary: ImpactSummary): string {
  const lines: string[] = ['```']
  lines.push('📈 dsh-jev-interceptor 效果归因')
  if (summary.windowSize === 0) {
    lines.push('')
    lines.push('  暂无数据：先 /jev-on 启用插件跑一段会话，再回来归因')
    lines.push('```')
    return lines.join('\n')
  }
  lines.push('')
  const span = summary.firstTs !== undefined && summary.lastTs !== undefined
    ? `${summary.firstTs.slice(0, 10)} ~ ${summary.lastTs.slice(0, 10)}`
    : '—'
  lines.push(`窗口 ${num(summary.windowSize)} 条（${span}，${String(summary.days)} 天 · ${String(summary.sessions)} 个会话）`
    + ` 模式 shadow ${num(summary.modeSplit.shadow)} / enforce ${num(summary.modeSplit.enforce)}`)
  lines.push('')
  lines.push('✅ 净收益（enforce 期实际生效）')
  lines.push(`   省掉的审批点击   ${num(summary.enforce.autoApproved)} 次（自动批准 = 每次少点一次确认）`)
  lines.push(`   拦截的高风险调用 ${num(summary.enforce.denied)} 次`)
  lines.push(`   停滞提醒         ${num(summary.enforce.stagnationAlerts)} 次`)
  lines.push(`   转人工           ${num(summary.enforce.asked)} 次（风险不确定，交回人工）`)
  // 零分母的零不是收据：预批从未触发时如实标注「无样本」。
  const enforceBuckets = summary.agreement.enforce
  const misApproval = enforceBuckets['would-over-approve']
  const anyEnforceAgreement = BUCKET_KEYS.some(key => enforceBuckets[key] > 0)
  if (anyEnforceAgreement || summary.enforce.autoApproved > 0) {
    lines.push(`   误批             ${num(misApproval)} 次${misApproval === 0 ? '（would-over-approve = 0）' : ' ⚠️ 出现 Jev 批准、人拒绝'}`)
    const friction = enforceBuckets['friction-human-approved']
    if (friction > 0) lines.push(`   多余人工         ${num(friction)} 次（Jev 转人工、人放行——收紧候选）`)
  } else {
    lines.push('   误批             — 无样本（预批准路径未触发，该指标尚未被测量）')
  }
  // shadow 期的 would-over-approve 是假设性对照（Jev 未生效），绝不混入上面的实际段。
  const shadowWoap = summary.agreement.shadow['would-over-approve']
  if (shadowWoap > 0) {
    lines.push(`   shadow 对照       Jev 会批、人拒绝 ${num(shadowWoap)} 次（假设性，未生效——升 enforce 前先校准）`)
  }
  const shadowFriction = summary.agreement.shadow['friction-human-approved']
  if (shadowFriction > 0) {
    lines.push(`   shadow 对照       Jev 转人工、人放行 ${num(shadowFriction)} 次（假设性——阈值偏紧的信号）`)
  }
  lines.push('')
  const costText = summary.cost.costUsd > 0
    ? usd(summary.cost.costUsd)
    : summary.cost.estimatedCostUsd !== undefined
      ? `≈${usd(summary.cost.estimatedCostUsd)}（按公开输入价估算）`
      : '$0'
  lines.push('💰 成本与延迟')
  lines.push(`   Jev 决策成本     ${costText}（${num(summary.cost.inputTokens)} input tokens，${num(summary.cost.cachedDecisions)} 次缓存命中免费）`)
  if (summary.latency.p50 !== undefined) {
    lines.push(`   决策延迟         p50 ${String(summary.latency.p50)}ms · p95 ${String(summary.latency.p95 ?? summary.latency.p50)}ms`)
  }
  if (summary.degraded.total > 0) {
    lines.push(`   降级             ${num(summary.degraded.total)} 次（${Object.entries(summary.degraded.byReason).map(([reason, n]) => `${reason} ${String(n)}`).join(' · ')}）`)
  }
  lines.push('━'.repeat(44))
  if (summary.enforce.autoApproved > 0 || summary.enforce.denied > 0) {
    lines.push(`  一句话：${num(summary.enforce.autoApproved + summary.enforce.denied)} 次该人工把关的判断被自动完成，误批 ${num(misApproval)} 次，成本 ${costText}`)
  } else if (summary.enforce.asked + summary.enforce.stagnationAlerts > 0) {
    lines.push(`  一句话：enforce 期已转人工 ${num(summary.enforce.asked)} 次、停滞提醒 ${num(summary.enforce.stagnationAlerts)} 次，还没有自动批准或拦截（阈值可经 /jev-calibrate 调整）`)
  } else if (summary.modeSplit.shadow > 0) {
    lines.push('  一句话：enforce 期还没有生效动作；shadow 期数据在积累校准依据')
  } else {
    lines.push('  一句话：enforce 期还没有生效动作')
  }
  lines.push('  明细: /jev-log │ 校准: /jev-calibrate')
  lines.push('```')
  return lines.join('\n')
}
