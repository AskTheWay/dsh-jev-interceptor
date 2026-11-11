/**
 * 影子数据校准器：把 telemetry 里积累的决策分布与审批一致率桶，翻译成
 * 8 个阈值参数的调整建议报告。
 *
 * 设计立场：
 * - 纯函数、不 IO、不调 Jev、永不抛——命令与面板共用；无 key 或无日志时
 *   报告显示「暂无数据」而非报错；
 * - 不自动应用（没有 --apply）：建议是给人看的，落地靠人工复制到
 *   cordis.patch.yml；
 * - 注入防线永不放松：两个 injection 阈值只出现在观察区，永不出现在建议区；
 * - 反事实重放直接调用 decideGuard/decidePreapprove（不重写判定逻辑），
 *   与真实决策矩阵永远同源；
 * - 每个参数至多一条建议，同参数双信号冲突时收紧方向优先。
 * @module dsh-jev-interceptor/calibrate
 */

import { translate, type Locale, type MessageKey } from './localization.js'
import type { ResolvedSettings } from './config.js'
import {
  decideGuard,
  decidePreapprove,
  type GuardAnswers,
  type GuardThresholds,
  type PreapproveThresholds,
} from './matrix.js'
import type { TelemetryEntry } from './telemetry.js'

/** 可校准的阈值参数 id，与 ResolvedSettings 同名字段一一对应。 */
export type ThresholdKey =
  | 'guardConfidenceMin'
  | 'guardDenyConfidence'
  | 'guardIrreversibleCeiling'
  | 'guardIrreversibleDenyFloor'
  | 'guardInjectionAskThreshold'
  | 'preapproveAutoApproveMin'
  | 'preapproveIrreversibleMax'
  | 'preapproveInjectionSuspectMax'

/** 阈值键的单一权威清单：热更新白名单、API 白名单、快照落盘均从此派生。 */
export const THRESHOLD_KEYS = [
  'guardConfidenceMin',
  'guardDenyConfidence',
  'guardIrreversibleCeiling',
  'guardIrreversibleDenyFloor',
  'guardInjectionAskThreshold',
  'preapproveAutoApproveMin',
  'preapproveIrreversibleMax',
  'preapproveInjectionSuspectMax',
] as const satisfies readonly ThresholdKey[]

/** 校准基线：当前生效阈值（ResolvedSettings 的阈值子集）。 */
export type ThresholdsInput = Pick<ResolvedSettings, ThresholdKey>

/** guard 一条记录还原出的决策输入数值。 */
export interface GuardScoreSample {
  readonly risk: 'low' | 'medium' | 'high'
  readonly riskConfidence: number
  readonly irreversibility: number
  readonly taskMatch: number
  readonly injection: number
}

/** preapprove 一条记录还原出的决策输入数值。 */
export interface PreapproveScoreSample {
  readonly scope: number
  readonly reversibility: number
  readonly injection: number
}

/** 一条阈值建议。 */
export interface ThresholdAdvice {
  readonly param: ThresholdKey
  readonly current: number
  readonly suggested: number
  /** 依据：样本数 + 方向推理（中文）。 */
  readonly basis: string
  readonly samples: number
  /** 置信与步长说明（中文，含调整代价）。 */
  readonly note: string
}

/** 无数值建议的说明项（样本不足 / 观察提示）。 */
export interface CalibrationNote {
  readonly param: string
  readonly reason: string
}

/** 一份校准报告；renderCalibration 渲染为中文文本。 */
export interface CalibrationReport {
  /** 分析窗口内的记录总数。 */
  readonly windowSize: number
  readonly counts: { readonly guard: number; readonly preapprove: number; readonly approvalLoop: number }
  /** 窗口内三类决策记录的 shadow/enforce 分布。 */
  readonly modeSplit: { readonly shadow: number; readonly enforce: number }
  /** 窗口含无 scores 的旧格式样本时为 true（精度 0.01 的回退解析）。 */
  readonly hasLegacySamples: boolean
  readonly advice: readonly ThresholdAdvice[]
  readonly insufficient: readonly CalibrationNote[]
  readonly observations: readonly CalibrationNote[]
  /** 与上一份快照的对比摘要（无历史时 undefined）；详情行由调用方渲染。 */
  readonly history?: {
    readonly previousTs: string
    readonly adopted: number
    readonly ignored: number
    /** 手动改到建议之外的条数（面板徽章防"建议消失"）。 */
    readonly manual: number
  }
  /**
   * 预批准候选工具（从 guard 影子数据推导；空 allowlist 部署下唤醒
   * "省点击"卖点的入口）。仅当 allowlist 为空或候选有新增时非空。
   */
  readonly allowlistSuggestions?: readonly AllowlistSuggestion[]
}

