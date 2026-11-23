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
// Type-only: registers the optional 'settings' Context key.
import type {} from '@deepseek-ai/dsh-settings'
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
const jevImpactDefinitionId: CommandDefinitionIdBrand = 'dsh-jev-interceptor:jev-impact' as CommandDefinitionIdBrand
const jevAllowlistDefinitionId: CommandDefinitionIdBrand = 'dsh-jev-interceptor:jev-allowlist' as CommandDefinitionIdBrand
import type {} from '@deepseek-ai/dsh-user-approval/types'
import {
  Config,
  OPENROUTER_ENDPOINT,
  TYPESAFE_ENDPOINT,
  SETTINGS_NS,
  liveOf,
  hasLiveConfig,
  readProfileConfig,
  resolveCredentialName,
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
import { createUntrustedScanListener, UntrustedMarks } from './untrusted.js'
import { registerJevApi, type ConfigUpdateResult, type JevPanelStatus } from './jev-api.js'
import { providerConnection, providerCredential, type KeySource, type ProviderConnection } from './provider.js'
import {
  approvalBucketsOf,
  assessReadiness,
  calibrate,
  calibrationWindow,
  isCalibrationModel,
  renderCalibration,
  suggestAllowlist,
  THRESHOLD_KEYS,
  type CalibrationReport,
  type ShadowReadiness,
  type ThresholdsInput,
} from './calibrate.js'
import {
  CalibrationHistory,
  compareWithPrevious,
  renderComparisonLines,
  shouldAppend,
  snapshotOf,
} from './calibration-history.js'
import { renderImpact, summarizeImpact, type ImpactSummary } from './impact.js'
import { parseLogArgs, renderLogTable, toLogCsv, toLogJson } from './telemetry.js'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

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
export type { ClassifyResult, ClassifyCall, DegradeReason, JevConnection } from './jev.js'
export { Telemetry } from './telemetry.js'
export type { TelemetryEntry, DecisionTag, DecisionAction } from './telemetry.js'
export { noul, choice, score } from './types.js'
export type { NoulQuestion, ChoiceQuestion, ScoreQuestion, JevQuestion, JevAnswers } from './types.js'
export { decideGuard, decidePreapprove, decideStagnation } from './matrix.js'
export type { GuardAction, GuardThresholds, PreapproveVerdict, PreapproveThresholds, StagnationAnswers } from './matrix.js'
export { CooldownGate, Semaphore, LruCache } from './resilience.js'
export { createStagnationListener, StagnationTracker, shouldProbe, summarizeFailure } from './stagnation.js'
export type { AttemptRecord, StagnationThresholds, StagnationDeps } from './stagnation.js'
export { calibrate, renderCalibration, approvalBucketsOf } from './calibrate.js'
export { summarizeImpact, renderImpact } from './impact.js'
export type { ImpactSummary } from './impact.js'
export { CalibrationHistory, compareWithPrevious, shouldAppend, snapshotOf, renderComparisonLines } from './calibration-history.js'
export type { CalibrationSnapshot, CalibrationComparison } from './calibration-history.js'

/** 可经面板/命令热更新的阈值键（单一权威清单见 calibrate.ts 的 THRESHOLD_KEYS）。 */
const CALIBRATABLE_KEYS = THRESHOLD_KEYS

/** 从已解析设置提取阈值子集（校准基线，与挂点同源）。 */
function thresholdsOf(s: ResolvedSettings): ThresholdsInput {
  return {
    guardConfidenceMin: s.guardConfidenceMin,
    guardDenyConfidence: s.guardDenyConfidence,
    guardIrreversibleCeiling: s.guardIrreversibleCeiling,
    guardIrreversibleDenyFloor: s.guardIrreversibleDenyFloor,
    guardInjectionAskThreshold: s.guardInjectionAskThreshold,
    guardUserRequestedMin: s.guardUserRequestedMin,
    guardFromUntrustedMin: s.guardFromUntrustedMin,
    preapproveAutoApproveMin: s.preapproveAutoApproveMin,
    preapproveIrreversibleMax: s.preapproveIrreversibleMax,
    preapproveInjectionSuspectMax: s.preapproveInjectionSuspectMax,
  }
}


/**
 * Mount the guard and pre-approval hooks, the shared Jev client, telemetry,
 * and the `/jev-stats` command.
 * @param ctx - plugin context.
 * @param profileConfig - plugin config with live references on current hosts.
 */
export function apply(ctx: Context, profileConfig: Config | ReturnType<typeof Config>): void {
  const config = readProfileConfig(profileConfig)
  const settings = resolveSettings(config)
  const telemetry = new Telemetry(settings.telemetryDir)
  const calibrationHistory = new CalibrationHistory(settings.telemetryDir)
  const pendingAsks = new PendingAsks()
  const approvalTrace = new ApprovalTrace()
  const untrustedMarksStore = new UntrustedMarks()

  /**
   * 生成一份校准报告并落一份快照：读上一份快照对比「上次建议 → 是否采纳
   * → 桶变化」，再把本次快照追加进历史（5 分钟去抖）。命令与面板共用；
   * 定义在 apply 内以闭包 telemetry 与 settings（与挂点同一实例）。
   */
  const buildCalibration = async (full: boolean, selectedModel?: string): Promise<{ report: CalibrationReport; extras: string[] }> => {
    const window = await telemetry.entries(full ? undefined : 2000)
    const currentModel = activeCalibrationModel()
    const { scope, entries } = calibrationWindow(window, currentModel, selectedModel)
    const liveSettings = resolveSettings(activeConfig())
    const thresholds = thresholdsOf(liveSettings)
    const metrics = calibrate(entries, thresholds)
    const report: CalibrationReport = {
      ...metrics,
      scope,
      observations: entries.length > 0 ? metrics.observations : [{
        param: '—',
        reason: scope.model === null ? '先测试连接或等待服务返回模型版本。'
          : '本窗口没有该版本的决策样本。可切换到历史版本查看报告，或继续采集当前版本的观察记录。',
      }],
    }
    if (scope.model === null || scope.model !== scope.currentModel || entries.length === 0) {
      return { report, extras: [] }
    }

    // Older high-risk examples still veto a candidate. Only the active model supplies positive evidence.
    const eligible = new Set(suggestAllowlist(window).map(item => item.tool))
    const suggestions = suggestAllowlist(entries).filter(item => !liveSettings.preapproveToolAllowlist.has(item.tool) && eligible.has(item.tool))
    const reportWithSuggestions = suggestions.length === 0 ? report : { ...report, allowlistSuggestions: suggestions }
    const buckets = approvalBucketsOf(entries)
    const recentSnapshots = await calibrationHistory.recent(1, scope.model)
    const previous = recentSnapshots.at(-1)
    // 传本次窗口大小：与上次口径不同（--all vs 尾窗）时桶变化不可比。
    const comparison = compareWithPrevious(thresholds, previous, buckets, report.windowSize)
    const snapshot = snapshotOf(report, thresholds, new Date().toISOString(), buckets)
    if (scope.model === activeCalibrationModel() && shouldAppend(previous, snapshot)) calibrationHistory.append(snapshot)
    return {
      report: comparison.previousTs === undefined
        ? reportWithSuggestions
        : {
          ...reportWithSuggestions,
          history: {
            previousTs: comparison.previousTs,
            adopted: comparison.adopted.length,
            ignored: comparison.ignored.length,
            manual: comparison.manual.length,
          },
        },
      extras: renderComparisonLines(comparison),
    }
  }

  // Apply changes immediately, including on profiles that cannot persist them.
  let sourceConfig = profileConfig
  const overrides = new Map<string, { value: unknown }>()
  const activeConfig = (): Config => {
    const loaded = readProfileConfig(sourceConfig)
    return overrides.size === 0 ? loaded : {
      ...loaded,
      ...Object.fromEntries([...overrides].map(([key, entry]) => [key, entry.value])),
    }
  }
  const live = (): LiveSettings => {
    const cfg = activeConfig()
    syncConnection(cfg)
    return liveOf(cfg)
  }
  const jev = new JevClient({
    connection: undefined,
    cooldownMs: settings.cooldownMs,
    failureThreshold: settings.failureThreshold,
    maxConcurrency: settings.maxConcurrency,
    cacheSize: settings.cacheSize,
    dailyCostLimitUsd: () => activeConfig().dailyCostLimitUsd ?? 0,
    telemetry,
    logger: ctx.logger,
  })

  let route: ProviderConnection | undefined
  let routeConfig: Config | undefined
  let connectionError: string | undefined
  const syncConnection = (cfg = activeConfig()): void => {
    if (routeConfig !== undefined
      && routeConfig.provider === cfg.provider
      && routeConfig.endpoint === cfg.endpoint
      && routeConfig.model === cfg.model
      && routeConfig.apiKey === cfg.apiKey
      && routeConfig.apiKeyEnv === cfg.apiKeyEnv
      && routeConfig.timeoutMs === cfg.timeoutMs) return
    routeConfig = {
      provider: cfg.provider,
      endpoint: cfg.endpoint,
      model: cfg.model,
      apiKey: cfg.apiKey,
      apiKeyEnv: cfg.apiKeyEnv,
      timeoutMs: cfg.timeoutMs,
    }
    let next: ProviderConnection
    try {
      next = providerConnection(cfg)
    } catch (error) {
      if (route !== undefined) jev.setConnection(undefined)
      route = undefined
      connectionError = error instanceof Error ? error.message : '连接配置无效。'
      return
    }
    connectionError = undefined
    const timeoutMs = resolveSettings(cfg).timeoutMs
    route = next
    jev.setConnection({ ...next, timeoutMs, resolveKey: async () => (await providerCredential(ctx, next)).key })
  }
  syncConnection()

  const activeCalibrationModel = (): string | null => {
    syncConnection()
    const reported = jev.reportedModel()
    if (reported !== undefined) return isCalibrationModel(reported) ? reported : null
    // Known pins can reuse their exact history before the first request of this process.
    if (route?.endpoint === TYPESAFE_ENDPOINT && /^jev-\d+\.\d+\.\d+$/.test(route.model)) return route.model
    if (route?.endpoint === OPENROUTER_ENDPOINT && /-\d{8}$/.test(route.model)) return route.model
    return null
  }

  /**
   * 探测 settings 服务的落盘路径（documentPath）：null 表示非 file provider
   * 或探测失败——此时 update 只在内存生效，重启即丢，用户界面必须如实告知
   * 而不是声称"已持久化"。
   */
  const settingsPersistPath = (): string | null => {
    try {
      const service = ctx.get('settings') as { documentPath?: string | (() => unknown); writable?: boolean } | undefined
      if (service !== undefined && service.writable !== false) {
        const path = typeof service.documentPath === 'function' ? service.documentPath() : service.documentPath
        if (typeof path === 'string' && path.length > 0) return path
      }
    } catch {
      // 探测失败按无持久化处理（诚实降级）。
    }
    return null
  }

  // Use the custom panel for edits that require a provider and credential to change together.
  // Earlier hosts publish settings through installSection.
  ctx.inject(['settings'], (settingsCtx) => {
    try {
      const service = settingsCtx.settings
      if (typeof service.configure === 'function') {
        settingsCtx.effect(() => service.configure({ auto: false }, ctx.fiber))
      }
      const legacy = service as unknown as {
        installSection?: (owner: Context, ns: string, schema: unknown, entry: unknown, hooks: {
          setSource?: (source: unknown) => void
        }) => void
      }
      legacy.installSection?.(ctx, SETTINGS_NS, Config, config, {
        setSource: (source) => {
          if (typeof source === 'object' && source !== null) {
            sourceConfig = source as Config
            syncConnection()
          }
        },
      })
    } catch (error: unknown) {
      ctx.logger.warn(`dsh-jev-interceptor: Settings registration failed (${error instanceof Error ? error.message : String(error)})`)
    }
  })

  const getStatus = async (): Promise<JevPanelStatus> => {
    syncConnection()
    const connection = route
    let keySource: KeySource = 'none'
    let keyError: string | undefined
    if (connection !== undefined) {
      try { keySource = (await providerCredential(ctx, connection)).source } catch {
        keyError = '凭据服务暂不可用。'
      }
    }
    const currentConfig = activeConfig()
    syncConnection(currentConfig)
    const current = route
    if (current !== connection) {
      keySource = current?.apiKey === undefined ? 'none' : 'config'
      keyError = undefined
    }
    return {
      ...liveOf(currentConfig),
      provider: currentConfig.provider ?? 'typesafe',
      model: current?.model ?? currentConfig.model ?? '',
      activeModel: activeCalibrationModel(),
      endpointOrigin: current?.origin ?? null,
      connectionError,
      keyConfigured: keySource !== 'none',
      keyReference: resolveCredentialName(currentConfig),
      keySource,
      keyError,
      persistPath: settingsPersistPath(),
      costTodayUsd: jev.costTodayUsd(),
      dailyCostLimitUsd: currentConfig.dailyCostLimitUsd ?? 0,
      preapproveAllowlist: [...new Set(currentConfig.preapproveToolAllowlist ?? [])].sort(),
      guardEnabled: settings.guardEnabled,
      preapproveEnabled: settings.preapproveEnabled,
      stagnationEnabled: settings.stagnationEnabled,
    }
  }

  const updateConfig = async (request: Record<string, unknown>): Promise<ConfigUpdateResult> => {
    const { calibrationModel, calibrationCurrent, ...patch } = request
    if (calibrationModel !== undefined || calibrationCurrent !== undefined) {
      if (typeof calibrationModel !== 'string' || calibrationModel !== activeCalibrationModel()) {
        return { error: '当前模型已变更，请重新生成校准报告。' }
      }
      const thresholds = thresholdsOf(resolveSettings(activeConfig()))
      const param = CALIBRATABLE_KEYS.find(key => Object.hasOwn(patch, key))
      if (Object.keys(patch).length !== 1 || (param === undefined && !Object.hasOwn(patch, 'preapproveToolAllowlist'))) {
        return { error: '每次应用一项校准建议。' }
      }
      if (param !== undefined && thresholds[param] !== calibrationCurrent) {
        return { error: '当前阈值已变更，请重新生成校准报告。' }
      }
    }
    if ('enabled' in patch && typeof patch.enabled !== 'boolean') return { error: '启用状态必须为布尔值。' }
    if ('mode' in patch && patch.mode !== 'shadow' && patch.mode !== 'enforce') return { error: '请选择观察或执行模式。' }
    if ('provider' in patch && patch.provider !== 'typesafe' && patch.provider !== 'openrouter' && patch.provider !== 'custom') {
      return { error: '未知的决策服务。' }
    }
    const textFields = ['endpoint', 'model', 'apiKeyEnv', 'apiKey'] as const
    for (const field of textFields) {
      if (!Object.hasOwn(patch, field)) continue
      const value = patch[field]
      if (typeof value !== 'string') return { error: `${field} 必须为文本。` }
      patch[field] = value.trim()
    }
    if (typeof patch.apiKey === 'string' && patch.apiKey.length > 0 && patch.apiKey.length < 10) {
      return { error: 'API Key 至少需要 10 个字符。' }
    }
    for (const key of CALIBRATABLE_KEYS) {
      if (!Object.hasOwn(patch, key)) continue
      const value = patch[key]
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        return { error: `${key} 必须是 0 到 1 之间的数字。` }
      }
    }
    if ('preapproveToolAllowlist' in patch && (!Array.isArray(patch.preapproveToolAllowlist)
      || patch.preapproveToolAllowlist.some(item => typeof item !== 'string' || item.length === 0))) {
      return { error: '预批准名单必须是工具名称列表。' }
    }

    const cfg = activeConfig()
    syncConnection(cfg)
    const next = { ...cfg, ...patch }
    if ('provider' in patch || textFields.some(field => Object.hasOwn(patch, field))) {
      let connection: ProviderConnection
      try { connection = providerConnection(next) } catch (error) {
        return { error: error instanceof Error ? error.message : '连接配置无效。' }
      }
      const changesTarget = connection.provider !== route?.provider || connection.origin !== route?.origin
      if (changesTarget) {
        if ((cfg.apiKey?.trim() && !Object.hasOwn(patch, 'apiKey')) || (cfg.apiKeyEnv?.trim() && !Object.hasOwn(patch, 'apiKeyEnv'))) {
          return { error: '切换服务或地址时，请为新连接选择凭据。' }
        }
        if (connection.provider === 'custom' && connection.apiKey === undefined
          && !(typeof patch.apiKeyEnv === 'string' && patch.apiKeyEnv.length > 0)) {
          return { error: '切换到自定义地址时，需要为该地址指定凭据引用或新的 API Key。' }
        }
      }
    }
    const pending = Object.entries(patch).map(([key, value]) => [key, { value }] as const)
    for (const [key, entry] of pending) overrides.set(key, entry)
    syncConnection(next)
    try {
      const service = ctx.get('settings')
      if (service !== undefined && typeof service.update === 'function' && service.writable !== false) {
        const previousSource = sourceConfig
        await service.update(SETTINGS_NS, patch)
        if (sourceConfig !== previousSource || hasLiveConfig(sourceConfig)) {
          const loaded = readProfileConfig(sourceConfig)
          for (const [key, entry] of pending) {
            if (overrides.get(key) === entry && isDeepStrictEqual(loaded[key as keyof Config], entry.value)) overrides.delete(key)
          }
          syncConnection()
        }
        return { persisted: settingsPersistPath() !== null }
      }
    } catch {
      ctx.logger.warn('dsh-jev-interceptor: settings update failed; changes are in-memory only')
    }
    return { persisted: false }
  }

  // Panel API: browser-side settings page fetches from these routes.
  // Wrapped in inject to defer registration until the connection service is available.
  ctx.inject(['connection'], () => {
    registerJevApi(ctx, {
      getStatus,
      getStats: () => telemetry.statsData(500),
      getCalibration: async (model): Promise<CalibrationReport> => (await buildCalibration(false, model)).report,
      // The dashboard polls the tail window. /jev-impact keeps the full active log.
      getImpact: async (): Promise<ImpactSummary> => summarizeImpact(await telemetry.entries(5000)),
      testConnection: (apiKeyOverride, signal) => {
        syncConnection()
        return jev.ping({ apiKeyOverride, signal })
      },
      getLog: (limit) => telemetry.recentEntries(limit),
      getReadiness: async (): Promise<ShadowReadiness> => {
        const window = await telemetry.entries(2000)
        const model = activeCalibrationModel()
        const requestModel = route?.model
        if (model === null) return { shadowSamples: 0, misApprovals: 0, degradedRate: 0, ready: false, reason: '先测试连接，确认当前模型版本。' }
        const { entries } = calibrationWindow(window, model)
        const failures = window.filter(entry => requestModel !== undefined && entry.requestModel === requestModel
          && (entry.tag === 'guard' || entry.tag === 'preapprove') && entry.action === 'degraded')
        return assessReadiness([...entries, ...failures])
      },
      updateConfig,
    })
  })

  // Optional seams resolved defensively: the plugin loads in every profile.

  if (settings.guardEnabled) {
    ctx.on('tools/pre-execute', createGuardListener({
      readOnlyTools: settings.readOnlyTools,
      excludeTools: settings.excludeTools,
      // 每事件从活配置读取：面板/命令应用新阈值后下一个调用即生效
      // （resolveSettings 只在 Jev 分类成功后调用一次，分配成本可忽略）。
      thresholds: () => {
        const t = thresholdsOf(resolveSettings(activeConfig()))
        return {
          confidenceMin: t.guardConfidenceMin,
          denyConfidence: t.guardDenyConfidence,
          irreversibleCeiling: t.guardIrreversibleCeiling,
          irreversibleDenyFloor: t.guardIrreversibleDenyFloor,
          injectionAskThreshold: t.guardInjectionAskThreshold,
          userRequestedMin: t.guardUserRequestedMin,
          fromUntrustedMin: t.guardFromUntrustedMin,
        }
      },
      recentMessages: settings.recentMessages,
      recentMessageChars: settings.recentMessageChars,
      argsHeadChars: settings.argsHeadChars,
      argsTailChars: settings.argsTailChars,
      jev,
      telemetry,
      pendingAsks,
      live,
      untrustedMarks: untrustedMarksStore,
      // Resolved per event: a capture here could miss a service that activates later.
      permissionPresets: () => ctx.get('permissionPresets'),
    }))
  }

  if (settings.preapproveEnabled) {
    ctx.on('approval/request', createPreapproveListener({
      allowlist: () => resolveSettings(activeConfig()).preapproveToolAllowlist,
      thresholds: () => {
        const t = thresholdsOf(resolveSettings(activeConfig()))
        return {
          autoApproveMin: t.preapproveAutoApproveMin,
          irreversibleMax: t.preapproveIrreversibleMax,
          injectionSuspectMax: t.preapproveInjectionSuspectMax,
        }
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

  // 间接注入联防（default on）：post-execute 两层扫描工具结果中的注入指令并
  // 标记；guard 的第 6 问（from_untrusted）据此否决对标记指令的执行。
  if (settings.untrustedScanEnabled) {
    const scan = createUntrustedScanListener({ live, marks: untrustedMarksStore, jev, telemetry })
    ctx.on('tools/post-execute', scan.onPostExecute)
  }

  // Approval data loop: durable asked/decided audit events correlate with
  // pre-approval verdicts, so shadow mode accumulates the agreement dataset
  // (headline: asks Jev would auto-approve but the human rejected).
  ctx.on('session/event', createApprovalLoopListener({ trace: approvalTrace, telemetry, live }))

  const setLive = async (patch: Partial<LiveSettings>): Promise<CommandResult> => {
    const result = await updateConfig(patch)
    if ('error' in result) return { kind: 'error', text: result.error }
    const now = live()
    return {
      kind: 'success',
      text: `dsh-jev-interceptor：已${now.enabled ? '启用' : '停用'}，模式 ${now.mode}。`
        + (result.persisted ? ' 已保存到当前 profile。' : ' 仅本次运行生效，可写入 cordis.patch.yml 保留。'),
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
      description: '按模型版本分析遥测，输出阈值建议',
      input: { hint: '[--all] [--model <id>]' },
      handler: async (invocation): Promise<CommandResult> => {
        const tokens = invocation.rawInput.trim().split(/\s+/).filter(Boolean)
        const modelIdx = tokens.indexOf('--model')
        const model = modelIdx < 0 ? undefined : tokens[modelIdx + 1]
        if (modelIdx >= 0 && (model === undefined || model.startsWith('--'))) {
          return { kind: 'error', text: '用法：/jev-calibrate [--all] [--model <id>]' }
        }
        const { report, extras } = await buildCalibration(tokens.includes('--all'), model)
        return { kind: 'success', text: renderCalibration(report, extras) }
      },
    })
    void commandsCtx.commands.register({
      definitionId: jevImpactDefinitionId,
      name: 'jev-impact',
      description: '效果归因：省掉的审批点击、拦截、误批、成本与延迟（全量当前日志）',
      handler: async (): Promise<CommandResult> => {
        const entries = await telemetry.entries(undefined)
        return { kind: 'success', text: renderImpact(summarizeImpact(entries)) }
      },
    })
    void commandsCtx.commands.register({
      definitionId: jevAllowlistDefinitionId,
      name: 'jev-allowlist',
      description: '预批准名单管理：查看/加/删工具（add <tool> | remove <tool> | 建议来自影子数据）',
      input: { hint: '[add <tool> | remove <tool>]' },
      handler: async (invocation): Promise<CommandResult> => {
        const tokens = invocation.rawInput.trim().split(/\s+/).filter(t => t.length > 0)
        const readList = (): string[] => [...resolveSettings(activeConfig()).preapproveToolAllowlist].sort()
        // 无参：显示名单 + 影子建议。
        if (tokens.length === 0) {
          const list = readList()
          const window = await telemetry.entries(2000)
          const { entries } = calibrationWindow(window, activeCalibrationModel())
          const eligible = new Set(suggestAllowlist(window).map(item => item.tool))
          const suggestions = suggestAllowlist(entries).filter(s => !list.includes(s.tool) && eligible.has(s.tool))
          const lines: string[] = ['```', '⚡ 预批准名单（名单内工具经 Jev 双重判断后自动放行）', '']
          lines.push(list.length === 0 ? '  （空——预批准不会自动批任何工具）' : `  ${list.join(' · ')}`)
          if (suggestions.length > 0) {
            lines.push('')
            lines.push('💡 影子数据推荐（全部调用低风险、高置信、低不可逆、无注入嫌疑）：')
            for (const s of suggestions.slice(0, 5)) {
              lines.push(`   ${s.tool}  样本 ${String(s.samples)} · 平均置信 ${s.avgConfidence.toFixed(2)} · 加入：/jev-allowlist add ${s.tool}`)
            }
          } else {
            lines.push('')
            lines.push('  暂无可推荐工具（候选要求某工具的全部历史调用均为低风险高置信）')
          }
          lines.push('```')
          return { kind: 'success', text: lines.join('\n') }
        }
        const [op, tool] = tokens
        if ((op !== 'add' && op !== 'remove') || tool === undefined || tool.length === 0) {
          return { kind: 'error', text: '用法：/jev-allowlist [add <tool> | remove <tool>]；无参查看名单与建议' }
        }
        const current = readList()
        const next = op === 'add'
          ? [...new Set([...current, tool])].sort()
          : current.filter(item => item !== tool)
        if (next.length === current.length && op === 'add') {
          return { kind: 'success', text: `${tool} 已在预批准名单中` }
        }
        if (next.length === current.length && op === 'remove') {
          return { kind: 'error', text: `${tool} 不在预批准名单中（当前：${current.join(' · ') || '空'}）` }
        }
        const result = await updateConfig({ preapproveToolAllowlist: next })
        if ('error' in result) return { kind: 'error', text: result.error }
        return {
          kind: 'success',
          text: `已${op === 'add' ? '加入' : '移出'} ${tool}。当前名单：${next.join(' · ') || '空'}。`
            + (result.persisted ? '' : ' 仅本次运行生效。'),
        }
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
        const s = await getStatus()
        const key = s.keyError ?? ({
          config: '面板或配置文件',
          credentials: `凭据库（${s.keyReference}）`,
          env: `环境（${s.keyReference}）`,
          none: `未找到 ${s.keyReference}（在面板配置 Key，或运行 /jev-key）`,
        }[s.keySource])
        const text = [
          '```',
          '⚡ dsh-jev-interceptor 状态',
          `  运行   ${s.enabled ? '✅ 已启用' : '⏸️ 已停用'}`,
          `  模式   ${s.mode}${s.mode === 'shadow' ? '（只记录）' : '（执行决策）'}`,
          `  源     ${s.provider}${s.endpointOrigin ? ` · ${s.endpointOrigin}` : ''}`,
          `  模型   ${s.model || '未配置'}`,
          s.connectionError === undefined ? '' : `  连接   ${s.connectionError}`,
          `  守门   ${settings.guardEnabled ? '✅' : '❌'}  预批 ${settings.preapproveEnabled ? '✅' : '❌'}  停滞 ${settings.stagnationEnabled ? '✅' : '❌'}  注入扫描 ${settings.untrustedScanEnabled ? '✅' : '❌'}`,
          s.dailyCostLimitUsd > 0
            ? `  成本   今日 $${s.costTodayUsd.toFixed(6)} / 限额 $${s.dailyCostLimitUsd.toFixed(2)}${s.costTodayUsd >= s.dailyCostLimitUsd ? '（已超限，降级中）' : ''}`
            : '',
          `  Key    ${key}`,
          (s.preapproveAllowlist ?? []).length === 0 ? '  预批白名单为空，不会自动批任何工具' : '',
          '  控制: /jev-on /jev-off /jev-mode',
          '  统计: /jev-stats │ 明细: /jev-log │ 校准: /jev-calibrate │ 归因: /jev-impact │ 名单: /jev-allowlist',
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
        const result = await updateConfig({ apiKey: key })
        if ('error' in result) return { kind: 'error', text: result.error }
        return {
          kind: 'success',
          text: result.persisted
            ? 'API Key 已保存到当前 profile。'
            : 'API Key 仅在本次运行生效。可在 profile 中配置长期使用的凭据。',
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
    + `（${route?.provider ?? '连接未配置'}，${route?.model ?? connectionError}）；/jev-on 和 /jev-mode 可运行时切换${allowlistNote}`,
  )
}
