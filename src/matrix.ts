/**
 * The guard decision matrix: maps one Jev answer set to a pre-execute action.
 * Pure logic with no dsh or network dependencies.
 *
 * Safety invariants baked into the matrix:
 * - the matrix never emits `allow`; "no objection" is expressed as `delegate`,
 *   which the listener turns into `next()` so downstream listeners (external
 *   hooks, auto-review) keep their veto;
 * - `high` risk never delegates, whatever its confidence — at minimum it
 *   escalates to a human;
 * - low confidence never acts, it delegates (stock behavior);
 * - a suspected prompt injection in the tool input escalates even when the
 *   risk questions came back low.
 * @module dsh-jev-interceptor/matrix
 */

import type { ChoiceAnswer, NoulAnswer } from './types.js'

/** The Jev answers the guard questions produce. */
export interface GuardAnswers {
  readonly risk: ChoiceAnswer
  readonly irreversible: NoulAnswer
  readonly matchesTask: NoulAnswer
  readonly injectionSuspect: NoulAnswer
}

/** Tunable thresholds consumed by {@link decideGuard}. */
export interface GuardThresholds {
  /** Minimum risk-answer confidence to act on a medium/low classification. */
  readonly confidenceMin: number
  /** Minimum confidence for a `high` classification to hard-deny instead of asking. */
  readonly denyConfidence: number
  /** A `low` call with irreversibility at or above this ceiling escalates. */
  readonly irreversibleCeiling: number
  /** Irreversibility required (with high risk + confidence) to deny. */
  readonly irreversibleDenyFloor: number
  /** Injection probability at or above which the call escalates regardless of risk. */
  readonly injectionAskThreshold: number
}

/** One resolved guard action; `delegate` maps to `next()` in the listener. */
export type GuardAction =
  | { readonly kind: 'delegate' }
  | { readonly kind: 'ask'; readonly reason: string }
  | { readonly kind: 'deny'; readonly reason: string }

/** Format one probability for a human-readable reason string. */
function p(value: number): string {
  return value.toFixed(2)
}

/**
 * 把一组已校验的 guard 答案压成用户可读的证据摘要。
 *
 * 该摘要同时服务三个面：审批卡标题（ask reason）、工具错误行（deny reason）
 * 与遥测 detail 的快速人读。格式与 guard 的 answerDetail token 对齐
 * （risk/irrev/task/inj），保持 ASCII 数值 token 可机读。
 * @param answers - 四个 guard 问题的已校验答案。
 * @returns 形如 `risk=medium 0.72 · irrev=0.30 · inj=0.01` 的摘要；
 *   matchesTask.noul < 0.5（不利证据）时追加 ` · task=0.12`。
 */
export function guardEvidence(answers: GuardAnswers): string {
  const { risk, irreversible, matchesTask, injectionSuspect } = answers
  const parts = [
    `risk=${risk.choice} ${p(risk.probabilities[risk.choice] ?? risk.confidence)}`,
    `irrev=${p(irreversible.noul)}`,
    `inj=${p(injectionSuspect.noul)}`,
  ]
  if (matchesTask.noul < 0.5) parts.push(`task=${p(matchesTask.noul)}`)
  return parts.join(' · ')
}

/**
 * Resolve one answer set into a guard action.
 * @param answers - validated Jev answers for the four guard questions.
 * @param thresholds - configured decision thresholds.
 * @returns the action the pre-execute listener takes.
 */
