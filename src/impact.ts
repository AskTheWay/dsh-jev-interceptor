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
import { translate, type Locale } from './localization.js'

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
 * Render the impact report (fenced, styled like renderCalibration).
 * @param summary - summarizeImpact output.
 * @param locale - report language (default Chinese for legacy callers).
 * @returns a chat-friendly plain-text report.
 */
export function renderImpact(summary: ImpactSummary, locale: Locale = 'zh'): string {
  const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>): string =>
    translate(locale, key, values)
  const lines: string[] = ['```']
  lines.push(t('msg.impactTitle'))
  if (summary.windowSize === 0) {
    lines.push('')
    lines.push(t('msg.impactEmpty'))
    lines.push('```')
    return lines.join('\n')
  }
  lines.push('')
  const span = summary.firstTs !== undefined && summary.lastTs !== undefined
    ? `${summary.firstTs.slice(0, 10)} ~ ${summary.lastTs.slice(0, 10)}`
    : '—'
  lines.push(t('msg.impactWindow', {
    v0: num(summary.windowSize),
    v1: span,
    v2: summary.days,
    v3: summary.sessions,
    v4: num(summary.modeSplit.shadow),
    v5: num(summary.modeSplit.enforce),
  }))
  lines.push('')
  lines.push(t('msg.impactBenefit'))
  lines.push(t('msg.impactAutoApproved', { v0: num(summary.enforce.autoApproved) }))
  lines.push(t('msg.impactDenied', { v0: num(summary.enforce.denied) }))
  lines.push(t('msg.impactStagnationAlerts', { v0: num(summary.enforce.stagnationAlerts) }))
  lines.push(t('msg.impactAsked', { v0: num(summary.enforce.asked) }))
  // 零分母的零不是收据：预批从未触发时如实标注「无样本」。
  const enforceBuckets = summary.agreement.enforce
  const misApproval = enforceBuckets['would-over-approve']
  const anyEnforceAgreement = BUCKET_KEYS.some(key => enforceBuckets[key] > 0)
  if (anyEnforceAgreement || summary.enforce.autoApproved > 0) {
    lines.push(t(misApproval === 0 ? 'msg.impactMisApprovalNone' : 'msg.impactMisApprovalSome', {
      v0: num(misApproval),
    }))
    const friction = enforceBuckets['friction-human-approved']
    if (friction > 0) lines.push(t('msg.impactFriction', { v0: num(friction) }))
  } else {
    lines.push(t('msg.impactNoMisApprovalSample'))
  }
  // shadow 期的 would-over-approve 是假设性对照（Jev 未生效），绝不混入上面的实际段。
  const shadowWoap = summary.agreement.shadow['would-over-approve']
  if (shadowWoap > 0) {
    lines.push(t('msg.impactShadowWouldOverApprove', { v0: num(shadowWoap) }))
  }
  const shadowFriction = summary.agreement.shadow['friction-human-approved']
  if (shadowFriction > 0) {
    lines.push(t('msg.impactShadowFriction', { v0: num(shadowFriction) }))
  }
  lines.push('')
  const costText = summary.cost.costUsd > 0
    ? usd(summary.cost.costUsd)
    : summary.cost.estimatedCostUsd !== undefined
      ? t('msg.impactEstimated', { v0: usd(summary.cost.estimatedCostUsd) })
      : '$0'
  lines.push(t('msg.impactCostTitle'))
  lines.push(t('msg.impactCostLine', {
    v0: costText,
    v1: num(summary.cost.inputTokens),
    v2: num(summary.cost.cachedDecisions),
  }))
  if (summary.latency.p50 !== undefined) {
    lines.push(t('msg.impactLatency', {
      v0: summary.latency.p50,
      v1: summary.latency.p95 ?? summary.latency.p50,
    }))
  }
  if (summary.degraded.total > 0) {
    lines.push(t('msg.impactDegraded', {
      v0: num(summary.degraded.total),
      v1: Object.entries(summary.degraded.byReason).map(([reason, n]) => `${reason} ${String(n)}`).join(' · '),
    }))
  }
  lines.push('━'.repeat(44))
  if (summary.enforce.autoApproved > 0 || summary.enforce.denied > 0) {
    lines.push(t('msg.impactOneLineEffective', {
      v0: num(summary.enforce.autoApproved + summary.enforce.denied),
      v1: num(misApproval),
      v2: costText,
    }))
  } else if (summary.enforce.asked + summary.enforce.stagnationAlerts > 0) {
    lines.push(t('msg.impactOneLineAskOnly', {
      v0: num(summary.enforce.asked),
      v1: num(summary.enforce.stagnationAlerts),
    }))
  } else if (summary.modeSplit.shadow > 0) {
    lines.push(t('msg.impactOneLineShadow'))
  } else {
    lines.push(t('msg.impactOneLineNothing'))
  }
  lines.push(t('msg.impactFooter'))
  lines.push('```')
  return lines.join('\n')
}