// ── 规则常量（全部可在一处调整）──────────────────────────────────────────

/** 建议步长：一次只挪一小步，避免一步到位的过调。 */
const STEP = 0.05
/** 常规建议的最低样本数。 */
const MIN_SAMPLES = 30
/** 危险方向（误批风险收紧）的降低门槛：危险信号早调，且收紧不放宽权限。 */
const MIN_DANGER = 10
/** ask 占比超过该比例视为「过多转人工」。 */
const ASK_HOT = 0.40
/** deny 占比超过该比例视为「拦截过敏感」。 */
const DENY_HOT = 0.15
/** friction 占比达到该比例视为「预批过紧」。 */
const FRICTION_HOT = 0.50
/** R6 重放降门产生 deny 的占比上限：只允许少量 high 从 ask 变 deny。 */
const REPLAY_DENY_CAP = 0.05
/** 建议值的活动范围。 */
const CLAMP: readonly [number, number] = [0.05, 0.95]

/** agreement 桶名（与 approval-loop 的 detail token 对齐）。 */
const BUCKETS = ['would-over-approve', 'aligned-approve', 'aligned-reject', 'friction-human-approved', 'neutral'] as const
type Bucket = (typeof BUCKETS)[number]

/** 夹取到建议值活动范围。 */
function clamp(value: number): number {
  return Math.min(CLAMP[1], Math.max(CLAMP[0], value))
}

/**
 * 方向守卫：current 越过 clamp 边界时，±STEP 会被 clamp 压回甚至反向
 * （如 current=1.0 的「收紧 +0.05」clamp 后变 0.95，实为放宽）。此时降级
 * 为观察项而非数值建议；note 的步长文字按实际差值生成，避免与数值脱节。
 */
function pushAdvice(
  advice: ThresholdAdvice[],
  observations: CalibrationNote[],
  param: ThresholdKey,
  current: number,
  tighten: boolean,
  make: (suggested: number, delta: number) => Omit<ThresholdAdvice, 'param' | 'current' | 'suggested'>,
  stallNote: string,
): void {
  const suggested = clamp(tighten ? current + STEP : current - STEP)
  const delta = suggested - current
  const moved = tighten ? delta > 0 : delta < 0
  if (!moved) {
    observations.push({ param, reason: stallNote })
    return
  }
  advice.push({ param, current, suggested, ...make(suggested, delta) })
}

/** 步长文字：按实际差值生成（如 +0.05 / -0.05）。 */
function stepText(delta: number): string {
  return delta >= 0 ? `+${delta.toFixed(2)}` : delta.toFixed(2)
}

/** 保留两位小数展示。 */
function fmt(value: number): string {
  return value.toFixed(2)
}

// ── 旧格式 detail 解析（scores 字段存在前的记录回退路径）────────────────

const GUARD_DETAIL_RE = /^risk=(low|medium|high) p=(\d+(?:\.\d+)?) irrev=(\d+(?:\.\d+)?) task=(\d+(?:\.\d+)?) inj=(\d+(?:\.\d+)?)/

/**
 * 解析旧格式 guard detail（answerDetail 生成的「risk=medium p=0.78 irrev=0.10 task=0.90 inj=0.02」）。
 * 只锚定行首：尾部新增字段不影响解析。
 */
export function parseGuardDetail(detail: string | undefined): GuardScoreSample | undefined {
  if (detail === undefined) return undefined
  const m = GUARD_DETAIL_RE.exec(detail)
  if (m === null) return undefined
  return {
    risk: m[1] as GuardScoreSample['risk'],
    riskConfidence: Number(m[2]),
    irreversibility: Number(m[3]),
    taskMatch: Number(m[4]),
    injection: Number(m[5]),
  }
}

const PREAPPROVE_DETAIL_RE = /^scope=(\d+(?:\.\d+)?) reversible=(\d+(?:\.\d+)?) inj=(\d+(?:\.\d+)?)/

/**
 * 解析旧格式 preapprove detail（「scope=0.90 reversible=0.95 inj=0.02 (reason)」）。
 * 只锚定行首、捕获组各自限定数字——human verdict 的中文 reason 后缀（含数字）不会被误吞。
 */
export function parsePreapproveDetail(detail: string | undefined): PreapproveScoreSample | undefined {
  if (detail === undefined) return undefined
  const m = PREAPPROVE_DETAIL_RE.exec(detail)
  if (m === null) return undefined
  return { scope: Number(m[1]), reversibility: Number(m[2]), injection: Number(m[3]) }
}

