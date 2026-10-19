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
const jevKeyDefinitionId: CommandDefinitionIdBrand = 'dsh-jev-interceptor:jev-key' as CommandDefinitionIdBrand
const jevCalibrateDefinitionId: CommandDefinitionIdBrand = 'dsh-jev-interceptor:jev-calibrate' as CommandDefinitionIdBrand
const jevLogDefinitionId: CommandDefinitionIdBrand = 'dsh-jev-interceptor:jev-log' as CommandDefinitionIdBrand
import type {} from '@deepseek-ai/dsh-user-approval/types'
import {
  Config,
  SETTINGS_NS,
  liveOf,
  resolveEndpoint,
  resolveSettings,
  type LiveSettings,
  type ResolvedSettings,
} from './config.js'
import { JevClient } from './jev.js'
import { Telemetry } from './telemetry.js'
import { createGuardListener, PendingAsks } from './guard.js'
import { createPreapproveListener } from './preapprove.js'
import { ApprovalTrace, createApprovalLoopListener } from './approval-loop.js'
import { createImageOffloadListener } from './image-offload.js'
import { createStagnationListener, StagnationTracker, type StagnationThresholds } from './stagnation.js'
import { registerJevApi } from './jev-api.js'
import { calibrate, renderCalibration, type CalibrationReport, type ThresholdsInput } from './calibrate.js'
import { parseLogArgs, renderLogTable, toLogCsv, toLogJson } from './telemetry.js'
import { join } from 'node:path'

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
export { decideGuard, decidePreapprove, decideStagnation } from './matrix.js'
export type { GuardAction, GuardThresholds, PreapproveVerdict, PreapproveThresholds, StagnationAnswers } from './matrix.js'
export { CooldownGate, Semaphore, LruCache } from './resilience.js'
export { createStagnationListener, StagnationTracker, shouldProbe, summarizeFailure } from './stagnation.js'
export type { AttemptRecord, StagnationThresholds, StagnationDeps } from './stagnation.js'
export { calibrate, renderCalibration } from './calibrate.js'
export type { CalibrationReport, ThresholdAdvice, CalibrationNote, ThresholdKey, ThresholdsInput, GuardScoreSample, PreapproveScoreSample } from './calibrate.js'

