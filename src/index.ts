/**
 * dsh-jev-interceptor — System-1 decisions for DeepSeek Harness.
 *
 * One out-of-tree Cordis bundle that classifies pending tool calls with Jev
 * (TypeSafe AI's non-generative "System One" model) in milliseconds and uses
 * the answers to (a) escalate risky calls to a human before they run and
 * (b) auto-approve clearly-granted, reversible ones so humans stop clicking
 * through routine approvals.
 *
 * Posture: fail-closed. With no key, during provider cooldown, on timeout, or
 * on any internal error, every hook delegates through `next()` and behavior is
 * stock dsh. The plugin never widens a permission the base composition would
 * not grant (the `never` approval policy is enforced upstream of every
 * listener), never returns `allow` itself (downstream vetoes survive), and is
 * disabled until `enabled: true`.
 *
 * Install: `dsh plugin --profile <name> add dsh-jev-interceptor`, then set
 * `enabled: true` (and eventually `mode: enforce`) in cordis.yml.
 * @module dsh-jev-interceptor
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
// Type-only: registers the 'permissionPresets' Context key so `ctx.get` below
// typechecks; the service itself is consumed structurally and the package is
// not a runtime dependency.
import type {} from '@deepseek-ai/dsh-permission-presets'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-user-approval/types'
import { Config, resolveEndpoint, resolveSettings } from './config.js'
import { JevClient } from './jev.js'
import { Telemetry } from './telemetry.js'
import { createGuardListener, PendingAsks } from './guard.js'
import { createPreapproveListener } from './preapprove.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-jev-interceptor'

/**
 * Services this plugin consumes are all optional at load time: the events it
 * listens to exist in every composition that runs tools, and the seams
 * (credentials, permissionPresets, commands) are resolved defensively. An
 * empty `inject` keeps the plugin loadable in every profile.
 */
export const inject: readonly string[] = []

export { Config } from './config.js'
export type { Config as ConfigType } from './config.js'
export { resolveSettings, resolveEndpoint, DEFAULTS } from './config.js'
export { JevClient } from './jev.js'
export type { ClassifyResult, ClassifyCall, DegradeReason } from './jev.js'
export { Telemetry } from './telemetry.js'
export type { TelemetryEntry, DecisionTag, DecisionAction } from './telemetry.js'
export { noul, choice, score } from './types.js'
export type { NoulQuestion, ChoiceQuestion, ScoreQuestion, JevQuestion, JevAnswers } from './types.js'
export { decideGuard, decidePreapprove } from './matrix.js'
export { CooldownGate, Semaphore, LruCache } from './resilience.js'

/**
 * Mount the guard and pre-approval hooks, the shared Jev client, telemetry,
 * and the `/jev-stats` command.
 * @param ctx - plugin context.
 * @param config - YAML-validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // Master opt-out: register nothing at all.
  if (config.enabled !== true) return

  const { endpoint, model } = resolveEndpoint(config)
  const settings = resolveSettings(config)
  const telemetry = new Telemetry(settings.telemetryDir)
  const pendingAsks = new PendingAsks()

  const ref = credentialRef(settings.apiKeyEnv)
  const resolveKey = async (): Promise<string | undefined> => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      // The seam owns the whole credential plane when present: a miss does not
      // fall through to ambient values (mirrors the llm-deepseek precedent).
      const hit = await credentials.resolve(ref)
      if (hit !== undefined && hit.value.length > 0) return hit.value
      return undefined
    }
    // Without the credentials seam the launching environment is the whole credential plane.
    const ambient = launchEnvironmentOf(ctx).get(ref)
    if (ambient !== undefined && ambient.value.length > 0) return ambient.value
    return undefined
  }

  const jev = new JevClient({
    endpoint,
    model,
    timeoutMs: settings.timeoutMs,
    cooldownMs: settings.cooldownMs,
    failureThreshold: settings.failureThreshold,
    maxConcurrency: settings.maxConcurrency,
    cacheSize: settings.cacheSize,
    resolveKey,
    telemetry,
    logger: ctx.logger,
  })

  // Optional seams resolved defensively: the plugin loads in every profile.

  if (settings.guardEnabled) {
    ctx.on('tools/pre-execute', createGuardListener({
      mode: settings.mode,
      readOnlyTools: settings.readOnlyTools,
      excludeTools: settings.excludeTools,
      thresholds: {
        confidenceMin: settings.guardConfidenceMin,
        denyConfidence: settings.guardDenyConfidence,
        irreversibleCeiling: settings.guardIrreversibleCeiling,
        irreversibleDenyFloor: settings.guardIrreversibleDenyFloor,
        injectionAskThreshold: settings.guardInjectionAskThreshold,
      },
      recentMessages: settings.recentMessages,
      recentMessageChars: settings.recentMessageChars,
      argsHeadChars: settings.argsHeadChars,
      argsTailChars: settings.argsTailChars,
      jev,
      telemetry,
      pendingAsks,
      // Resolved per event: a capture here could miss a service that activates later.
      permissionPresets: () => ctx.get('permissionPresets'),
    }))
  }

  if (settings.preapproveEnabled) {
    ctx.on('approval/request', createPreapproveListener({
      mode: settings.mode,
      allowlist: settings.preapproveToolAllowlist,
      thresholds: {
        autoApproveMin: settings.preapproveAutoApproveMin,
        irreversibleMax: settings.preapproveIrreversibleMax,
        injectionSuspectMax: settings.preapproveInjectionSuspectMax,
      },
      recentMessages: settings.preapproveRecentMessages,
      recentMessageChars: settings.recentMessageChars,
      jev,
      telemetry,
      pendingAsks,
    }), { prepend: true })
  }

  ctx.inject(['commands'], (commandsCtx) => {
    void commandsCtx.commands.register({
      definitionId: CommandDefinitionId('dsh-jev-interceptor:jev-stats'),
      name: 'jev-stats',
      description: 'Show dsh-jev-interceptor decision statistics',
      handler: async (): Promise<CommandResult> => ({ kind: 'success', text: await telemetry.stats() }),
    })
  })

  const allowlistNote = settings.preapproveToolAllowlist.size === 0
    ? '; pre-approval allowlist is empty — no call is auto-approved until preapproveToolAllowlist names tools'
    : ''
  ctx.logger.info(
    `dsh-jev-interceptor: active in ${settings.mode} mode (provider endpoint ${endpoint}, model ${model})${allowlistNote}`,
  )
}