// ── 样本提取（scores 全精度优先，旧记录回退 detail）──────────────────────

/** scores 数值键表（与 detail token 同名；写入侧见 guard.ts / preapprove.ts）。 */
const GUARD_SCORE_KEYS = ['risk_p', 'irrev', 'task', 'inj'] as const
const PREAPPROVE_SCORE_KEYS = ['scope', 'reversible', 'inj'] as const

/** scores 里全部键都 present 且落在 [0,1] 才可用。 */
function numericScores(entry: TelemetryEntry, keys: readonly string[]): Record<string, number> | undefined {
  const scores = entry.scores
  if (scores === undefined) return undefined
  const out: Record<string, number> = {}
  for (const key of keys) {
    const v = scores[key]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return undefined
    out[key] = v
  }
  return out
}

/**
 * 提取一条 guard 记录的数值样本：scores 字段（全精度）优先、risk 选项取
 * detail 前缀；旧记录整体回退 detail 解析；都失败返回 undefined。
 */
export function guardSampleOf(entry: TelemetryEntry): GuardScoreSample | undefined {
  if (entry.tag !== 'guard' || entry.action === 'degraded') return undefined
  const scores = numericScores(entry, GUARD_SCORE_KEYS)
  if (scores !== undefined) {
    // risk 选项是字符串，不进 scores：从 detail 前缀取（answerDetail 固定格式）。
    const risk = /^risk=(low|medium|high)/.exec(entry.detail ?? '')
    if (risk !== null) {
      return {
        risk: risk[1] as GuardScoreSample['risk'],
        riskConfidence: scores['risk_p'],
        irreversibility: scores['irrev'],
        taskMatch: scores['task'],
        injection: scores['inj'],
      }
    }
  }
  return parseGuardDetail(entry.detail)
}

/** 提取一条 preapprove 记录的数值样本，回退顺序同 {@link guardSampleOf}。 */
export function preapproveSampleOf(entry: TelemetryEntry): PreapproveScoreSample | undefined {
  if (entry.tag !== 'preapprove' || entry.action === 'degraded') return undefined
  const scores = numericScores(entry, PREAPPROVE_SCORE_KEYS)
  if (scores !== undefined) {
    return { scope: scores['scope'], reversibility: scores['reversible'], injection: scores['inj'] }
  }
  return parsePreapproveDetail(entry.detail)
}

// ── 分支归类与反事实重放（与 decideGuard 同源）───────────────────────────

/** 把数值样本还原成 decideGuard 的输入形状。 */
function guardAnswersOf(sample: GuardScoreSample): GuardAnswers {
  return {
    risk: {
      type: 'choice',
      choice: sample.risk,
      probabilities: { [sample.risk]: sample.riskConfidence },
      confidence: sample.riskConfidence,
    },
    irreversible: { type: 'noul', noul: sample.irreversibility },
    matchesTask: { type: 'noul', noul: sample.taskMatch },
    injectionSuspect: { type: 'noul', noul: sample.injection },
  }
}

/** ResolvedSettings 阈值子集 → decideGuard 阈值形状。 */
function guardThresholdsOf(t: ThresholdsInput): GuardThresholds {
  return {
    confidenceMin: t.guardConfidenceMin,
    denyConfidence: t.guardDenyConfidence,
    irreversibleCeiling: t.guardIrreversibleCeiling,
    irreversibleDenyFloor: t.guardIrreversibleDenyFloor,
    injectionAskThreshold: t.guardInjectionAskThreshold,
  }
}

/**
 * ask/deny 触发分支归类（与 decideGuard 分支条件镜像，仅用于归因展示）。
 * 一致性由测试锁死：replayGuard 的动作计数必须等于逐条 decideGuard 计数。
 */
export function guardBranchOf(
  sample: GuardScoreSample,
  thresholds: GuardThresholds,
): 'injection' | 'deny' | 'high' | 'medium' | 'irreversibility' | 'delegate' {
  const answers = guardAnswersOf(sample)
  if (answers.injectionSuspect.noul >= thresholds.injectionAskThreshold) return 'injection'
  if (answers.risk.choice === 'high') {
    if (answers.risk.confidence >= thresholds.denyConfidence
      && answers.irreversible.noul >= thresholds.irreversibleDenyFloor) return 'deny'
    return 'high'
  }
  if (answers.risk.choice === 'medium') {
    if (answers.risk.confidence < thresholds.confidenceMin) return 'delegate'
    return 'medium'
  }
  if (answers.irreversible.noul >= thresholds.irreversibleCeiling) return 'irreversibility'
  return 'delegate'
}