/** 从已解析设置提取阈值子集（校准基线，与挂点同源）。 */
function thresholdsOf(s: ResolvedSettings): ThresholdsInput {
  return {
    guardConfidenceMin: s.guardConfidenceMin,
    guardDenyConfidence: s.guardDenyConfidence,
    guardIrreversibleCeiling: s.guardIrreversibleCeiling,
    guardIrreversibleDenyFloor: s.guardIrreversibleDenyFloor,
    guardInjectionAskThreshold: s.guardInjectionAskThreshold,
    preapproveAutoApproveMin: s.preapproveAutoApproveMin,
    preapproveIrreversibleMax: s.preapproveIrreversibleMax,
    preapproveInjectionSuspectMax: s.preapproveInjectionSuspectMax,
  }
}

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

  // Live settings: the plugin Config is registered with the settings provider
  // so the Settings → Plugins page renders a form (provider, model, apiKey,
  // mode, etc.) and /jev-key persists through the user layer. On generations
  // without the service, the row config stays the whole truth.
  let liveOverride: LiveSettings | undefined
  let configOverride: Config | undefined
  const live = (): LiveSettings => liveOverride ?? liveOf(configOverride ?? config)

  // Register our Config schema with the settings provider → the Plugins page
  // discovers it via describe() and renders the form.
  ctx.inject(['settings'], (settingsCtx) => {
    ctx.logger.info('dsh-jev-interceptor: settings service available, attempting registration')
    try {
      const service = settingsCtx.settings as unknown as {
        installSection: (owner: Context, ns: string, schema: unknown, entry: unknown, hooks: {
          setSource?: (source: unknown) => void
        }) => void
      }
      service.installSection(ctx, 'jev-interceptor', Config, config, {
        setSource: (source) => {
          if (typeof source === 'object' && source !== null) {
            configOverride = source as Config
          }
        },
      })
      ctx.logger.info('dsh-jev-interceptor: Settings form registered — configure in Settings → Plugins')
    } catch (error: unknown) {
      ctx.logger.warn(`dsh-jev-interceptor: Settings registration failed (${error instanceof Error ? error.message : String(error)})`)
    }
  })

  const ref = credentialRef(settings.apiKeyEnv)
  const resolveKey = async (): Promise<string | undefined> => {
    // Direct config value (set via /jev-key or Settings form) takes precedence.
    const apiKey = (configOverride ?? config).apiKey
    if (apiKey !== undefined && apiKey.length > 0) return apiKey
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

  // Panel API: browser-side settings page fetches from these routes.
  // Wrapped in inject to defer registration until the connection service is available.
  ctx.inject(['connection'], () => {
  registerJevApi(ctx, {
    getStatus: () => {
      const s = live()
      const cfg = configOverride ?? config
      return {
        enabled: s.enabled,
        mode: s.mode,
        provider: cfg.provider ?? 'typesafe',
        model: cfg.model ?? 'jev-latest',
        keyConfigured: cfg.apiKey !== undefined && cfg.apiKey.length > 0,
        keySource: cfg.apiKey !== undefined && cfg.apiKey.length > 0 ? 'config' : 'env',
        guardEnabled: settings.guardEnabled,
        preapproveEnabled: settings.preapproveEnabled,
        stagnationEnabled: settings.stagnationEnabled,
      }
    },
    getStats: () => telemetry.statsData(200),
    // 校准基线用与四个挂点同一份 settings 快照：报告的「当前值」= 实际执行值。
    getCalibration: async (): Promise<CalibrationReport> => calibrate(await telemetry.entries(2000), thresholdsOf(settings)),
    getLog: (limit) => telemetry.recentEntries(limit),
    updateConfig: async (patch) => {
      // 先立即更新内存（getStatus 立刻能看到，无论 settings 服务是否存在）
      if (typeof patch['enabled'] === 'boolean') liveOverride = { ...live(), enabled: patch['enabled'] }
      if (patch['mode'] === 'shadow' || patch['mode'] === 'enforce') liveOverride = { ...live(), mode: patch['mode'] }
      if (typeof patch['provider'] === 'string') configOverride = { ...(configOverride ?? config), provider: patch['provider'] as Config['provider'] }
      if (typeof patch['endpoint'] === 'string') configOverride = { ...(configOverride ?? config), endpoint: patch['endpoint'] }
      if (typeof patch['apiKey'] === 'string') configOverride = { ...(configOverride ?? config), apiKey: patch['apiKey'] }
      // 再尽力持久化（失败不影响本次运行）
      try {
        const settingsService = ctx.get('settings')
        if (settingsService !== undefined && typeof settingsService.update === 'function') {
          await settingsService.update(SETTINGS_NS, patch)
        }
      } catch { /* 内存已更新，持久化失败仅影响重启后 */ }
    },
  })
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

  // Image-offload pre-planning: fills the gap dsh's README admits —
  // "nothing plans an offload before dispatch". Opt-in (default off) because
  // image/offload events are irreversible on disk; only high-confidence
  // sacrificial images are offloaded before the request dispatches.
  if (config.imageOffloadEnabled === true) {
    ctx.on('agent/pre-step', createImageOffloadListener({
      live,
      pressureThreshold: config.imageOffloadPressureThreshold ?? 0.75,
      minCandidates: config.imageOffloadMinCandidates ?? 3,
      sacrificeScoreMax: config.imageOffloadSacrificeScoreMax ?? 0.33,
      sacrificeProbMin: config.imageOffloadSacrificeProbMin ?? 0.8,
      jev,
      telemetry,
    }))
  }

  // Stagnation detection (opt-in): 换参数死循环检测。observe-and-enrich 形态
  // （照 repeat-tool-reminder）：不拦截不否决，高置信无进展时注入一条提醒。
  if (settings.stagnationEnabled) {
    const stagnationThresholds: StagnationThresholds = {
      triggerCount: settings.stagnationTriggerCount,
      failureRatioMin: settings.stagnationFailureRatioMin,
      cooldownMs: settings.stagnationCooldownMs,
    }
    const stagnation = createStagnationListener({
      live,
      tracker: new StagnationTracker(settings.stagnationWindow),
      thresholds: stagnationThresholds,
      confidenceMin: settings.stagnationConfidenceMin,
      argsPreviewChars: settings.stagnationArgsPreviewChars,
      jev,
      telemetry,
    })
    ctx.on('tools/post-execute', stagnation.onPostExecute)
    ctx.on('agent/pre-step', stagnation.onPreStep)
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
      // Without an `input` hint a capable client refuses any non-bare line
      // (`matchEnter` → `!bare` → not a command) and submits `/jev-stats --all`
      // as an ordinary prompt, so the handler never receives the flag.
      input: { hint: '[--all]' },
      handler: async (invocation): Promise<CommandResult> => {
        const full = invocation.rawInput.includes('--all')
        return { kind: 'success', text: await telemetry.stats(full ? undefined : 200) }
      },
    })
    void commandsCtx.commands.register({
      definitionId: jevCalibrateDefinitionId,
      name: 'jev-calibrate',
      description: '分析影子遥测，输出阈值调整建议（默认最近 2000 条，--all 全量）',
      input: { hint: '[--all]' },
      handler: async (invocation): Promise<CommandResult> => {
        const full = invocation.rawInput.includes('--all')
        const entries = await telemetry.entries(full ? undefined : 2000)
        return { kind: 'success', text: renderCalibration(calibrate(entries, thresholdsOf(settings))) }
      },
    })
    void commandsCtx.commands.register({
      definitionId: jevLogDefinitionId,
      name: 'jev-log',
      description: '查看最近 n 条决策明细（默认 20；--json/--csv 导出原始数据）',
      input: { hint: '[n] [--json|--csv]' },
      handler: async (invocation): Promise<CommandResult> => {
        const args = parseLogArgs(invocation.rawInput)
        const entries = await telemetry.recentEntries(args.n)
        if (entries.length === 0) {
          return { kind: 'success', text: '```\n⚡ dsh-jev-interceptor\n\n  暂无决策记录\n\n  运行 /jev-on 启用插件后再查看\n```' }
        }
        if (args.format === 'json') {
          return { kind: 'success', text: '```json\n' + toLogJson(entries) + '\n```' }
        }
        if (args.format === 'csv') {
          return { kind: 'success', text: '```\n' + toLogCsv(entries) + '\n```' }
        }
        return { kind: 'success', text: renderLogTable(entries, join(settings.telemetryDir, 'telemetry.jsonl')) }
      },
    })
    void commandsCtx.commands.register({
      definitionId: jevStatusDefinitionId,
      name: 'jev-status',
      description: '查看 Jev 插件当前状态',
      handler: async (): Promise<CommandResult> => {
        const s = live()
        const text = [
          '```',
          '⚡ dsh-jev-interceptor 状态',
          `  运行   ${s.enabled ? '✅ 已启用' : '⏸️ 已停用'}`,
          `  模式   ${s.mode}${s.mode === 'shadow' ? '（只记录）' : '（执行决策）'}`,
          `  源     ${config.provider ?? 'typesafe'}`,
          `  模型   ${model}`,
          `  守门   ${settings.guardEnabled ? '✅' : '❌'}  预批 ${settings.preapproveEnabled ? '✅' : '❌'}  停滞 ${settings.stagnationEnabled ? '✅' : '❌'}`,
          `  Key    ${config.apiKey !== undefined && config.apiKey.length > 0 ? '✅ 已配置' : (await resolveKey()) !== undefined ? '✅ 环境变量' : '❌ 未配置（运行 /jev-key <key>）'}`,
          settings.preapproveToolAllowlist.size === 0 ? '  预批白名单为空，不会自动批任何工具' : '',
          '  控制: /jev-on /jev-off /jev-mode',
          '  统计: /jev-stats │ 明细: /jev-log │ 校准: /jev-calibrate',
          '```',
        ].filter(line => line.length > 0).join('\n')
        return { kind: 'success', text }
      },
    })
    void commandsCtx.commands.register({
      definitionId: jevKeyDefinitionId,
      name: 'jev-key',
      description: '设置 Jev API key（持久化，不需要环境变量）',
      input: { hint: '<api-key>' },
      handler: async (invocation): Promise<CommandResult> => {
        const key = invocation.rawInput.trim()
        if (key.length < 10) {
          return { kind: 'error', text: '用法：/jev-key <你的API密钥>（长度需大于 10 个字符）' }
        }
        const settingsService = ctx.get('settings')
        if (settingsService !== undefined && typeof settingsService.update === 'function') {
          try {
            await settingsService.update(SETTINGS_NS, { apiKey: key })
            return {
              kind: 'success',
              text: 'dsh-jev-interceptor：API key 已存储 ✅ 持久化到 profile，无需环境变量，重启后仍生效。下一步：/jev-on 启用插件',
            }
          } catch (error: unknown) {
            ctx.logger.warn(`dsh-jev-interceptor: key storage failed (${error instanceof Error ? error.message : String(error)})`)
          }
        }
        return {
          kind: 'error',
          text: '当前 profile 无法持久化设置。备选方案：在 cordis.patch.yml 的 jev-interceptor 行加 apiKey: <你的key>',
        }
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
      // Same reason as jev-stats: only a declared input hint makes the client
      // admit `/jev-mode enforce` as a command instead of a chat message.
      input: { hint: 'shadow | enforce' },
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