export function decideGuard(answers: GuardAnswers, thresholds: GuardThresholds): GuardAction {
  const { risk, irreversible, injectionSuspect } = answers
  // 证据摘要统一附在中文结论后；reason 行首的 `jev-guard:` 前缀是安全协议
  // （preapprove 靠它识别并跳过本插件的升级，绝不自动批 guard 的 ask），不可移除。
  const evidence = guardEvidence(answers)
  if (injectionSuspect.noul >= thresholds.injectionAskThreshold) {
    return {
      kind: 'ask',
      reason: `jev-guard: 工具输入疑似提示注入，升级人工确认（${evidence}）`,
    }
  }
  if (risk.choice === 'high') {
    if (risk.confidence >= thresholds.denyConfidence && irreversible.noul >= thresholds.irreversibleDenyFloor) {
      return {
        kind: 'deny',
        reason: `jev-guard: 高风险且不可逆，已拦截（${evidence}）`,
      }
    }
    return {
      kind: 'ask',
      reason: `jev-guard: 高风险调用，需人工确认（${evidence}）`,
    }
  }
  if (risk.choice === 'medium') {
    if (risk.confidence < thresholds.confidenceMin) return { kind: 'delegate' }
    return {
      kind: 'ask',
      reason: `jev-guard: 中风险调用，需人工确认（${evidence}）`,
    }
  }
  // risk.choice === 'low': low confidence never acts either — it delegates to
  // stock behavior rather than escalating on a guess. Only NEW adverse
  // evidence (irreversibility) escalates a low-risk classification.
  if (irreversible.noul >= thresholds.irreversibleCeiling) {
    return {
      kind: 'ask',
      reason: `jev-guard: 风险低但可能不可逆，需人工确认（${evidence}）`,
    }
  }
  return { kind: 'delegate' }
}

/** The Jev answers the pre-approval questions produce. */
export interface PreapproveAnswers {
  readonly withinGrantedScope: NoulAnswer
  readonly reversible: NoulAnswer
  readonly injectionSuspect: NoulAnswer
}/** Tunable thresholds consumed by {@link decidePreapprove}. */
export interface PreapproveThresholds {
  /** Minimum confidence on scope/reversibility to auto-approve. */
  readonly autoApproveMin: number
  /** Irreversibility at or above this level blocks auto-approval. */
  readonly irreversibleMax: number
  /** Injection suspicion at or above this level blocks auto-approval. */
  readonly injectionSuspectMax: number
}

/** One resolved pre-approval verdict. */
export type PreapproveVerdict =
  | { readonly kind: 'auto-approve' }
  | { readonly kind: 'human'; readonly reason: string }

/**
 * Resolve one answer set into a pre-approval verdict.
 * @param answers - validated Jev answers for the two pre-approval questions.
 * @param thresholds - configured decision thresholds.
 * @returns `auto-approve` only when both questions are confident and the call is reversible.
 */
export function decidePreapprove(
  answers: PreapproveAnswers,
  thresholds: PreapproveThresholds,
): PreapproveVerdict {
  const { withinGrantedScope, reversible, injectionSuspect } = answers
  // human reason 面向审批审计（落遥测 detail 后缀）；中文 + ASCII 数值 token，与 guard reason 同风格。
  if (injectionSuspect.noul >= thresholds.injectionSuspectMax) {
    return { kind: 'human', reason: `注入疑似 ${p(injectionSuspect.noul)} 达到阈值 ${thresholds.injectionSuspectMax}` }
  }
  if (withinGrantedScope.noul < thresholds.autoApproveMin) {
    return { kind: 'human', reason: `范围置信度 ${p(withinGrantedScope.noul)} 低于 ${thresholds.autoApproveMin}` }
  }
  if (reversible.noul < thresholds.autoApproveMin) {
    return { kind: 'human', reason: `可逆置信度 ${p(reversible.noul)} 低于 ${thresholds.autoApproveMin}` }
  }
  if (1 - reversible.noul >= thresholds.irreversibleMax) {
    return { kind: 'human', reason: `不可逆度 ${p(1 - reversible.noul)} 达到阈值 ${thresholds.irreversibleMax}` }
  }
  return { kind: 'auto-approve' }
}

/** The Jev answers the stagnation questions produce. */
export interface StagnationAnswers {
  readonly noProgress: NoulAnswer
  readonly similarFailure: NoulAnswer
}

/**
 * Resolve one stagnation answer set into a verdict.
 *
 * 双 noul 都要过置信门才提醒（换参数失败可能是正常的逐步排错，单边证据
 * 不足以打断）；任一边低置信即跳过——提醒是干预性动作，宁可漏报不误报。
 * @param answers - validated Jev answers for the two stagnation questions.
 * @param confidenceMin - both answers must reach this probability to alert.
 * @returns `alert`（注入提醒）或 `skip`（只记遥测）。
 */
export function decideStagnation(answers: StagnationAnswers, confidenceMin: number): 'alert' | 'skip' {
  if (answers.noProgress.noul >= confidenceMin && answers.similarFailure.noul >= confidenceMin) return 'alert'
  return 'skip'
}