/** 用一组阈值重放 guard 样本的动作分布（内部逐条调用 decideGuard，不重写判定）。 */
export function replayGuard(samples: readonly GuardScoreSample[], thresholds: GuardThresholds): {
  readonly actions: { delegate: number; ask: number; deny: number }
  readonly branches: { injection: number; deny: number; high: number; medium: number; irreversibility: number }
} {
  const actions = { delegate: 0, ask: 0, deny: 0 }
  const branches = { injection: 0, deny: 0, high: 0, medium: 0, irreversibility: 0 }
  for (const sample of samples) {
    const decision = decideGuard(guardAnswersOf(sample), thresholds)
    actions[decision.kind] += 1
    const branch = guardBranchOf(sample, thresholds)
    if (branch !== 'delegate') branches[branch] += 1
  }
  return { actions, branches }
}

/** 用一组阈值重放 preapprove 样本（内部逐条调用 decidePreapprove）。 */
export function replayPreapprove(samples: readonly PreapproveScoreSample[], thresholds: PreapproveThresholds): {
  readonly autoApprove: number
  readonly human: number
} {
  let autoApprove = 0
  let human = 0
  for (const sample of samples) {
    const verdict = decidePreapprove({
      withinGrantedScope: { type: 'noul', noul: sample.scope },
      reversible: { type: 'noul', noul: sample.reversibility },
      injectionSuspect: { type: 'noul', noul: sample.injection },
    }, thresholds)
    if (verdict.kind === 'auto-approve') autoApprove += 1
    else human += 1
  }
  return { autoApprove, human }
}

// ── 一致率桶提取（与 telemetry.foldInto 的 detail 匹配同法）──────────────

/** 提取一致率桶计数（approval-loop 的 detail token 匹配；历史对比与报告共用）。 */
export function approvalBucketsOf(entries: readonly TelemetryEntry[]): Record<Bucket, number> {
  const buckets = Object.fromEntries(BUCKETS.map(b => [b, 0])) as Record<Bucket, number>
  for (const entry of entries) {
    if (entry.tag !== 'approval-loop' || entry.action !== 'agreement') continue
    for (const bucket of BUCKETS) {
      if (entry.detail?.includes(bucket) === true) buckets[bucket] += 1
    }
  }
  return buckets
}

// ── allowlist 建议（唤醒沉睡的预批准：从 guard 影子数据推导可信工具）────

/** allowlist 建议的纳入门槛。 */
const ALLOWLIST_MIN_SAMPLES = 5
const ALLOWLIST_CONF_MIN = 0.85
const ALLOWLIST_IRREV_MAX = 0.15
const ALLOWLIST_INJ_MAX = 0.1

/** 一个工具的 allowlist 候选依据。 */
export interface AllowlistSuggestion {
  readonly tool: string
  readonly samples: number
  readonly avgConfidence: number
  readonly avgIrreversibility: number
  readonly maxInjection: number
}

/**
 * 从 guard 影子遥测推导预批准候选工具：某工具的全部已答调用都是
 * 「低风险 + 高置信 + 低不可逆 + 无注入嫌疑」时，它是自动批的合理候选
 * （最终生效仍经预批准自己的双 noul 证据门）。纯函数，不 IO 不调 Jev。
 * @param entries - 遥测记录窗口。
 * @returns 候选列表，按样本数降序。
 */
export function suggestAllowlist(entries: readonly TelemetryEntry[]): readonly AllowlistSuggestion[] {
  const byTool = new Map<string, { conf: number[]; irrev: number[]; inj: number[]; allLow: boolean }>()
  for (const entry of entries) {
    const sample = guardSampleOf(entry)
    if (sample === undefined) continue
    const tool = entry.tool ?? '—'
    if (sample.risk !== 'low') {
      // 任何一次非 low 的判定让该工具直接出局（自动批候选要求全历史低风险）。
      byTool.set(tool, { conf: [], irrev: [], inj: [], allLow: false })
      continue
    }
    const bucket = byTool.get(tool)
    if (bucket === undefined) {
      byTool.set(tool, { conf: [sample.riskConfidence], irrev: [sample.irreversibility], inj: [sample.injection], allLow: true })
      continue
    }
    if (bucket.allLow === false) continue
    bucket.conf.push(sample.riskConfidence)
    bucket.irrev.push(sample.irreversibility)
    bucket.inj.push(sample.injection)
  }
  const out: AllowlistSuggestion[] = []
  for (const [tool, bucket] of byTool) {
    if (!bucket.allLow || bucket.conf.length < ALLOWLIST_MIN_SAMPLES) continue
    const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length
    const avgConfidence = avg(bucket.conf)
    const avgIrreversibility = avg(bucket.irrev)
    const maxInjection = Math.max(...bucket.inj)
    if (avgConfidence < ALLOWLIST_CONF_MIN || avgIrreversibility > ALLOWLIST_IRREV_MAX || maxInjection > ALLOWLIST_INJ_MAX) continue
    out.push({ tool, samples: bucket.conf.length, avgConfidence, avgIrreversibility, maxInjection })
  }
  return out.sort((left, right) => right.samples - left.samples)
}

