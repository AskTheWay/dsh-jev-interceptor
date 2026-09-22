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
 * Resolve one answer set into a guard action.
 * @param answers - validated Jev answers for the four guard questions.
 * @param thresholds - configured decision thresholds.
 * @returns the action the pre-execute listener takes.
 */
export function decideGuard(answers: GuardAnswers, thresholds: GuardThresholds): GuardAction {
  const { risk, irreversible, injectionSuspect } = answers
  if (injectionSuspect.noul >= thresholds.injectionAskThreshold) {
    return {
      kind: 'ask',
      reason: `jev-guard: possible prompt injection in tool input (p=${p(injectionSuspect.noul)})`,
    }
  }
  if (risk.choice === 'high') {
    if (risk.confidence >= thresholds.denyConfidence && irreversible.noul >= thresholds.irreversibleDenyFloor) {
      return {
        kind: 'deny',
        reason: `jev-guard: high-risk tool call (p=${p(risk.probabilities['high'] ?? risk.confidence)}, irreversible=${p(irreversible.noul)})`,
      }
    }
    return {
      kind: 'ask',
      reason: `jev-guard: high-risk classification (p=${p(risk.probabilities['high'] ?? risk.confidence)}) needs human confirmation`,
    }
  }
  if (risk.choice === 'medium') {
    if (risk.confidence < thresholds.confidenceMin) return { kind: 'delegate' }
    return {
      kind: 'ask',
      reason: `jev-guard: medium-risk tool call (p=${p(risk.probabilities['medium'] ?? risk.confidence)})`,
    }
  }
  // risk.choice === 'low'
  if (risk.confidence >= thresholds.confidenceMin && irreversible.noul < thresholds.irreversibleCeiling) {
    return { kind: 'delegate' }
  }
  return {
    kind: 'ask',
    reason: `jev-guard: low risk but ${irreversible.noul >= thresholds.irreversibleCeiling ? 'possibly irreversible' : 'low-confidence'} (p=${p(risk.confidence)})`,
  }
}

/** The Jev answers the pre-approval questions produce. */
export interface PreapproveAnswers {
  readonly withinGrantedScope: NoulAnswer
  readonly reversible: NoulAnswer
}

/** Tunable thresholds consumed by {@link decidePreapprove}. */
export interface PreapproveThresholds {
  /** Minimum confidence on BOTH questions to auto-approve. */
  readonly autoApproveMin: number
  /** Irreversibility at or above this level blocks auto-approval. */
  readonly irreversibleMax: number
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
  const { withinGrantedScope, reversible } = answers
  if (withinGrantedScope.noul < thresholds.autoApproveMin) {
    return { kind: 'human', reason: `scope confidence ${p(withinGrantedScope.noul)} below ${thresholds.autoApproveMin}` }
  }
  if (reversible.noul < thresholds.autoApproveMin) {
    return { kind: 'human', reason: `reversibility confidence ${p(reversible.noul)} below ${thresholds.autoApproveMin}` }
  }
  if (1 - reversible.noul >= thresholds.irreversibleMax) {
    return { kind: 'human', reason: `irreversibility ${p(1 - reversible.noul)} at or above ${thresholds.irreversibleMax}` }
  }
  return { kind: 'auto-approve' }
}
