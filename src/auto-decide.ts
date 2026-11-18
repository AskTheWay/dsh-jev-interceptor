/**
 * Optional unattended decisions for the guard's own escalations
 * (`autoApproveNonHighRiskCalls`).
 *
 * The guard's `ask` normally puts a risky call in front of a human. With this
 * opt-in enabled, the guard's escalations are decided here instead, using the
 * verdict frozen at classification time:
 * - below-high-risk, non-injection asks are answered `allowed-once` (the same
 *   one-shot grant a person clicking approve would produce);
 * - high-risk asks and injection-suspicion asks are answered `rejected` — an
 *   unattended deny instead of a prompt.
 * Guard `deny` decisions already stop the call on their own and never create an
 * approval request; this answerer does not touch them.
 *
 * Safety properties kept even in this mode:
 * - the request must carry this plugin's `jev-guard:` reason prefix, which only
 *   the guard writes;
 * - it must match a fresh `PendingAsks` record for the same session, call id,
 *   and tool — a forged prefix, a stale ask, or another hook's request
 *   delegates to the human answerer instead;
 * - the plugin must be enabled and in `enforce` mode; shadow mode never acts;
 * - grants are `allowed-once`, so nothing accumulates beyond this call.
 * @module dsh-jev-interceptor/auto-decide
 */

import type {} from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type { LiveSettings } from './config.js'
import type { PendingAsks } from './guard.js'

/** Reason prefix only this plugin's guard writes; preapprove uses it to stand aside. */
export const GUARD_REASON_PREFIX = 'jev-guard:'

/** Resolved configuration and services the auto-decider consumes. */
export interface AutoDecideDeps {
  /** Live settings read once per event: runtime toggles take effect immediately. */
  readonly live: () => LiveSettings
  /** The opt-in flag, read per event so a Settings-form change applies at once. */
  readonly enabled: () => boolean
  /** Guard escalation evidence; its frozen `autoDecision` drives the outcome. */
  readonly pendingAsks: PendingAsks
}

/**
 * Create the `approval/request` answerer that decides the guard's escalations.
 * @param deps - live settings, the opt-in flag, and escalation evidence.
 * @returns the waterfall answerer (register with `{ prepend: true }`).
 */
export function createAutoDecideListener(
  deps: AutoDecideDeps,
): (req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome> {
  return async (req, next) => {
    if (!deps.enabled()) return next()
    const live = deps.live()
    if (!live.enabled || live.mode !== 'enforce') return next()
    if (req.reason === undefined || !req.reason.startsWith(GUARD_REASON_PREFIX)) return next()
    if (req.callId === undefined) return next()
    const pending = deps.pendingAsks.take(req.agent.session.id, req.callId, req.toolName)
    if (pending?.autoDecision === 'approve') return 'allowed-once'
    if (pending?.autoDecision === 'deny') return 'rejected'
    return next()
  }
}