// ── 影子→执行的升级就绪度（开箱引导的一部分）────────────────────────────

/** shadow 数据是否足以放心切 enforce 的评估。 */
export interface ShadowReadiness {
  readonly shadowSamples: number
  readonly misApprovals: number
  readonly degradedRate: number
  readonly ready: boolean
  /** 中文理由（面板/命令共用）。 */
  readonly reason: string
}

/** 就绪度门槛。 */
const READINESS_MIN_SAMPLES = 30
const READINESS_MAX_DEGRADED_RATE = 0.3

/**
 * Assess whether shadow data supports promoting to enforce mode. Pure function.
 * @param entries - telemetry window.
 * @param locale - report language (default Chinese for legacy callers).
 */
export function assessReadiness(entries: readonly TelemetryEntry[], locale: Locale = 'zh'): ShadowReadiness {
  const t = (key: MessageKey, values?: Record<string, string | number>): string => translate(locale, key, values)
  let shadow = 0
  let degraded = 0
  let misApprovals = 0
  for (const entry of entries) {
    if (entry.mode !== 'shadow') continue
    shadow += 1
    if (entry.action === 'degraded') degraded += 1
    if (entry.tag === 'approval-loop' && entry.action === 'agreement'
      && entry.detail?.includes('would-over-approve') === true) misApprovals += 1
  }
  const degradedRate = shadow > 0 ? degraded / shadow : 0
  const reasons: string[] = []
  if (shadow < READINESS_MIN_SAMPLES) {
    reasons.push(t('msg.readinessShadowSamples', { v0: shadow, v1: READINESS_MIN_SAMPLES }))
  }
  if (misApprovals > 0) reasons.push(t('msg.readinessMisApprovals', { v0: misApprovals }))
  if (degradedRate > READINESS_MAX_DEGRADED_RATE) {
    reasons.push(t('msg.readinessDegraded', { v0: (degradedRate * 100).toFixed(0) }))
  }
  return {
    shadowSamples: shadow,
    misApprovals,
    degradedRate,
    ready: reasons.length === 0 && shadow > 0,
    reason: reasons.length === 0
      ? t('msg.readinessReady')
      : t('msg.readinessContinue', { v0: reasons.join(locale === 'zh' ? '；' : '; ') }),
  }
}

// ── 主分析 ───────────────────────────────────────────────────────────────

/**
 * Analyze telemetry and suggest thresholds without IO or Jev requests.
 * @param entries - Full telemetry window or its latest N records.
 * @param current - Active settings shared with the decision hooks.
 * @param locale - Report language; defaults to Chinese for existing CLI callers.
 * @returns Calibration advice, insufficient samples, and observations.
 */
