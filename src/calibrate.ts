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

function approvalBucketsOf(entries: readonly TelemetryEntry[]): Record<Bucket, number> {
  const buckets = Object.fromEntries(BUCKETS.map(b => [b, 0])) as Record<Bucket, number>
  for (const entry of entries) {
    if (entry.tag !== 'approval-loop' || entry.action !== 'agreement') continue
    for (const bucket of BUCKETS) {
      if (entry.detail?.includes(bucket) === true) buckets[bucket] += 1
    }
  }
  return buckets
}

// ── 主分析 ───────────────────────────────────────────────────────────────

/**
 * 分析影子遥测，产出阈值建议报告。纯函数：不 IO、不调 Jev、永不抛。
 * @param entries - 遥测记录窗口（全量或尾部 N 条）。
 * @param current - 当前生效阈值（与四个挂点同一 settings 快照）。
 * @returns 校准报告。
 */
export function calibrate(entries: readonly TelemetryEntry[], current: ThresholdsInput): CalibrationReport {
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
      observations: [{ param: '—', reason: '暂无数据：先 /jev-on 启用插件跑一段会话，再回来校准' }],
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
            basis: `误批风险 ${woap} 次（Jev 想自动批、人拒绝）/ 一致率样本 ${bucketTotal} 条`,
            samples: bucketTotal,
            note: `收紧自动批门槛（${stepText(delta)}），减少误批；代价是多一些人工确认。已出现危险信号，≥${MIN_DANGER} 条样本即建议（收紧方向永不放宽权限）`,
          }),
          `preapproveAutoApproveMin 已达收紧建议上限 ${fmt(CLAMP[1])}：误批信号仍存续，应收窄 preapproveToolAllowlist 或关闭 preapproveEnabled，而非继续抬门`)
      } else {
        insufficient.push({
          param: 'preapproveAutoApproveMin',
          reason: `已出现误批风险信号（${woap} 次）但一致率样本仅 ${bucketTotal} 条（< ${MIN_DANGER}），继续观察`,
        })
      }
    } else if (friction + alignedApprove >= MIN_SAMPLES && friction / (friction + alignedApprove) >= FRICTION_HOT) {
      // R2 放松方向：零误批 + 足样本 + friction 占比高，才允许降门槛。
      pushAdvice(advice, observations, 'preapproveAutoApproveMin', current.preapproveAutoApproveMin, false,
        (_suggested, delta) => ({
          basis: `零误批，且 ${friction} 次转人工后人类全部放行（占放行类 ${(friction / (friction + alignedApprove) * 100).toFixed(0)}%）`,
          samples: friction + alignedApprove,
          note: `放松自动批门槛（${stepText(delta)}）减少多余人工确认；前提是零误批，一旦再次出现误批信号立即回调`,
        }),
        `preapproveAutoApproveMin 已达放松建议下限 ${fmt(CLAMP[0])}：friction 仍高时检查预批问题面，而非继续降门`)
    } else if (friction > 0) {
      observations.push({
        param: 'preapproveAutoApproveMin',
        reason: `friction（Jev 转人工、人放行）${friction} 次但样本不足 ${MIN_SAMPLES} 或占比未达 ${FRICTION_HOT * 100}%，暂不建议放松`,
      })
    }
  } else if (preapproveDegraded > 0) {
    observations.push({
      param: 'preapprove*',
      reason: `预批 ${preapproveDegraded} 条全部降级（多为 answer-shape-mismatch）：Jev 应答持续不可解析，预批实际失效——先排查 provider/应答格式（/jev-log 看 detail），而非 allowlist 配置`,
    })
  } else if (preapproveEntries.length === 0) {
    observations.push({
      param: 'preapprove*',
      reason: '预批无样本：preapproveToolAllowlist 为空时不产生自动批评估，一致率桶也随之为空',
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
          basis: `deny ${denyTotal}/${guard.length} 次（>${DENY_HOT * 100}%），拦截占比偏高`,
          samples: guard.length,
          note: `提高硬拦截门槛（${stepText(delta)}），让更多高风险走人工确认而非直接拦；代价是少量不可逆调用少了一道硬闸`,
        }),
        `guardDenyConfidence 已达收紧建议上限 ${fmt(CLAMP[1])}：deny 仍过热，考虑检查 excludeTools/readOnlyTools 覆盖面或 guardEnable 本身`)
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
              basis: `0 次 deny、high 风险样本 ${highCount} 个全部走人工；反事实重放降门后会产生 ${pick.replay.actions.deny} 次 deny（≤${REPLAY_DENY_CAP * 100}% 上限内）`,
              samples: guard.length,
              note: `下调硬拦截门槛（${stepText(delta)}）让明确的高风险不可逆调用被直接拦下，减少审批疲劳；人工确认仍兜底其余高风险`,
            }),
            `${param} 已达放松建议下限 ${fmt(CLAMP[0])}：0 deny 且 high 样本仍在，考虑收窄依赖人工确认的范围或检查工具面风险构成`)
        } else {
          observations.push({
            param: 'guardDenyConfidence / guardIrreversibleDenyFloor',
            reason: `0 次 deny、high 样本 ${highCount} 个，但反事实重放降门仍不产生 deny（或超过 ${REPLAY_DENY_CAP * 100}% 上限）——维持现状`,
          })
        }
      } else {
        observations.push({
          param: 'guardDenyConfidence',
          reason: `0 次 deny 且 high 样本仅 ${highCount} 个（<5）：可能工具面确实低危，或 excludeTools/readOnlyTools 覆盖过宽，先检查覆盖面`,
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
            basis: `ask ${askTotal}/${guard.length} 次（>${ASK_HOT * 100}%），其中中风险升级 ${branches.medium} 次占过半`,
            samples: guard.length,
            note: `提高中风险升级的置信门槛（${stepText(delta)}），减少转人工；代价是置信度偏低的中风险调用会直接放行`,
          }),
          `guardConfidenceMin 已达收紧建议上限 ${fmt(CLAMP[1])}：中风险升级仍过热，考虑扩大 readOnlyTools 或检查任务面是否天然中危`)
      } else if (branches.irreversibility >= branchTotal / 2) {
        // R4 低风险不可逆升级过多。
        pushAdvice(advice, observations, 'guardIrreversibleCeiling', current.guardIrreversibleCeiling, true,
          (_suggested, delta) => ({
            basis: `ask ${askTotal}/${guard.length} 次（>${ASK_HOT * 100}%），其中低风险不可逆 ${branches.irreversibility} 次占过半`,
            samples: guard.length,
            note: `提高不可逆升级上限（${stepText(delta)}），容忍更高的「可能不可逆」概率；代价是少量实际不可逆的低风险调用不再升级`,
          }),
          `guardIrreversibleCeiling 已达收紧建议上限 ${fmt(CLAMP[1])}：低风险不可逆升级仍过热，考虑检查工具面是否天然不可逆`)
      } else if (branches.injection >= branchTotal / 2) {
        // 注入嫌疑占过半：注入防线只观察不给数值建议（不放松），单独归因。
        observations.push({
          param: 'guardInjectionAskThreshold / preapproveInjectionSuspectMax',
          reason: `ask ${askTotal}/${guard.length} 次偏高，过半来自注入嫌疑升级（${branches.injection} 次）——注入防线参数只观察不给数值建议，当前阈值继续有效`,
        })
      } else {
        observations.push({
          param: 'guardConfidenceMin / guardIrreversibleCeiling',
          reason: `ask ${askTotal}/${guard.length} 次偏高，但触发分散（中风险 ${branches.medium}、低风险不可逆 ${branches.irreversibility}、高风险 ${branches.high}、注入 ${branches.injection}），无单一过半分支`,
        })
      }
    }
    if (replay.actions.delegate === guard.length) {
      observations.push({
        param: 'guard*',
        reason: `${guard.length} 条样本全部 delegate：风险门形同虚设——要么会话确实全低危，要么 readOnlyTools/excludeTools 覆盖过宽，检查后再判断`,
      })
    }
    const injectionBranch = replay.branches.injection
    if (injectionBranch > 0) {
      observations.push({
        param: 'guardInjectionAskThreshold / preapproveInjectionSuspectMax',
        reason: `窗口内 ${injectionBranch} 次注入嫌疑升级——注入防线参数只观察不给数值建议（防线不放松），当前值继续有效`,
      })
    }
  } else {
    insufficient.push({
      param: 'guard*',
      reason: `guard 样本 ${guard.length} 条（< ${MIN_SAMPLES}），不足以给风险门建议`,
    })
  }

  // ── 模式混合提示 ───────────────────────────────────────────────────
  if (shadow > 0 && enforce > 0) {
    observations.push({
      param: '—',
      reason: `窗口混合 shadow（${shadow}）与 enforce（${enforce}）记录：enforce 期自动批过的调用不进一致率桶，切换阈值前建议重跑一段 shadow`,
    })
  }
  if (hasLegacySamples) {
    observations.push({
      param: '—',
      reason: '窗口含旧格式记录（无 scores 字段，回退 detail 解析，数值精度 0.01）',
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

const PARAM_LABELS: Readonly<Record<string, string>> = {
  guardConfidenceMin: '中风险升级置信门',
  guardDenyConfidence: '硬拦截置信门',
  guardIrreversibleCeiling: '不可逆升级上限',
  guardIrreversibleDenyFloor: '硬拦截不可逆底线',
  guardInjectionAskThreshold: '注入升级阈值',
  preapproveAutoApproveMin: '自动批置信门',
  preapproveIrreversibleMax: '自动批不可逆上限',
  preapproveInjectionSuspectMax: '自动批注入上限',
}

/**
 * 渲染中文报告文本（自带 ``` 代码块包裹，风格与 Telemetry.stats 一致）。
 * @param report - calibrate 的输出。
 * @returns 聊天友好的纯文本报告。
 */
export function renderCalibration(report: CalibrationReport): string {
  const lines: string[] = ['```']
  lines.push('🎯 dsh-jev-interceptor 阈值校准')
  lines.push('')
  lines.push(`窗口 ${report.windowSize} 条（guard ${report.counts.guard} │ preapprove ${report.counts.preapprove} │ 一致率 ${report.counts.approvalLoop}）`
    + ` 模式 shadow ${report.modeSplit.shadow} / enforce ${report.modeSplit.enforce}`)
  lines.push(`基线：本进程已加载配置（阈值与挂点同源）`)
  if (report.advice.length === 0 && report.insufficient.length === 0 && report.observations.length === 1 && report.windowSize === 0) {
    lines.push('')
    lines.push(`  ${report.observations[0].reason}`)
    lines.push('```')
    return lines.join('\n')
  }
  if (report.advice.length > 0) {
    lines.push('')
    lines.push(`💡 建议调整（${report.advice.length} 项）`)
    for (const a of report.advice) {
      lines.push(`   ${PARAM_LABELS[a.param] ?? a.param}（${a.param}）`)
      lines.push(`     ${fmt(a.current)} → ${fmt(a.suggested)}`)
      lines.push(`     依据：${a.basis}`)
      lines.push(`     说明：${a.note}`)
    }
  }
  if (report.insufficient.length > 0) {
    lines.push('')
    lines.push(`📊 样本不足（不建议调整）`)
    for (const n of report.insufficient) {
      lines.push(`   ${PARAM_LABELS[n.param] ?? n.param}：${n.reason}`)
    }
  }
  if (report.observations.length > 0) {
    lines.push('')
    lines.push('🔍 观察（无建议）')
    for (const n of report.observations) {
      const label = n.param === '—' ? '' : `${PARAM_LABELS[n.param] ?? n.param}：`
      lines.push(`   ${label}${n.reason}`)
    }
  }
  lines.push('━'.repeat(44))
  lines.push('📌 本报告不自动应用。请人工确认后把建议值复制到')
  lines.push('   cordis.patch.yml 的 jev-interceptor 配置行（或 Settings → Plugins')
  lines.push('   表单），保存后生效。下次 /jev-calibrate 将以新阈值重新评估。')
  lines.push('```')
  return lines.join('\n')
}
