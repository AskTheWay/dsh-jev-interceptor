/**
 * The approval data loop: correlates durable `approval/asked` /
 * `approval/decided` audit events with the pre-approver's Jey verdicts, so
 * shadow mode accumulates the one dataset that matters before promoting to
 * enforce — "what did Jev want, and what did the human actually decide".
 *
 * The headline metric is the false-approve rate: asks where Jev would have
 * auto-approved (`auto-approve`) but the human rejected. Its mirror is
 * friction: Jev said human-only and the human approved anyway. Both land in
 * telemetry as `approval-loop` entries; `/jev-stats` aggregates them.
 *
 * Correlation keys: asks carry a unique `id` plus the `callId` the
 * pre-approver sees; a verdict attaches to the most recent unanswered ask of
 * that (session, callId) pair — escalation can ask the same call twice, and
 * only the open ask can receive the outcome.
 * @module dsh-jev-interceptor/approval-loop
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Telemetry } from './telemetry.js'

/** What the pre-approver concluded for one ask. */
export type JevVerdict = 'auto-approve' | 'human' | 'not-evaluated'

/** One correlation record produced when the outcome lands. */
export interface ApprovalAgreement {
  readonly tool: string
  readonly sessionId: string
  readonly jev: JevVerdict
  readonly human: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
  /** Coarse bucket for quick scanning in telemetry. */
  readonly bucket:
    | 'would-over-approve'
    | 'aligned-approve'
    | 'aligned-reject'
    | 'friction-human-approved'
    | 'neutral'
}

/** Correlation state for in-flight approval asks. */
export class ApprovalTrace {
  private readonly asks = new Map<string, { tool: string; sessionId: string; callId?: string; verdict?: JevVerdict }>()
  private readonly latestByCall = new Map<string, string>()

  /**
   * Record one durable ask (from `approval/asked`).
   * @param id - the ask's unique id.
   * @param sessionId - session that owns the ask.
   * @param tool - tool the ask names.
   * @param callId - the tool call the ask is about, when present.
   */
  noteAsked(id: string, sessionId: string, tool: string, callId?: string): void {
    if (this.asks.size >= 128) {
      const oldest = this.asks.keys().next()
      if (oldest.done !== true) this.asks.delete(oldest.value)
    }
    this.asks.set(id, { tool, sessionId, callId })
    if (callId !== undefined) this.latestByCall.set(`${sessionId}\0${callId}`, id)
  }

  /**
   * Attach the pre-approver's verdict to the open ask of one call.
   * @param sessionId - session that owns the ask.
   * @param callId - the call the verdict is about.
   * @param verdict - what Jev concluded (or `not-evaluated` when the
   *   pre-approver had no opinion: disabled, no evidence, degraded).
   */
  noteVerdict(sessionId: string, callId: string | undefined, verdict: JevVerdict): void {
    if (callId === undefined) return
    const id = this.latestByCall.get(`${sessionId}\0${callId}`)
    if (id === undefined) return
    const ask = this.asks.get(id)
    if (ask !== undefined && ask.verdict === undefined) ask.verdict = verdict
  }

  /**
   * Consume one durable outcome (from `approval/decided`) and produce the
   * agreement record when Jev had an opinion on that ask.
   * @param id - the ask id the outcome answers.
   * @param human - the durable outcome.
   * @returns the agreement record, or `undefined` when Jev had no verdict
   *   (`not-evaluated` asks carry no comparison value).
   */
  onDecided(id: string, human: ApprovalAgreement['human']): ApprovalAgreement | undefined {
    const ask = this.asks.get(id)
    this.asks.delete(id)
    if (ask === undefined || ask.verdict === undefined || ask.verdict === 'not-evaluated') return undefined
    let bucket: ApprovalAgreement['bucket']
    if (ask.verdict === 'auto-approve' && (human === 'rejected' || human === 'cancelled')) bucket = 'would-over-approve'
    else if (ask.verdict === 'auto-approve' && human === 'allowed-once') bucket = 'aligned-approve'
    else if (ask.verdict === 'human' && human === 'allowed-once') bucket = 'friction-human-approved'
    else if (ask.verdict === 'human' && human === 'rejected') bucket = 'aligned-reject'
    else bucket = 'neutral'
    return { tool: ask.tool, sessionId: ask.sessionId, jev: ask.verdict, human, bucket }
  }
}

/**
 * Create the `session/event` listener that feeds the trace and writes
 * agreement telemetry. Register with plain append.
 * @param deps - trace and telemetry.
 * @returns the listener.
 */
export function createApprovalLoopListener(
  deps: { readonly trace: ApprovalTrace; readonly telemetry: Telemetry },
): (session: Session, event: SessionEvent) => void {
  return (session, event) => {
    if (event.type === 'approval/asked') {
      const callId = event.data.callId
      deps.trace.noteAsked(
        String(event.data.id),
        session.id,
        event.data.toolName,
        callId === undefined ? undefined : String(callId),
      )
      return
    }
    if (event.type === 'approval/decided') {
      const agreement = deps.trace.onDecided(String(event.data.id), event.data.outcome)
      if (agreement === undefined) return
      deps.telemetry.record({
        ts: new Date().toISOString(),
        tag: 'approval-loop',
        mode: 'shadow',
        tool: agreement.tool,
        sessionId: agreement.sessionId,
        action: 'agreement',
        detail: `jev=${agreement.jev} human=${agreement.human} ${agreement.bucket}`,
      })
    }
  }
}