export function calibrate(entries: readonly TelemetryEntry[], current: ThresholdsInput, locale: Locale = 'zh'): CalibrationReport {
  const t = (key: MessageKey, values?: Record<string, string | number>): string => translate(locale, key, values)
  const guardEntries = entries.filter(e => e.tag === 'guard')
  const preapproveEntries = entries.filter(e => e.tag === 'preapprove')
  const loopEntries = entries.filter(e => e.tag === 'approval-loop')
  let shadow = 0
  let enforce = 0
  for (const e of [...guardEntries, ...preapproveEntries, ...loopEntries]) {
    if (e.mode === 'shadow') shadow += 1
    else enforce += 1
  }
  const guardSamples = guardEntries.map(guardSampleOf)
  // 旧格式 = 已答调用但缺 scores 字段（detail 回退解析，数值精度 0.01）。
  const hasLegacySamples
    = guardEntries.some(e => e.scores === undefined && e.action !== 'degraded')
      || preapproveEntries.some(e => e.scores === undefined && e.action !== 'degraded')
  const guard = guardSamples.filter((s): s is GuardScoreSample => s !== undefined)

  const advice: ThresholdAdvice[] = []
  const insufficient: CalibrationNote[] = []
  const observations: CalibrationNote[] = []

  if (entries.length === 0) {
    return {
      windowSize: 0,
      counts: { guard: 0, preapprove: 0, approvalLoop: 0 },
      modeSplit: { shadow: 0, enforce: 0 },
      hasLegacySamples: false,
      advice,
      insufficient,
      observations: [{ param: '—', reason: t('calibration.noData') }],
    }
  }

  // ── preapprove：一致率桶 → 预批松紧 ─────────────────────────────────
  const buckets = approvalBucketsOf(entries)
  const bucketTotal = BUCKETS.reduce((sum, b) => sum + buckets[b], 0)
  const woap = buckets['would-over-approve']
  const friction = buckets['friction-human-approved']
  const alignedApprove = buckets['aligned-approve']
  // 预批降级计数：全是 degraded 时是钩子/provider 故障，不是 allowlist 配置问题。
  const preapproveDegraded = preapproveEntries.filter(e => e.action === 'degraded').length
  if (bucketTotal > 0) {
    if (woap > 0) {
      // R1 危险方向：Jev 想批但人拒了至少一次。早调（桶总数≥10 即给建议）、只收紧。
      if (bucketTotal >= MIN_DANGER) {
        pushAdvice(advice, observations, 'preapproveAutoApproveMin', current.preapproveAutoApproveMin, true,
          (_suggested, delta) => ({
            basis: t('calibration.overApprovalBasis', { v0: woap, v1: bucketTotal }),
            samples: bucketTotal,
            note: t('calibration.tightenPreapproval', { v0: stepText(delta), v1: MIN_DANGER }),
          }),
          t('calibration.preapprovalUpperBound', { v0: fmt(CLAMP[1]) }))
      } else {
        insufficient.push({
          param: 'preapproveAutoApproveMin',
          reason: t('calibration.overApprovalSamples', { v0: woap, v1: bucketTotal, v2: MIN_DANGER }),
        })
      }
    } else if (friction + alignedApprove >= MIN_SAMPLES && friction / (friction + alignedApprove) >= FRICTION_HOT) {
      // R2 放松方向：零误批 + 足样本 + friction 占比高，才允许降门槛。
      pushAdvice(advice, observations, 'preapproveAutoApproveMin', current.preapproveAutoApproveMin, false,
        (_suggested, delta) => ({
          basis: t('calibration.frictionBasis', { v0: friction, v1: (friction / (friction + alignedApprove) * 100).toFixed(0) }),
          samples: friction + alignedApprove,
          note: t('calibration.relaxPreapproval', { v0: stepText(delta) }),
        }),
        t('calibration.preapprovalLowerBound', { v0: fmt(CLAMP[0]) }))
    } else if (friction > 0) {
      observations.push({
        param: 'preapproveAutoApproveMin',
        reason: t('calibration.frictionSamples', { v0: friction, v1: MIN_SAMPLES, v2: FRICTION_HOT * 100 }),
      })
    }
  } else if (preapproveDegraded > 0) {
    observations.push({
      param: 'preapprove*',
      reason: t('calibration.preapprovalDegraded', { v0: preapproveDegraded }),
    })
  } else if (preapproveEntries.length === 0) {
    observations.push({
      param: 'preapprove*',
      reason: t('calibration.preapprovalNoSamples'),
    })
  }

  // ── guard：动作分布 → 风险门松紧 ───────────────────────────────────
  if (guard.length >= MIN_SAMPLES) {
    const replay = replayGuard(guard, guardThresholdsOf(current))
    const askTotal = replay.actions.ask
    const denyTotal = replay.actions.deny
    if (denyTotal > guard.length * DENY_HOT) {
      // R5 拦截过敏感：deny 占比过高。
      pushAdvice(advice, observations, 'guardDenyConfidence', current.guardDenyConfidence, true,
        (_suggested, delta) => ({
          basis: t('calibration.denyBasis', { v0: denyTotal, v1: guard.length, v2: DENY_HOT * 100 }),
          samples: guard.length,
          note: t('calibration.raiseDeny', { v0: stepText(delta) }),
        }),
        t('calibration.denyUpperBound', { v0: fmt(CLAMP[1]) }))
    } else if (denyTotal === 0) {
      // R6 风险门 0 deny：high 样本存在但都落在 ask——重放降门看能否产生少量 deny。
      const highCount = guard.filter(s => s.risk === 'high').length
      if (highCount >= 5) {
        const lowerDenyConfidence = replayGuard(guard, { ...guardThresholdsOf(current), denyConfidence: clamp(current.guardDenyConfidence - STEP) })
        const lowerFloor = replayGuard(guard, { ...guardThresholdsOf(current), irreversibleDenyFloor: clamp(current.guardIrreversibleDenyFloor - STEP) })
        const pick: { param: ThresholdKey; replay: ReturnType<typeof replayGuard> } | undefined
          = lowerDenyConfidence.actions.deny > 0 && lowerDenyConfidence.actions.deny <= guard.length * REPLAY_DENY_CAP
            ? { param: 'guardDenyConfidence', replay: lowerDenyConfidence }
            : lowerFloor.actions.deny > 0 && lowerFloor.actions.deny <= guard.length * REPLAY_DENY_CAP
              ? { param: 'guardIrreversibleDenyFloor', replay: lowerFloor }
              : undefined
        if (pick !== undefined) {
          const param = pick.param
          const from = param === 'guardDenyConfidence' ? current.guardDenyConfidence : current.guardIrreversibleDenyFloor
          pushAdvice(advice, observations, param, from, false,
            (_suggested, delta) => ({
              basis: t('calibration.replayBasis', { v0: highCount, v1: pick.replay.actions.deny, v2: REPLAY_DENY_CAP * 100 }),
              samples: guard.length,
              note: t('calibration.lowerDeny', { v0: stepText(delta) }),
            }),
            t('calibration.denyLowerBound', { v0: param, v1: fmt(CLAMP[0]) }))
        } else {
          observations.push({
            param: 'guardDenyConfidence / guardIrreversibleDenyFloor',
            reason: t('calibration.replayNoChange', { v0: highCount, v1: REPLAY_DENY_CAP * 100 }),
          })
        }
      } else {
        observations.push({
          param: 'guardDenyConfidence',
          reason: t('calibration.highRiskSamples', { v0: highCount }),
        })
      }
    }
    if (askTotal > guard.length * ASK_HOT) {
      // ask 过多：按触发分支归因，占过半的分支决定收紧哪个门槛。
      const branchTotal = askTotal
      const branches = replay.branches
      if (branches.medium >= branchTotal / 2) {
        // R3 中风险升级过多。
        pushAdvice(advice, observations, 'guardConfidenceMin', current.guardConfidenceMin, true,
          (_suggested, delta) => ({
            basis: t('calibration.mediumRiskBasis', { v0: askTotal, v1: guard.length, v2: ASK_HOT * 100, v3: branches.medium }),
            samples: guard.length,
            note: t('calibration.raiseConfidence', { v0: stepText(delta) }),
          }),
          t('calibration.confidenceUpperBound', { v0: fmt(CLAMP[1]) }))
      } else if (branches.irreversibility >= branchTotal / 2) {
        // R4 低风险不可逆升级过多。
        pushAdvice(advice, observations, 'guardIrreversibleCeiling', current.guardIrreversibleCeiling, true,
          (_suggested, delta) => ({
            basis: t('calibration.irreversibleBasis', { v0: askTotal, v1: guard.length, v2: ASK_HOT * 100, v3: branches.irreversibility }),
            samples: guard.length,
            note: t('calibration.raiseCeiling', { v0: stepText(delta) }),
          }),
          t('calibration.ceilingUpperBound', { v0: fmt(CLAMP[1]) }))
      } else if (branches.injection >= branchTotal / 2) {
        // 注入嫌疑占过半：注入防线只观察不给数值建议（不放松），单独归因。
        observations.push({
          param: 'guardInjectionAskThreshold / preapproveInjectionSuspectMax',
          reason: t('calibration.injectionDominant', { v0: askTotal, v1: guard.length, v2: branches.injection }),
        })
      } else {
        observations.push({
          param: 'guardConfidenceMin / guardIrreversibleCeiling',
          reason: t('calibration.mixedTriggers', { v0: askTotal, v1: guard.length, v2: branches.medium, v3: branches.irreversibility, v4: branches.high, v5: branches.injection }),
        })
      }
    }
    if (replay.actions.delegate === guard.length) {
      observations.push({
        param: 'guard*',
        reason: t('calibration.allDelegated', { v0: guard.length }),
      })
    }
    const injectionBranch = replay.branches.injection
    if (injectionBranch > 0) {
      observations.push({
        param: 'guardInjectionAskThreshold / preapproveInjectionSuspectMax',
        reason: t('calibration.injectionObservation', { v0: injectionBranch }),
      })
    }
  } else {
    insufficient.push({
      param: 'guard*',
      reason: t('calibration.guardSamples', { v0: guard.length, v1: MIN_SAMPLES }),
    })
  }

  // ── 模式混合提示 ───────────────────────────────────────────────────
  if (shadow > 0 && enforce > 0) {
    observations.push({
      param: '—',
      reason: t('calibration.mixedModes', { v0: shadow, v1: enforce }),
    })
  }
  if (hasLegacySamples) {
    observations.push({
      param: '—',
      reason: t('calibration.legacyRecords'),
    })
  }

  return {
    windowSize: entries.length,
    counts: { guard: guardEntries.length, preapprove: preapproveEntries.length, approvalLoop: loopEntries.length },
    modeSplit: { shadow, enforce },
    hasLegacySamples,
    advice,
    insufficient,
    observations,
  }
}

