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
// Type-only: registers the 'settings' Context key used by installSection.
import type {} from '@deepseek-ai/dsh-settings'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
// Type-only: registers the 'permissionPresets' Context key so `ctx.get` below
// typechecks; the service itself is consumed structurally and the package is
// not a runtime dependency.
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { CommandDefinitionId as CommandDefinitionIdBrand } from '@deepseek-ai/dsh-commands/brand'
import type { CommandResult } from '@deepseek-ai/dsh-commands'

/**
 * Command definition brand, mirrored locally instead of imported: the brand
 * function is named `CommandDefinitionId` only in newer dsh API generations
 * (older runtimes export it under different names or not at all), and a plain
 * branded string passes structural validation wherever the field is known.
 */
const jevStatsDefinitionId: CommandDefinitionIdBrand = 'dsh-jev-interceptor:jev-stats' as CommandDefinitionIdBrand
const jevOnDefinitionId: CommandDefinitionIdBrand = 'dsh-jev-interceptor:jev-on' as CommandDefinitionIdBrand
const jevOffDefinitionId: CommandDefinitionIdBrand = 'dsh-jev-interceptor:jev-off' as CommandDefinitionIdBrand
const jevModeDefinitionId: CommandDefinitionIdBrand = 'dsh-jev-interceptor:jev-mode' as CommandDefinitionIdBrand
const jevStatusDefinitionId: CommandDefinitionIdBrand = 'dsh-jev-interceptor:jev-status' as CommandDefinitionIdBrand
import type {} from '@deepseek-ai/dsh-user-approval/types'
import {
  Config,
  SETTINGS_NS,
  liveOf,
  resolveEndpoint,
  resolveSettings,
  type LiveSettings,
} from './config.js'
import { JevClient } from './jev.js'
import { Telemetry } from './telemetry.js'
import { createGuardListener, PendingAsks } from './guard.js'
import { createPreapproveListener } from './preapprove.js'
import { ApprovalTrace, createApprovalLoopListener } from './approval-loop.js'

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
  const { endpoint, model } = resolveEndpoint(config)
  const settings = resolveSettings(config)
  const telemetry = new Telemetry(settings.telemetryDir)
  const pendingAsks = new PendingAsks()
  const approvalTrace = new ApprovalTrace()

  // Live settings: the plugin Config is automatically exposed as an editable
  // settings form keyed by the profile entry id (SETTINGS_NS) on API
  // generations with SettingsForms; `/jev-on`-style commands write that form,
  // which persists into the profile patch and live-reloads this entry. On
  // generations without the service (or without per-entry update), the row
  // config stays the whole truth and the commands say so.
  let liveOverride: LiveSettings | undefined
  const live = (): LiveSettings => liveOverride ?? liveOf(config)

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
      live,
      // Resolved per event: a capture here could miss a service that activates later.
      permissionPresets: () => ctx.get('permissionPresets'),
    }))
  }

  if (settings.preapproveEnabled) {
    ctx.on('approval/request', createPreapproveListener({
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
      live,
      trace: approvalTrace,
    }), { prepend: true })
  }

  // Approval data loop: durable asked/decided audit events correlate with
  // pre-approval verdicts, so shadow mode accumulates the agreement dataset
  // (headline: asks Jev would auto-approve but the human rejected).
  ctx.on('session/event', createApprovalLoopListener({ trace: approvalTrace, telemetry, live }))

  const setLive = async (patch: Partial<LiveSettings>): Promise<CommandResult> => {
    // Apply immediately in-process so behavior flips on the next event even
    // when persistence (or the reload it triggers) is unavailable.
    liveOverride = { ...live(), ...patch }
    const settingsService = ctx.get('settings')
    if (settingsService !== undefined && typeof settingsService.update === 'function') {
      try {
        await settingsService.update(SETTINGS_NS, patch)
        const now = live()
        return {
          kind: 'success',
          text: `dsh-jev-interceptor：已${now.enabled ? '启用' : '停用'}，模式 ${now.mode}。`
            + ' 已持久化到 profile，下一个工具调用即生效（无需重启）。',
        }
      } catch (error: unknown) {
        ctx.logger.warn(`dsh-jev-interceptor: settings update failed (${error instanceof Error ? error.message : String(error)}); applied in-memory only for this run`)
      }
    }
    const now = live()
    return {
      kind: 'success',
      text: `dsh-jev-interceptor：已${now.enabled ? '启用' : '停用'}，模式 ${now.mode} —— 仅本次运行生效。`
        + ' 当前 profile 无法持久化插件设置；要永久生效请在 cordis.patch.yml 的 jev-interceptor 行设置 enabled/mode。',
    }
  }

  ctx.inject(['commands'], (commandsCtx) => {
    void commandsCtx.commands.register({
      definitionId: jevStatsDefinitionId,
      name: 'jev-stats',
      description: '查看 Jev 决策统计（默认最近 200 条，--all 全量）',
      handler: async (invocation): Promise<CommandResult> => {
        const full = invocation.rawInput.includes('--all')
        return { kind: 'success', text: await telemetry.stats(full ? undefined : 200) }
      },
    })
    void commandsCtx.commands.register({
      definitionId: jevStatusDefinitionId,
      name: 'jev-status',
      description: '查看 Jev 插件当前状态',
      handler: async (): Promise<CommandResult> => {
        const s = live()
        const lines = [
          `dsh-jev-interceptor 状态：`,
          `  运行状态: ${s.enabled ? '✅ 已启用' : '⏸️ 已停用（所有决策走原生行为）'}`,
          `  模式: ${s.mode}${s.mode === 'shadow' ? '（只记录，不执行）' : '（执行决策）'}`,
          `  Provider: ${config.provider ?? 'typesafe'} (${endpoint})`,
          `  模型: ${model}`,
          `  守门人: ${settings.guardEnabled ? '开启' : '关闭'}`,
          `  预批: ${settings.preapproveEnabled ? '开启' : '关闭'}${settings.preapproveToolAllowlist.size === 0 ? '（白名单为空，不会自动批任何工具）' : ''}`,
        ]
        return { kind: 'success', text: lines.join('\n') }
      },
    })
    void commandsCtx.commands.register({
      definitionId: jevOnDefinitionId,
      name: 'jev-on',
      description: '启用 Jev 插件（持久化，无需重启）',
      handler: async (): Promise<CommandResult> => setLive({ enabled: true }),
    })
    void commandsCtx.commands.register({
      definitionId: jevOffDefinitionId,
      name: 'jev-off',
      description: '停用 Jev 插件（持久化，无需重启）',
      handler: async (): Promise<CommandResult> => setLive({ enabled: false }),
    })
    void commandsCtx.commands.register({
      definitionId: jevModeDefinitionId,
      name: 'jev-mode',
      description: '设置模式：shadow（只记录）或 enforce（执行）',
      handler: async (invocation): Promise<CommandResult> => {
        const arg = invocation.rawInput.trim()
        if (arg !== 'shadow' && arg !== 'enforce') {
          return { kind: 'error', text: '用法：/jev-mode <shadow|enforce>\n  shadow  = 只记录决策，不执行\n  enforce = 执行决策（deny/ask/自动批）' }
        }
        return setLive({ mode: arg })
      },
    })
  })

  const state = live()
  const allowlistNote = settings.preapproveToolAllowlist.size === 0
    ? '；预批白名单为空——在 preapproveToolAllowlist 里点名工具前不会自动批任何调用'
    : ''
  ctx.logger.info(
    `dsh-jev-interceptor：${state.enabled ? `运行中（${state.mode} 模式）` : '已注册但停用'}`
    + `（provider ${endpoint}，模型 ${model}）；/jev-on 和 /jev-mode 可运行时切换${allowlistNote}`,
  )
}
