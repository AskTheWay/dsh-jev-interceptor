/**
 * The `approval/request` pre-approver: the first answerer on the chain. When a
 * call was escalated to approval (by our guard, a hook, or a sandbox
 * escalation), Jev judges whether it falls inside what the user already
 * granted and is reversible; only then does the plugin answer `allowed-once`.
 * Every doubt delegates with `next()`, which lands on the human answerer —
 * the failure mode of this hook is "back to today's manual approval", never a
 * widened permission.
 *
 * The structural safety net is upstream: the approval service rejects under
 * the `never` policy before any listener runs, so this hook cannot relax it.
 * The plugin also skips its own guard's escalations (`jev-guard:` reason
 * prefix) so a high-risk ask is never auto-approved by its sibling hook.
 * @module dsh-jev-interceptor/preapprove
 */

import type {} from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import { decidePreapprove, type PreapproveThresholds, type PreapproveVerdict } from './matrix.js'
import type { JevClient } from './jev.js'
import { noul, type JevQuestion, type NoulAnswer } from './types.js'
import { digestRecent } from './text.js'
import type { Telemetry } from './telemetry.js'
import type { PendingAsks } from './guard.js'

/** Resolved configuration and services the pre-approver consumes. */
export interface PreapproveDeps {
  readonly mode: 'shadow' | 'enforce'
  readonly allowlist: ReadonlySet<string>
  readonly thresholds: PreapproveThresholds
  readonly recentMessages: number
  readonly recentMessageChars: number
  readonly jev: JevClient
  readonly telemetry: Telemetry
  readonly pendingAsks: PendingAsks
}

/** The one fan-out every pre-approval asks. */
const PREAPPROVE_QUESTIONS: Readonly<Record<string, JevQuestion>> = {
  within_granted_scope: noul(
    'A human, or the session\'s active permission configuration, must still approve tool calls like the pending one. Does the ask reason plus recent messages show the user already granted exactly this action (same target and scope)?',
    {
      true: 'The user already asked for this exact action, target, and scope in this session',
      false: 'The action goes beyond, or is unrelated to, what the user granted',
    },
  ),
  reversible: noul(
    'Could the effects of this call be undone or re-derived afterwards?',
    {
      true: 'Every effect is local, reversible, or re-derivable',
      false: 'The call deletes, overwrites, sends, or publishes something that cannot be restored',
    },
  ),
}

/** Extract and kind-check the two pre-approval answers. */
function extractPreapproveAnswers(
  answers: Readonly<Record<string, unknown>>,
): { withinGrantedScope: NoulAnswer; reversible: NoulAnswer } | undefined {
  const scope = answers['within_granted_scope']
  const reversible = answers['reversible']
  if (scope === undefined || typeof scope !== 'object' || scope === null) return undefined
  if (reversible === undefined || typeof reversible !== 'object' || reversible === null) return undefined
  if ((scope as { type?: unknown }).type !== 'noul') return undefined
  if ((reversible as { type?: unknown }).type !== 'noul') return undefined
  return { withinGrantedScope: scope as NoulAnswer, reversible: reversible as NoulAnswer }
}

/**
 * Create the `approval/request` answerer.
 * @param deps - resolved configuration and services.
 * @returns the waterfall answerer (register with `{ prepend: true }`).
 */
export function createPreapproveListener(
  deps: PreapproveDeps,
): (req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome> {
  return async (req, next) => {
    // Our guard's escalation is a request FOR the human; auto-approving it would defeat the guard.
    if (req.reason !== undefined && req.reason.startsWith('jev-guard:')) return next()
    if (!deps.allowlist.has(req.toolName)) return next()

    let verdict: PreapproveVerdict | undefined
    try {
      verdict = await evaluatePreapprove(deps, req)
    } catch {
      // Our own failure must land on the human answerer; next() errors are not ours to swallow.
      verdict = undefined
    }
    if (verdict === undefined) return next()
    if (deps.mode === 'enforce' && verdict.kind === 'auto-approve') return 'allowed-once'
    return next()
  }
}

/**
 * Run every pre-approval stage that must not swallow `next()` failures.
 * Returns `undefined` for delegation.
 */
async function evaluatePreapprove(
  deps: PreapproveDeps,
  req: ApprovalRequestEvent,
): Promise<PreapproveVerdict | undefined> {
  const pending = req.callId === undefined ? undefined : deps.pendingAsks.take(req.callId)
  const session = req.agent.session
  const state = {
    tool: req.toolName,
    ask_reason: req.reason ?? '',
    args_preview: pending?.argsPreview ?? '(arguments not captured)',
    recent: digestRecent(session.deriveMessages(), deps.recentMessages, deps.recentMessageChars),
    cwd: session.header.cwd ?? '',
  }

  const result = await deps.jev.classify({
    tag: 'preapprove',
    mode: deps.mode,
    tool: req.toolName,
    sessionId: session.id,
    state,
    questions: PREAPPROVE_QUESTIONS,
    signal: req.signal,
  })
  if (result === null) return undefined
  const extracted = extractPreapproveAnswers(result.answers)
  if (extracted === undefined) {
    deps.telemetry.record({
      ts: new Date().toISOString(),
      tag: 'preapprove',
      mode: deps.mode,
      tool: req.toolName,
      sessionId: session.id,
      action: 'degraded',
      detail: 'answer-shape-mismatch',
      latencyMs: result.latencyMs,
    })
    return undefined
  }
  const verdict = decidePreapprove(extracted, deps.thresholds)
  deps.telemetry.record({
    ts: new Date().toISOString(),
    tag: 'preapprove',
    mode: deps.mode,
    tool: req.toolName,
    sessionId: session.id,
    model: result.model,
    action: verdict.kind === 'auto-approve' ? 'auto-approve' : 'human',
    detail: `scope=${extracted.withinGrantedScope.noul.toFixed(2)} reversible=${extracted.reversible.noul.toFixed(2)}`
      + (verdict.kind === 'human' ? ` (${verdict.reason})` : ''),
    latencyMs: result.latencyMs,
    ...(result.inputTokens === undefined ? {} : { inputTokens: result.inputTokens }),
    ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
    cached: result.cached,
  })
  return verdict
}