// ── 渲染 ────────────────────────────────────────────────────────────────

const PARAM_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  guardConfidenceMin: 'msg.paramGuardConfidenceMin',
  guardDenyConfidence: 'msg.paramGuardDenyConfidence',
  guardIrreversibleCeiling: 'msg.paramGuardIrreversibleCeiling',
  guardIrreversibleDenyFloor: 'msg.paramGuardIrreversibleDenyFloor',
  guardInjectionAskThreshold: 'msg.paramGuardInjectionAskThreshold',
  preapproveAutoApproveMin: 'msg.paramPreapproveAutoApproveMin',
  preapproveIrreversibleMax: 'msg.paramPreapproveIrreversibleMax',
  preapproveInjectionSuspectMax: 'msg.paramPreapproveInjectionSuspectMax',
}

/** Width punctuation after a parameter label: full-width in Chinese, ASCII elsewhere. */
function paramSeparator(locale: Locale): string {
  return locale === 'zh' ? '：' : ': '
}

/**
 * Render the calibration report (fenced, styled like Telemetry.stats).
 * @param report - calibrate output.
 * @param extras - extra lines (e.g. history comparison) inserted before the footer.
 * @param locale - report language (default Chinese for legacy callers).
 * @returns a chat-friendly plain-text report.
 */
export function renderCalibration(report: CalibrationReport, extras: readonly string[] = [], locale: Locale = 'zh'): string {
  const t = (key: MessageKey, values?: Record<string, string | number>): string => translate(locale, key, values)
  const paramLabel = (param: string): string => {
    const key = PARAM_LABEL_KEYS[param]
    return key === undefined ? param : t(key)
  }
  const lines: string[] = ['```']
  lines.push(t('msg.calibTitle'))
  lines.push('')
  lines.push(t('msg.calibWindow', {
    v0: report.windowSize,
    v1: report.counts.guard,
    v2: report.counts.preapprove,
    v3: report.counts.approvalLoop,
    v4: report.modeSplit.shadow,
    v5: report.modeSplit.enforce,
  }))
  lines.push(t('msg.calibBaseline'))
  if (report.advice.length === 0 && report.insufficient.length === 0 && report.observations.length === 1 && report.windowSize === 0) {
    lines.push('')
    lines.push(`  ${report.observations[0].reason}`)
    lines.push('```')
    return lines.join('\n')
  }
  if (report.advice.length > 0) {
    lines.push('')
    lines.push(t('msg.calibAdviceTitle', { v0: report.advice.length }))
    for (const a of report.advice) {
      lines.push(t('msg.calibParam', { v0: paramLabel(a.param), v1: a.param }))
      lines.push(`     ${fmt(a.current)} → ${fmt(a.suggested)}`)
      lines.push(t('msg.calibBasis', { v0: a.basis }))
      lines.push(t('msg.calibNote', { v0: a.note }))
    }
  }
  if (report.insufficient.length > 0) {
    lines.push('')
    lines.push(t('msg.calibInsufficientTitle'))
    for (const n of report.insufficient) {
      lines.push(`   ${paramLabel(n.param)}${paramSeparator(locale)}${n.reason}`)
    }
  }
  if (report.observations.length > 0) {
    lines.push('')
    lines.push(t('msg.calibObservationTitle'))
    for (const n of report.observations) {
      const label = n.param === '—' ? '' : `${paramLabel(n.param)}${paramSeparator(locale)}`
      lines.push(`   ${label}${n.reason}`)
    }
  }
  if (extras.length > 0) {
    lines.push('')
    lines.push(...extras)
  }
  lines.push('━'.repeat(44))
  lines.push(t('msg.calibFooter'))
  lines.push('```')
  return lines.join('\n')
}
