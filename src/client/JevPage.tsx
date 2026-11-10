/** Jev decision panel: overview, decision log, calibration, and settings. Theme tokens and injected CSS provide hover, focus, and responsive styles in light and dark themes. */

import { t, useLocale, setLocale, getLocale } from './i18n.js'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

interface JevStatus {
  enabled: boolean
  mode: 'shadow' | 'enforce'
  provider: string
  model: string
  keyConfigured: boolean
  keySource: 'config' | 'credentials' | 'env' | 'none'
  /** Settings persistence path; null means changes last only for this run. */
  persistPath?: string | null
  /** Today's process-local spending in USD. */
  costTodayUsd?: number
  /** Daily spending limit in USD; zero means unlimited. */
  dailyCostLimitUsd?: number
  /** 预批准工具名单（面板可管理，热生效）。 */
  preapproveAllowlist?: string[]
  guardEnabled: boolean
  preapproveEnabled: boolean
  stagnationEnabled: boolean
}

/** 影子→执行的升级就绪度（本地镜像宿主 ShadowReadiness）。 */
interface Readiness {
  shadowSamples: number
  misApprovals: number
  degradedRate: number
  ready: boolean
  reason: string
}

interface TagSummary {
  tag: string
  calls: number
  degraded: number
  cached: number
  actions: Record<string, number>
  latencyP50?: number
  latencyP95?: number
  costUsd?: number
  inputTokens?: number
  agreementBuckets?: Record<string, number>
}

/** Local mirror of the host CalibrationReport, avoiding browser imports of host types. */
interface Calibration {
  windowSize: number
  counts: { guard: number; preapprove: number; approvalLoop: number }
  modeSplit: { shadow: number; enforce: number }
  advice: Array<{ param: string; current: number; suggested: number; basis: string; samples: number; note: string }>
  insufficient: Array<{ param: string; reason: string }>
  observations: Array<{ param: string; reason: string }>
  /** Comparison with the previous snapshot; absent when no history exists. */
  history?: { previousTs: string; adopted: number; ignored: number; manual?: number }
  /** 预批准候选工具（影子数据推导；一键加入名单）。 */
  allowlistSuggestions?: Array<{ tool: string; samples: number; avgConfidence: number; avgIrreversibility: number; maxInjection: number }>
}

/** Local mirror of the host ImpactSummary. */
interface Impact {
  windowSize: number
  firstTs?: string
  lastTs?: string
  days: number
  sessions: number
  modeSplit: { shadow: number; enforce: number }
  enforce: { denied: number; asked: number; autoApproved: number; stagnationAlerts: number }
  /** Separate actual enforce outcomes from hypothetical shadow comparisons. */
  agreement: { enforce: Record<string, number>; shadow: Record<string, number> }
  cost: { inputTokens: number; costUsd: number; cachedDecisions: number; estimatedCostUsd?: number }
  latency: { p50?: number; p95?: number }
  degraded: { total: number; byReason: Record<string, number> }
}

/** Local subset of TelemetryEntry for decision rows. */
interface LogEntry {
  ts: string
  tag: string
  mode: string
  tool?: string
  action: string
  detail?: string
  latencyMs?: number
  cached?: boolean
  model?: string
  sessionId?: string
  callId?: string
  inputTokens?: number
  costUsd?: number
}

type JevPageProps = PropsRuntime<'main'>

const API = '/api/jev-interceptor'
/** Status and recent decisions do not require second-by-second polling. */
const REFRESH_MS = 20_000
const CSS_TAG_ID = 'dsh-jev-interceptor/panel.css'

/** Theme colors that can be used directly in color-mix. */
const TONE = {
  ok: 'var(--dsw-alias-state-success-primary,#16a34a)',
  warn: 'var(--dsw-alias-state-warn-primary,#d97706)',
  err: 'var(--dsw-alias-state-error-primary,#dc2626)',
  brand: 'var(--dsw-alias-brand-primary,#4d76e6)',
  /** DeepSeek's business-state color supplies a fourth semantic tone. */
  business: 'var(--dsw-alias-state-business-primary,#6366f1)',
  muted: 'var(--dsw-alias-label-secondary,#8a8a8a)',
} as const

type Tone = keyof typeof TONE

function modeLabels(): Record<string, string> {
  return { shadow: t('panel.shadow'), enforce: t('panel.enforce') }
}

function modeHints(): Record<string, string> {
  return {
    shadow: t('panel.recordDecisionsWithoutBlockingOrApprovingCalls'),
    enforce: t('panel.approveCallsOrRequestHumanReviewBased'),
  }
}

/** Localized stage labels, descriptions, and distinct semantic tones. */
function tagMetadata(): Record<string, { label: string; hint: string; tone: Tone }> {
  return {
    guard: { label: t('panel.guard'), hint: t('panel.assessToolCallRiskIrreversibilityAndInjection'), tone: 'brand' },
    preapprove: { label: t('panel.preapproval'), hint: t('panel.skipConfirmationWhenAuthorizationIsClear'), tone: 'ok' },
    'session-reference': { label: t('panel.sessionRetention'), hint: t('panel.scoreTheValueOfReferenceSnapshots'), tone: 'business' },
    'approval-loop': { label: t('panel.approvalAgreement'), hint: t('panel.compareShadowDecisionsWithHumanDecisions'), tone: 'muted' },
    stagnation: { label: t('panel.stagnationDetection'), hint: t('panel.suggestADifferentApproachAfterRepeatedFailures'), tone: 'warn' },
  }
}

/** Action labels and tones: solid colors indicate active decisions, stripes indicate fallback, and gray indicates defaults or skips. */
function actionMetadata(): Record<string, { label: string; tone: Tone; fallback?: boolean }> {
  return {
    delegate: { label: t('panel.allow'), tone: 'business' },
    ask: { label: t('panel.humanReview'), tone: 'warn' },
    deny: { label: t('panel.deny'), tone: 'err' },
    'auto-approve': { label: t('panel.autoApprove'), tone: 'ok' },
    human: { label: t('panel.humanDecision'), tone: 'brand' },
    degraded: { label: t('panel.fallbackAllow'), tone: 'muted', fallback: true },
    skipped: { label: t('panel.skipped'), tone: 'muted' },
    'retention-scored': { label: t('panel.scoreBasedRetention'), tone: 'ok' },
    'retention-fifo': { label: t('panel.fifoEviction'), tone: 'muted' },
    agreement: { label: t('panel.agreement'), tone: 'brand' },
    'stagnation-alert': { label: t('panel.stagnationAlert'), tone: 'warn' },
  }
}

/** Stripes distinguish fallback from active decisions. */
const FADED_FILL = 'repeating-linear-gradient(45deg, var(--dsw-alias-label-secondary,#8a8a8a) 0 3px, transparent 3px 7px)'

function actionMeta(action: string): { label: string; tone: Tone; fallback?: boolean } {
  return actionMetadata()[action] ?? { label: action, tone: 'brand' }
}

/** Legend and stacked-bar fills: striped fallback, solid active decisions. */
function actionFill(meta: { tone: Tone; fallback?: boolean }): string {
  return meta.fallback === true ? FADED_FILL : TONE[meta.tone]
}

/** Approval-loop agreement bucket labels and semantic tones. */
function bucketLabels(): Record<string, { label: string; tone: Tone }> {
  return {
    'would-over-approve': { label: t('panel.wouldOverApprove'), tone: 'err' },
    'aligned-approve': { label: t('panel.alignedApprove'), tone: 'ok' },
    'aligned-reject': { label: t('panel.alignedReject'), tone: 'ok' },
    'friction-human-approved': { label: t('panel.extraHumanConfirmation'), tone: 'warn' },
    neutral: { label: t('panel.neutral'), tone: 'muted' },
  }
}

function providers() {
  return [
    { id: 'typesafe', label: 'TypeSafe', hint: t('panel.officialJevEndpointWithTheLowestLatency') },
    { id: 'openrouter', label: 'OpenRouter', hint: t('panel.accessThroughOpenrouterNoWaitlistRequired') },
    { id: 'custom', label: t('panel.custom'), hint: t('panel.proxyOrSelfHostedEndpointCompatibleWith') },
  ]
}

function keySources(): Record<string, string> {
  return {
    config: t('panel.panelOrConfigurationFile'),
    credentials: t('panel.credentialStore'),
    env: t('panel.environmentVariable'),
    none: t('panel.notConfigured'),
  }
}

/** Local mirror of the host PingResult. */
interface PingResult {
  ok: boolean
  latencyMs: number
  model?: string
  error?: string
}

/** Localized connection errors; rate limiting still confirms successful authentication. */
function pingErrors(): Record<string, string> {
  return {
    'no-key': t('panel.apiKeyIsNotConfigured'),
    'network': t('panel.networkErrorCannotReachTheEndpoint'),
    'timeout': t('panel.timedOutCheckTheNetworkProxyOr'),
    'auth': t('panel.authenticationFailedTheKeyIsInvalidOr'),
    'not-found': t('panel.endpointNotFoundCheckProviderOrBase'),
    'rate-limited': t('panel.keyIsValidRateLimitedTryAgain'),
    'server': t('panel.serverErrorProviderIssue'),
    'invalid-response': t('panel.unexpectedResponseTheEndpointMayNotSupport'),
  }
}

/** Keep the first three and last four key characters; mask short keys entirely. */
function maskKey(value: string): string {
  const v = value.trim()
  if (v.length <= 8) return '••••••••'
  return `${v.slice(0, 3)}••••${v.slice(-4)}`
}

/** One-line connection test result. */
function pingText(result: PingResult): string {
  if (result.ok && result.error === undefined) {
    return t('panel.connectedMs', { v0: result.model !== undefined ? ` · ${result.model}` : '', v1: String(result.latencyMs) })
  }
  if (result.error === 'rate-limited') return t('panel.keyIsValidRateLimitedMs', { v0: String(result.latencyMs) })
  return `${pingErrors()[result.error ?? ''] ?? t('panel.failed', { v0: result.error ?? t('panel.unknownError') })} · ${String(result.latencyMs)}ms`
}

function tabs() {
  return [
    { id: 'overview', label: t('panel.overview') },
    { id: 'log', label: t('panel.decisionLog') },
    { id: 'calibration', label: t('panel.thresholdCalibration') },
    { id: 'settings', label: t('panel.settings') },
  ] as const
}

/** Panel CSS follows official theme tokens for light, dark, and third-party themes. */
export const PANEL_CSS = `
.jev-root{height:100%;min-height:0;max-height:100vh;box-sizing:border-box;padding:20px 24px 24px;display:flex;flex-direction:column;gap:14px;max-width:1120px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary);}
.jev-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;}
.jev-logo{flex:none;width:34px;height:34px;border-radius:11px;display:grid;place-items:center;font-size:16px;line-height:1;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d76e6) 13%,transparent);}
.jev-headtext{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}
.jev-title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.jev-title{margin:0;font-size:16px;font-weight:600;line-height:22px;}
.jev-sub{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}
.jev-head-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.jev-status{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;line-height:18px;padding:1px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);white-space:nowrap;}
.jev-status[data-on="1"]{color:var(--dsw-alias-state-success-primary,#16a34a);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 42%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 10%,transparent);}
.jev-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none;}
.jev-status[data-on="1"] .jev-dot{box-shadow:0 0 0 3px color-mix(in srgb,currentColor 20%,transparent);}
.jev-btn{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 12px;font-size:12px;font-family:inherit;cursor:pointer;white-space:nowrap;transition:background .12s ease,border-color .12s ease,color .12s ease;}
.jev-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#4d76e6);color:var(--dsw-alias-brand-primary,#4d76e6);}
.jev-btn:disabled{opacity:.45;cursor:default;}
.jev-btn--primary{background:var(--dsw-alias-brand-primary,#4d76e6);border-color:var(--dsw-alias-brand-primary,#4d76e6);color:var(--dsw-alias-bg-base,#fff);}
.jev-btn--primary:hover:not(:disabled){color:var(--dsw-alias-bg-base,#fff);opacity:.88;}
.jev-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;}
.jev-seg>button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);padding:4px 10px;font-size:11.5px;font-family:inherit;cursor:pointer;}
.jev-seg>button+button{border-left:1px solid var(--dsw-alias-border-l1);}
.jev-seg>button:hover:not(:disabled){color:var(--dsw-alias-label-primary);}
.jev-seg>button[data-on="1"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d76e6) 14%,transparent);color:var(--dsw-alias-brand-primary,#4d76e6);font-weight:500;}
.jev-seg>button:disabled{opacity:.5;cursor:default;}
.jev-toast{display:flex;align-items:center;gap:8px;border-radius:8px;padding:6px 11px;font-size:12px;border:1px solid transparent;}
.jev-toast[data-tone="ok"]{color:var(--dsw-alias-state-success-primary,#16a34a);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 28%,transparent);}
.jev-toast[data-tone="err"]{color:var(--dsw-alias-state-error-primary,#dc2626);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 28%,transparent);}
.jev-toast[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary,#d97706);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 28%,transparent);}
.jev-banner{border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 32%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 8%,transparent);color:var(--dsw-alias-state-warn-primary,#d97706);border-radius:10px;padding:7px 11px;font-size:11.5px;line-height:17px;}
.jev-hero{border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);padding:13px 15px;display:flex;gap:18px;flex-wrap:wrap;align-items:center;}
.jev-kpis{flex:1 1 460px;min-width:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:9px;}
.jev-kpi{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:8px 11px;min-width:0;}
.jev-kpi b{display:block;font-size:18px;line-height:23px;font-weight:600;font-variant-numeric:tabular-nums;}
.jev-kpi span{display:block;font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.jev-kpi[data-tone="ok"] b{color:var(--dsw-alias-state-success-primary,#16a34a);}
.jev-kpi[data-tone="warn"] b{color:var(--dsw-alias-state-warn-primary,#d97706);}
.jev-kpi[data-tone="err"] b{color:var(--dsw-alias-state-error-primary,#dc2626);}
.jev-hero-side{flex:0 1 250px;min-width:210px;display:flex;flex-direction:column;gap:6px;font-size:11.5px;}
.jev-fact{display:flex;align-items:center;gap:8px;justify-content:space-between;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}
.jev-fact>b{font-weight:500;font-size:12px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:62%;}
.jev-tabs{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-top:2px;}
.jev-tab{position:relative;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12.5px;padding:7px 11px;cursor:pointer;border-radius:8px 8px 0 0;}
.jev-tab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,var(--dsw-alias-label-primary,#000) 5%,transparent));}
.jev-tab[data-on="1"]{color:var(--dsw-alias-label-primary);font-weight:600;}
.jev-tab[data-on="1"]::after{content:"";position:absolute;left:9px;right:9px;bottom:-1px;height:2px;border-radius:2px;background:var(--dsw-alias-brand-primary,#4d76e6);}
.jev-tab-count{margin-left:6px;font-size:10.5px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-variant-numeric:tabular-nums;}
.jev-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;}
.jev-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;display:flex;flex-direction:column;gap:9px;min-width:0;}
.jev-card-head{display:flex;align-items:flex-start;gap:10px;}
.jev-card-title{font-size:13px;font-weight:600;line-height:18px;}
.jev-card-sub{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}
.jev-card-metrics{margin-left:auto;text-align:right;font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-variant-numeric:tabular-nums;white-space:nowrap;}
.jev-stack{display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--dsw-alias-border-l1);}
.jev-stack>i{display:block;height:100%;}
.jev-legend{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px;}
.jev-legend>li{display:flex;align-items:center;gap:7px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);min-width:0;}
.jev-swatch{width:8px;height:8px;border-radius:2px;flex:none;}
.jev-legend-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.jev-legend>li>b{font-weight:500;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;}
.jev-legend-pct{width:40px;text-align:right;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-variant-numeric:tabular-nums;}
.jev-badge{display:inline-flex;align-items:center;font-size:10.5px;line-height:16px;padding:0 7px;border-radius:999px;white-space:nowrap;border:1px solid transparent;font-variant-numeric:tabular-nums;}
.jev-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.jev-chips{display:flex;gap:6px;flex-wrap:wrap;}
.jev-chip{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:999px;padding:3px 11px;font-size:11.5px;font-family:inherit;cursor:pointer;}
.jev-chip:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);}
.jev-chip[data-on="1"]{border-color:var(--dsw-alias-brand-primary,#4d76e6);color:var(--dsw-alias-brand-primary,#4d76e6);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d76e6) 10%,transparent);}
.jev-chip>b{margin-left:5px;font-weight:500;font-variant-numeric:tabular-nums;opacity:.75;}
.jev-search{flex:1;min-width:150px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:inherit;padding:5px 10px;font-size:12px;outline:none;font-family:inherit;}
.jev-search:focus{border-color:var(--dsw-alias-brand-primary,#4d76e6);}
.jev-table{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;}
.jev-thead,.jev-row{display:grid;grid-template-columns:92px 84px minmax(90px,1fr) 96px 68px 52px minmax(130px,2fr);gap:8px;align-items:center;padding:5px 12px;}
.jev-thead{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1);font-weight:500;}
.jev-row{border-top:1px solid var(--dsw-alias-border-l1);font-size:11.5px;line-height:17px;cursor:pointer;transition:background .1s ease;}
.jev-thead+.jev-row{border-top:0;}
.jev-row:hover{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,var(--dsw-alias-label-primary,#000) 5%,transparent));}
.jev-row[data-open="1"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d76e6) 6%,transparent);}
.jev-cell{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.jev-time{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);}
.jev-time>i{font-style:normal;margin-left:6px;font-size:10px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}
.jev-mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);}
.jev-num{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);}
.jev-strong{color:var(--dsw-alias-label-primary);}
.jev-detail{font-size:10.5px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}
.jev-detail-full{grid-column:1/-1;display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:4px 16px;padding:7px 0 3px;margin-top:5px;border-top:1px dashed var(--dsw-alias-border-l1);font-size:11px;line-height:16px;}
.jev-kv{display:flex;gap:6px;min-width:0;}
.jev-kv>span{flex:none;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}
.jev-kv>b{font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.jev-note{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));margin:0;}
.jev-advice{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);padding:9px 11px;display:flex;flex-direction:column;gap:3px;}
.jev-advice-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;line-height:18px;}
.jev-param{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;font-weight:600;}
.jev-delta{font-variant-numeric:tabular-nums;font-size:11.5px;color:var(--dsw-alias-brand-primary,#4d76e6);}
.jev-delta>i{font-style:normal;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}
.jev-field{display:flex;flex-direction:column;gap:5px;}
.jev-field-label{font-size:11.5px;color:var(--dsw-alias-label-secondary);}
.jev-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:inherit;padding:6px 10px;font-size:12.5px;outline:none;font-family:inherit;}
.jev-input:focus{border-color:var(--dsw-alias-brand-primary,#4d76e6);}
.jev-provider{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;}
.jev-provider>button{text-align:left;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);border-radius:10px;padding:8px 11px;font-family:inherit;cursor:pointer;color:inherit;}
.jev-provider>button:hover{border-color:var(--dsw-alias-border-l2);}
.jev-provider>button[data-on="1"]{border-color:var(--dsw-alias-brand-primary,#4d76e6);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d76e6) 8%,transparent);}
.jev-provider b{display:block;font-size:12.5px;line-height:18px;font-weight:600;}
.jev-provider span{display:block;font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}
.jev-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;padding:26px 16px;display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px;}
.jev-empty b{font-size:13px;color:var(--dsw-alias-label-primary);font-weight:600;}
.jev-row-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;}
.jev-mini{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;}
.jev-mini>li{display:flex;align-items:center;gap:8px;padding:4px 0;border-top:1px solid var(--dsw-alias-border-l1);font-size:11.5px;line-height:17px;min-width:0;}
.jev-mini>li:first-child{border-top:0;}
@media (max-width:820px){.jev-col-mode{display:none;}.jev-thead,.jev-row{grid-template-columns:84px 78px minmax(80px,1fr) 90px 62px minmax(110px,1.6fr);}}
@media (max-width:620px){.jev-root{padding:14px;}.jev-thead{display:none;}.jev-row{grid-template-columns:78px minmax(0,1fr) auto;row-gap:2px;}.jev-col-tag,.jev-col-lat,.jev-col-mode,.jev-col-detail{display:none;}}
`

/** Inject panel styles once, following the data-plugin-css convention. */
export function injectPanelCss(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${CSS_TAG_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-jev-interceptor'
  tag.dataset.pluginCss = CSS_TAG_ID
  tag.textContent = PANEL_CSS
  document.head.appendChild(tag)
}

/** Theme-aware translucent background using color-mix. */
function tint(color: string, amount: number): string {
  return `color-mix(in srgb,${color} ${String(amount)}%,transparent)`
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** ISO timestamp to local HH:MM:SS. */
function clockOf(ts: string): string {
  const millis = Date.parse(ts)
  if (!Number.isFinite(millis)) return '--:--:--'
  const date = new Date(millis)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

/** Relative time is recalculated when the panel refreshes. */
function relativeOf(ts: string): string {
  const millis = Date.parse(ts)
  if (!Number.isFinite(millis)) return ''
  const delta = Date.now() - millis
  if (!Number.isFinite(delta) || delta < 0) return ''
  if (delta < 5_000) return t('panel.justNow')
  if (delta < 60_000) return t('panel.sAgo', { v0: String(Math.floor(delta / 1_000)) })
  if (delta < 3_600_000) return t('panel.mAgo', { v0: String(Math.floor(delta / 60_000)) })
  if (delta < 86_400_000) return t('panel.hAgo', { v0: String(Math.floor(delta / 3_600_000)) })
  return t('panel.dAgo', { v0: String(Math.floor(delta / 86_400_000)) })
}

function fmtNum(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(getLocale() === 'zh' ? 'zh-CN' : 'en-US') : '0'
}

function shortId(value: string | undefined): string {
  if (typeof value !== 'string' || value.length === 0) return '—'
  return value.length > 14 ? `${value.slice(0, 10)}…` : value
}


/** Match host renderImpact formatting: six decimals below $0.01. */
function fmtUsd(value: number): string {
  return `$${value < 0.01 ? value.toFixed(6) : value.toFixed(4)}`
}

/** Prefer recorded cost, then estimated cost, then an empty string. */
function fmtUsdCard(cost: Impact['cost']): string {
  if (cost.costUsd > 0) return fmtUsd(cost.costUsd)
  if (cost.estimatedCostUsd !== undefined) return `≈${fmtUsd(cost.estimatedCostUsd)}`
  return ''
}

/** Show missing samples explicitly rather than presenting 0/0 as zero. */
function misApprovalBadge(impact: Impact): React.JSX.Element {
  const enforceWoap = impact.agreement.enforce['would-over-approve'] ?? 0
  const hasSamples = enforceWoap > 0 || impact.enforce.autoApproved > 0
    || Object.values(impact.agreement.enforce).some(n => n > 0)
  if (!hasSamples) return <Badge tone="muted">{t('panel.overApprovalsNoSamples')}</Badge>
  return enforceWoap === 0
    ? <Badge tone="ok">{t('panel.overApprovals0')}</Badge>
    : <Badge tone="err">{t('panel.overApprovals', { v0: fmtNum(enforceWoap) })}</Badge>
}

/** Match the host renderImpact summary branches. */
function oneLineSummary(impact: Impact): string {
  const costText = fmtUsdCard(impact.cost)
  const suffix = impact.cost.cachedDecisions > 0 ? t('panel.cacheHitsAtNoCost', { v0: fmtNum(impact.cost.cachedDecisions) }) : ''
  if (impact.enforce.autoApproved > 0 || impact.enforce.denied > 0) {
    return t('panel.decisionsHandledAutomatically', { v0: fmtNum(impact.enforce.autoApproved + impact.enforce.denied) })
      + t('panel.overApprovals2', { v0: fmtNum(impact.agreement.enforce['would-over-approve'] ?? 0) })
      + (costText.length > 0 ? t('panel.cost', { v0: costText }) : '')
      + suffix
  }
  if (impact.enforce.asked + impact.enforce.stagnationAlerts > 0) {
    return t('panel.enforceHumanReviewsAndStagnationAlertsNo', { v0: fmtNum(impact.enforce.asked), v1: fmtNum(impact.enforce.stagnationAlerts), v2: suffix })
  }
  if (impact.modeSplit.shadow > 0) return t('panel.noEnforceActionsYetShadowDataIs', { v0: suffix })
  return t('panel.noEnforceActionsYet', { v0: suffix })
}

function tagMeta(tag: string): { label: string; hint: string; tone: Tone } {
  return tagMetadata()[tag] ?? { label: tag, hint: '', tone: 'muted' }
}

/** Parameter colors: guard is blue, preapproval is green. */
function paramTone(param: string): Tone {
  if (param.startsWith('guard')) return 'brand'
  if (param.startsWith('preapprove')) return 'ok'
  return 'muted'
}

/** Include the index because timestamps may repeat. */
function entryKey(entry: LogEntry, index: number): string {
  return `${entry.ts}|${entry.callId ?? entry.tool ?? ''}|${entry.action}|${String(index)}`
}

/** Fetch JSON and retain HTTP status so callers can distinguish 401 from 404. */
async function getJson(path: string): Promise<unknown> {
  const response = await fetch(API + path, { headers: { 'cache-control': 'no-store' } })
  if (!response.ok) {
    const error = new Error(`HTTP ${String(response.status)}`) as Error & { status?: number }
    error.status = response.status
    throw error
  }
  return await response.json() as unknown
}

/** Update configuration, surfacing server errors on failure. */
async function putConfig(patch: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${API}/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (response.ok) return
  let detail = `HTTP ${String(response.status)}`
  try {
    const body = await response.json() as { error?: unknown; code?: unknown; fields?: unknown }
    if (body.code === 'invalid-threshold' && Array.isArray(body.fields)) {
      detail = t('panel.invalidThreshold', { fields: body.fields.join(', ') })
    } else if (typeof body.error === 'string') detail = body.error
  } catch {
    // Preserve the HTTP status when the response is not JSON.
  }
  throw new Error(detail)
}

function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }): React.JSX.Element {
  const color = TONE[tone]
  return (
    <span className="jev-badge" style={{ color, background: tint(color, 12), borderColor: tint(color, 30) }}>
      {children}
    </span>
  )
}

function Kpi({ label, value, tone, hint }: { label: string; value: number; tone?: Tone; hint: string }): React.JSX.Element {
  return (
    <div className="jev-kpi" data-tone={tone} title={hint}>
      <b>{fmtNum(value)}</b>
      <span>{label}</span>
    </div>
  )
}

interface SegmentOption { value: string; label: string; title?: string }

function Segmented({ value, options, onChange, disabled, label }: {
  value: string
  options: readonly SegmentOption[]
  onChange: (next: string) => void
  disabled?: boolean
  label: string
}): React.JSX.Element {
  return (
    <div className="jev-seg" role="group" aria-label={label}>
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          data-on={option.value === value ? '1' : '0'}
          title={option.title}
          disabled={disabled}
          onClick={() => { if (option.value !== value) onChange(option.value) }}
        >{option.label}</button>
      ))}
    </div>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return <div className="jev-fact"><span>{label}</span><b>{children}</b></div>
}

/** Per-stage distribution card with a stage color, stacked bar, and legend. */
/** 每日决策量柱状图（近 14 个活跃日；主体=常规决策，顶段=拦截/转人工）。
 * 按可视化规范：堆叠段间 2px 表面间隙、柱顶 4px 圆角、基线、色点图例。 */
function DailyTrend({ log }: { log: LogEntry[] }): React.JSX.Element | null {
  const days = useMemo(() => {
    const byDay = new Map<string, { total: number; flagged: number }>()
    for (const entry of log) {
      const day = entry.ts.slice(0, 10)
      const bucket = byDay.get(day) ?? { total: 0, flagged: 0 }
      bucket.total += 1
      if (entry.action === 'deny' || entry.action === 'ask') bucket.flagged += 1
      byDay.set(day, bucket)
    }
    return [...byDay.entries()].sort((left, right) => (left[0] < right[0] ? -1 : 1)).slice(-14)
  }, [log])
  if (days.length === 0) return null
  const max = Math.max(...days.map(d => d[1].total), 1)
  // 日期轴：首/中/尾三个锚点（14 根柱全标会碰撞）。
  const tickAt = (index: number): boolean => index === 0 || index === Math.floor((days.length - 1) / 2) || index === days.length - 1
  return (
    <section className="jev-card">
      <header className="jev-card-head">
        <div>
          <div className="jev-card-title">{t('panel.dailyDecisions')}</div>
          <div className="jev-card-sub">{t('panel.lastNActiveDays', { v0: String(days.length) })}</div>
        </div>
        {/* 标准色点图例：两段成分，不用文字解释图本身 */}
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>
            <i style={{ width: 9, height: 9, borderRadius: 2, background: TONE.brand, display: 'inline-block' }} />{t('panel.routineDecisions')}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>
            <i style={{ width: 9, height: 9, borderRadius: 2, background: TONE.warn, display: 'inline-block' }} />{t('panel.flaggedEscalated')}
          </span>
          <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))' }}>{t('panel.peakPerDay', { v0: String(max) })}</span>
        </div>
      </header>
      {/* 图表区封顶：柱宽 ≤28px（14 根 × (28+6) - 6 ≈ 446px），不随卡片宽度无限变粗 */}
      <div style={{ maxWidth: 446, marginRight: 'auto' }}>
        <div style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 6,
          height: 96,
          paddingBottom: 4,
          borderBottom: '1px solid var(--dsw-alias-border-l1)',
        }}>
          {days.map(([day, { total, flagged }]) => (
            <div
              key={day}
              title={flagged > 0 ? t('panel.dayTooltipFlagged', { v0: day.slice(5), v1: String(total), v2: String(flagged) }) : t('panel.dayTooltip', { v0: day.slice(5), v1: String(total) })}
              style={{ flex: '1 1 0', maxWidth: 28, height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}
            >
              {flagged > 0 && (
                <div style={{
                  height: `${String(flagged / max * 100)}%`,
                  background: TONE.warn,
                  borderRadius: '4px 4px 0 0',
                  marginBottom: 2, // 堆叠段之间的表面间隙
                }} />
              )}
              <div style={{
                height: `${String((total - flagged) / max * 100)}%`,
                background: TONE.brand,
                borderRadius: flagged > 0 ? '0' : '4px 4px 0 0', // 顶段存在时主体不封顶
                minHeight: 2,
              }} />
            </div>
          ))}
        </div>
        {/* 日期轴锚点（与柱同宽结构，保持对齐） */}
        <div style={{ display: 'flex', gap: 6, marginTop: 3 }}>
          {days.map(([day], index) => (
            <span key={day} style={{ flex: '1 1 0', maxWidth: 28, fontSize: 10, color: 'var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))', textAlign: index === 0 ? 'left' : index === days.length - 1 ? 'right' : 'center', fontFamily: 'var(--ds-font-family-code,ui-monospace,monospace)' }}>
              {tickAt(index) ? day.slice(5).replace('-', '/') : ''}
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}

/** 工具维度 Top 榜：哪个工具被判断最多、被拦最多（log 窗口内）。 */
function ToolTopCard({ log }: { log: LogEntry[] }): React.JSX.Element | null {
  const tools = useMemo(() => {
    const byTool = new Map<string, { total: number; byAction: Record<string, number> }>()
    for (const entry of log) {
      const tool = entry.tool ?? '—'
      const bucket = byTool.get(tool) ?? { total: 0, byAction: {} }
      bucket.total += 1
      bucket.byAction[entry.action] = (bucket.byAction[entry.action] ?? 0) + 1
      byTool.set(tool, bucket)
    }
    return [...byTool.entries()].sort((left, right) => right[1].total - left[1].total).slice(0, 8)
  }, [log])
  if (tools.length === 0) return null
  const max = tools[0][1].total
  return (
    <section className="jev-card">
      <header className="jev-card-head">
        <div>
          <div className="jev-card-title">{t('panel.toolTop8')}</div>
          <div className="jev-card-sub">{t('panel.decisionVolumeAndActionMix')}</div>
        </div>
      </header>
      {tools.map(([tool, { total, byAction }]) => (
        <div key={tool} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
          <span className="jev-mono" style={{ flex: '0 0 128px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={tool}>{tool}</span>
          <div style={{ flex: 1, display: 'flex', height: 10, overflow: 'hidden', borderRadius: 5 }}>
            {Object.entries(byAction).sort((l, r) => r[1] - l[1]).map(([action, n]) => (
              <i key={action} title={`${actionMeta(action).label} ${String(n)}`} style={{ width: `${String(n / max * 100)}%`, background: actionFill(actionMeta(action)), borderRight: '2px solid var(--dsw-alias-bg-base,#fff)' }} />
            ))}
          </div>
          <b style={{ flex: '0 0 40px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{String(total)}</b>
        </div>
      ))}
    </section>
  )
}
function TagCard({ summary }: { summary: TagSummary }): React.JSX.Element {
  const meta = tagMeta(summary.tag)
  const toneColor = TONE[meta.tone]
  const actions = summary.actions ?? {}
  const entries = Object.entries(actions).filter(entry => entry[1] > 0).sort((left, right) => right[1] - left[1])
  const total = summary.calls > 0 ? summary.calls : entries.reduce((sum, entry) => sum + entry[1], 0)
  const buckets = summary.agreementBuckets === undefined
    ? []
    : Object.entries(summary.agreementBuckets).filter(entry => entry[1] > 0)
  return (
    <article className="jev-card" style={{ borderLeft: `3px solid ${toneColor}` }}>
      <header className="jev-card-head">
        <div style={{ minWidth: 0 }}>
          <div className="jev-card-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span className="jev-swatch" style={{ background: toneColor, width: 9, height: 9, flex: 'none' }} />
            {meta.label}
          </div>
          <div className="jev-card-sub">{meta.hint}</div>
        </div>
        <div className="jev-card-metrics">
          <div>{t('panel.callCount', { count: fmtNum(total) })}</div>
          {summary.latencyP50 !== undefined ? <div>{`p50 ${String(summary.latencyP50)} / p95 ${String(summary.latencyP95 ?? summary.latencyP50)}ms`}</div> : null}
          {summary.costUsd !== undefined && summary.costUsd > 0 ? <div>{fmtUsd(summary.costUsd)}</div> : null}
          {summary.cached > 0 ? <div style={{ color: TONE.business }}>{t('panel.cachedCount', { v0: String(summary.cached) })}</div> : null}
          {summary.degraded > 0 ? <div style={{ color: TONE.warn }}>{t('panel.fallbacks', { v0: String(summary.degraded) })}</div> : null}
        </div>
      </header>
      <div className="jev-stack">
        {entries.length === 0
          ? <i title={t('panel.noDecisionsInThisWindow')} style={{ width: '100%', background: TONE.muted, opacity: .22 }} />
          : entries.map(entry => (
            <i
              key={entry[0]}
              title={`${actionMeta(entry[0]).label} ${String(entry[1])}`}
              style={{
                width: `${String(total > 0 ? entry[1] / total * 100 : 0)}%`,
                background: actionFill(actionMeta(entry[0])),
                // 堆叠段之间的表面间隙（可视化规范）；末段不加避免贴边空隙。
                borderRight: entry === entries.at(-1) ? undefined : '2px solid var(--dsw-alias-bg-base,#fff)',
              }}
            />
          ))}
      </div>
      {entries.length === 0
        ? <p className="jev-note">{t('panel.noRecordsInThisWindowYet')}</p>
        : (
          <ul className="jev-legend">
            {entries.map(entry => (
              <li key={entry[0]}>
                <span className="jev-swatch" style={{ background: actionFill(actionMeta(entry[0])) }} />
                <span className="jev-legend-label">{actionMeta(entry[0]).label}</span>
                <b>{fmtNum(entry[1])}</b>
                <span className="jev-legend-pct">{`${String(total > 0 ? Math.round(entry[1] / total * 100) : 0)}%`}</span>
              </li>
            ))}
          </ul>
        )}
      {buckets.length === 0 ? null : (
        <ul className="jev-mini">
          {buckets.map(entry => {
            const bucket = bucketLabels()[entry[0]] ?? { label: entry[0], tone: 'muted' as Tone }
            const color = TONE[bucket.tone]
            return (
              <li key={entry[0]}>
                <span style={{ color }}>{bucket.label}</span>
                <b style={{ marginLeft: 'auto', color }}>{fmtNum(entry[1])}</b>
              </li>
            )
          })}
        </ul>
      )}
    </article>
  )
}

/** Expand a decision row to show all fields and scroll the details into view. */
function LogRow({ entry, open, onToggle }: {
  entry: LogEntry
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const detailRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    // Keep expanded details visible when a row is near the bottom of the viewport.
    if (open && detailRef.current !== null) {
      detailRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [open])
  const meta = actionMeta(entry.action)
  const latency = entry.latencyMs === undefined ? '—' : `${entry.cached === true ? '⚡ ' : ''}${String(entry.latencyMs)}ms`
  const detail = entry.detail ?? ''
  return (
    <div
      className="jev-row"
      data-open={open ? '1' : '0'}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={onToggle}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onToggle()
      }}
    >
      <span className="jev-cell jev-time" title={entry.ts}>{clockOf(entry.ts)}<i>{relativeOf(entry.ts)}</i></span>
      <span className="jev-cell jev-col-tag jev-strong" style={{ color: TONE[tagMeta(entry.tag).tone] }}>{tagMeta(entry.tag).label}</span>
      <span className="jev-cell jev-mono jev-col-tool" title={entry.tool ?? ''}>{entry.tool ?? '—'}</span>
      <span className="jev-cell"><Badge tone={meta.tone}>{meta.label}</Badge></span>
      <span className="jev-cell jev-num jev-col-lat">{latency}</span>
      <span className="jev-cell jev-num jev-col-mode">{modeLabels()[entry.mode] ?? entry.mode}</span>
      <span className="jev-cell jev-mono jev-detail jev-col-detail" title={detail}>{detail.length === 0 ? '—' : detail}</span>
      {open && (
        <div ref={detailRef} className="jev-detail-full">
          <div className="jev-kv"><span>{t('panel.mode')}</span><b>{`${modeLabels()[entry.mode] ?? entry.mode} (${entry.mode === 'shadow' ? t('panel.inactive') : t('panel.active')})`}</b></div>
          <div className="jev-kv"><span>{t('panel.model')}</span><b>{entry.model ?? '—'}</b></div>
          <div className="jev-kv"><span>{t('panel.tool')}</span><b>{entry.tool ?? '—'}</b></div>
          <div className="jev-kv"><span>{t('panel.call')}</span><b className="jev-mono" title={entry.callId ?? ''}>{shortId(entry.callId)}</b></div>
          <div className="jev-kv"><span>{t('panel.session')}</span><b className="jev-mono" title={entry.sessionId ?? ''}>{shortId(entry.sessionId)}</b></div>
          <div className="jev-kv"><span>{t('panel.inputTokens')}</span><b>{entry.inputTokens === undefined ? '—' : fmtNum(entry.inputTokens)}</b></div>
          <div className="jev-kv"><span>{t('panel.cost2')}</span><b>{entry.costUsd === undefined ? '—' : `$${entry.costUsd.toFixed(6)}`}</b></div>
          <div className="jev-kv" style={{ gridColumn: '1/-1' }}><span>{t('panel.details')}</span><b className="jev-mono" style={{ whiteSpace: 'normal' }}>{detail.length === 0 ? '—' : detail}</b></div>
        </div>
      )}
    </div>
  )
}

/** Compact recent-decision row for the overview. */
function MiniRow({ entry }: { entry: LogEntry }): React.JSX.Element {
  const meta = actionMeta(entry.action)
  return (
    <li>
      <span className="jev-time" style={{ flex: 'none' }} title={entry.ts}>{clockOf(entry.ts)}</span>
      <span className="jev-mono jev-strong" style={{ flex: '0 0 74px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={entry.tool ?? ''}>{entry.tool ?? '—'}</span>
      <Badge tone={meta.tone}>{meta.label}</Badge>
      <span className="jev-detail" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={entry.detail ?? ''}>{entry.detail ?? '—'}</span>
    </li>
  )
}

export function JevPage(_props: JevPageProps): React.JSX.Element {
  const locale = useLocale()
  const [status, setStatus] = useState<JevStatus | null>(null)
  const [stats, setStats] = useState<TagSummary[]>([])
  const [log, setLog] = useState<LogEntry[]>([])
  const [calib, setCalib] = useState<Calibration | null>(null)
  const [impact, setImpact] = useState<Impact | null>(null)
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  const [tab, setTab] = useState<string>('overview')
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState('')
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState<{ tone: 'ok' | 'err' | 'warn'; text: string } | null>(null)
  const [updatedAt, setUpdatedAt] = useState(0)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [calibBusy, setCalibBusy] = useState(false)
  const [keyDraft, setKeyDraft] = useState('')
  // Preserve a masked, locked value after saving; Replace unlocks the field.
  const [keyLocked, setKeyLocked] = useState(false)
  const [keyMask, setKeyMask] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [pingBusy, setPingBusy] = useState(false)
  const [pingResult, setPingResult] = useState<PingResult | null>(null)
  const [endpointDraft, setEndpointDraft] = useState('')
  const [filterAction, setFilterAction] = useState('all')
  const [filterMode, setFilterMode] = useState('all')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  // Fetch up to 500 rows once and paginate locally without network round trips.
  const [logPage, setLogPage] = useState(1)
  const [pageJump, setPageJump] = useState('')

  const load = useCallback(async (silent: boolean): Promise<void> => {
    if (!silent) setLoading(true)
    try {
      const [statusResult, statsResult, logResult, impactResult, readinessResult] = await Promise.allSettled([
        getJson('/status'),
        getJson('/stats'),
        getJson('/log?limit=500'),
        getJson('/impact'),
        getJson(`/readiness?locale=${getLocale()}`),
      ])
      if (statusResult.status === 'fulfilled') {
        setStatus(statusResult.value as JevStatus)
        setLoadErr('')
      } else {
        const code = (statusResult.reason as { status?: number } | undefined)?.status
        setLoadErr(code === 401
          ? t('panel.signInToReadPanelData')
          : code === 404
            ? t('panel.thePanelApiIsNotRegisteredIn')
            : t('panel.cannotReachTheLocalApiCheckThat'))
      }
      if (statsResult.status === 'fulfilled') {
        setStats(Array.isArray(statsResult.value) ? statsResult.value as TagSummary[] : [])
      }
      if (logResult.status === 'fulfilled') {
        const entries = Array.isArray(logResult.value) ? logResult.value as LogEntry[] : []
        entries.sort((left, right) => (left.ts < right.ts ? 1 : left.ts > right.ts ? -1 : 0))
        setLog(entries)
      }
      if (impactResult.status === 'fulfilled') {
        setImpact(impactResult.value as Impact)
      }
      if (readinessResult.status === 'fulfilled') {
        setReadiness(readinessResult.value as Readiness)
      }
      setUpdatedAt(Date.now())
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => { void load(false) }, [])

  // Skip automatic refresh while hidden to avoid background requests.
  useEffect(() => {
    if (!autoRefresh) return undefined
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void load(true)
    }, REFRESH_MS)
    return () => { clearInterval(timer) }
  }, [autoRefresh, load])

  // Dismiss feedback after four seconds.
  useEffect(() => {
    if (toast === null) return undefined
    const timer = setTimeout(() => { setToast(null) }, 4_000)
    return () => { clearTimeout(timer) }
  }, [toast])

  /** Shared configuration update with optimistic state and rollback on failure. */
  const applyPatch = useCallback(async (
    busyKey: string,
    patch: Record<string, unknown>,
    optimistic?: Partial<JevStatus>,
  ): Promise<boolean> => {
    const previous = status
    setBusy(busyKey)
    setToast(null)
    if (previous !== null && optimistic !== undefined) setStatus({ ...previous, ...optimistic })
    try {
      await putConfig(patch)
      // Explicitly warn when the settings service cannot persist changes across restarts.
      const volatile = previous !== null && previous.persistPath === null
      setToast({
        tone: volatile ? 'warn' : 'ok',
        text: volatile
          ? t('panel.appliedForThisRunOnlySettingsAre')
          : t('panel.saved'),
      })
      void load(true)
      return true
    } catch (error) {
      if (previous !== null) setStatus(previous)
      setToast({ tone: 'err', text: t('panel.saveFailed', { v0: error instanceof Error ? error.message : String(error) }) })
      return false
    } finally {
      setBusy('')
    }
  }, [status, load])

  const saveKey = useCallback(async (): Promise<void> => {
    const value = keyDraft.trim()
    if (value.length < 10) {
      setToast({ tone: 'err', text: t('panel.apiKeyMustContainAtLeast10') })
      return
    }
    const ok = await applyPatch('key', { apiKey: value }, { keyConfigured: true, keySource: 'config' })
    if (ok) {
      // Show the masked key after saving so users can identify which key is configured.
      setKeyMask(maskKey(value))
      setKeyDraft('')
      setKeyLocked(true)
      setPingResult(null)
    }
  }, [keyDraft, applyPatch])

  /** Test an unsaved draft key first, otherwise use the configured key. */
  const runPing = useCallback(async (): Promise<void> => {
    setPingBusy(true)
    setPingResult(null)
    try {
      const draft = keyLocked || keyDraft.trim().length < 10 ? undefined : keyDraft.trim()
      const response = await fetch(`${API}/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft === undefined ? {} : { apiKey: draft }),
      })
      setPingResult(await response.json() as PingResult)
    } catch {
      setPingResult({ ok: false, latencyMs: 0, error: 'network' })
    } finally {
      setPingBusy(false)
    }
  }, [keyDraft, keyLocked])

  const saveEndpoint = useCallback(async (): Promise<void> => {
    const value = endpointDraft.trim()
    if (value.length === 0) {
      setToast({ tone: 'err', text: t('panel.endpointCannotBeEmpty') })
      return
    }
    const ok = await applyPatch('endpoint', { endpoint: value })
    if (ok) setEndpointDraft('')
  }, [endpointDraft, applyPatch])

  const runCalibration = useCallback(async (): Promise<void> => {
    setCalibBusy(true)
    setToast(null)
    try {
      setCalib(await getJson(`/calibration?locale=${getLocale()}`) as Calibration)
    } catch (error) {
      setToast({ tone: 'err', text: t('panel.calibrationFailed', { v0: error instanceof Error ? error.message : String(error) }) })
    } finally {
      setCalibBusy(false)
    }
  }, [])

  /** Apply one threshold immediately, then regenerate advice to show adoption. */
  const applyAdvice = useCallback(async (param: string, suggested: number): Promise<void> => {
    setToast(null)
    // Disable Apply and Generate throughout the request to prevent duplicate writes.
    setCalibBusy(true)
    try {
      await putConfig({ [param]: suggested })
      setToast({ tone: 'ok', text: t('panel.appliedEffectiveOnTheNextCall', { v0: param, v1: suggested.toFixed(2) }) })
      await runCalibration()
    } catch (error) {
      setToast({ tone: 'err', text: t('panel.applyFailed', { v0: error instanceof Error ? error.message : String(error) }) })
    } finally {
      setCalibBusy(false)
    }
  }, [runCalibration])

  /** 更新预批准名单（整组替换，热生效）；add=true 加入 / false 移除。 */
  const applyAllowlist = useCallback(async (tool: string, add: boolean): Promise<void> => {
    if (status === null) return
    const current = status.preapproveAllowlist ?? []
    const next = add
      ? [...new Set([...current, tool])].sort()
      : current.filter(item => item !== tool)
    setToast(null)
    setBusy('allowlist')
    try {
      await putConfig({ preapproveToolAllowlist: next })
      setStatus({ ...status, preapproveAllowlist: next })
      setToast({
        tone: 'ok',
        text: add ? t('panel.allowlistAddedToast', { v0: tool }) : t('panel.allowlistRemovedToast', { v0: tool }),
      })
    } catch (error) {
      setToast({ tone: 'err', text: t('panel.allowlistUpdateFailed', { v0: error instanceof Error ? error.message : String(error) }), })
    } finally {
      setBusy('')
    }
  }, [status])

  /** 跨环节汇总：总数 / 自动批准 / 转人工 / 拒绝 / 降级。 */
  /** Aggregate calls, automatic approvals, reviews, denials, and fallbacks across stages. */
  const aggregate = useMemo(() => {
    const result = { calls: 0, auto: 0, ask: 0, deny: 0, delegate: 0, degraded: 0 }
    for (const summary of stats) {
      result.calls += summary.calls ?? 0
      result.degraded += summary.degraded ?? 0
      for (const [action, count] of Object.entries(summary.actions ?? {})) {
        if (action === 'auto-approve') result.auto += count
        else if (action === 'ask') result.ask += count
        else if (action === 'deny') result.deny += count
        else if (action === 'delegate') result.delegate += count
      }
    }
    return result
  }, [stats])

  const actionCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const entry of log) counts[entry.action] = (counts[entry.action] ?? 0) + 1
    return counts
  }, [log])

  const filteredLog = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return log.filter(entry => (filterAction === 'all' || entry.action === filterAction)
      && (filterMode === 'all' || entry.mode === filterMode)
      && (needle.length === 0
        || (entry.tool ?? '').toLowerCase().includes(needle)
        || (entry.detail ?? '').toLowerCase().includes(needle)))
  }, [log, filterAction, filterMode, query])

  /** Twenty rows keep the table and pagination controls within one viewport. */
  const LOG_PAGE_SIZE = 20
  const totalPages = Math.max(1, Math.ceil(filteredLog.length / LOG_PAGE_SIZE))
  const safePage = Math.min(Math.max(1, logPage), totalPages)
  const rows = useMemo(
    () => filteredLog.slice((safePage - 1) * LOG_PAGE_SIZE, safePage * LOG_PAGE_SIZE),
    [filteredLog, safePage],
  )

  /** Reset to page one when filters change to avoid an empty out-of-range page. */
  useEffect(() => { setLogPage(1) }, [filterAction, filterMode, query])

  /** Change page and scroll the tab body back to the first row. */
  const gotoPage = useCallback((page: number): void => {
    setLogPage(Math.min(Math.max(1, page), totalPages))
    setPageJump('')
    if (typeof document !== 'undefined') {
      const body = document.querySelector('.jev-tab-body')
      if (body !== null) body.scrollTop = 0
    }
  }, [totalPages])

  const recent = useMemo(() => log.slice(0, 6), [log])

  const provider = status === null ? 'typesafe' : status.provider
  const mode = status === null ? 'shadow' : status.mode
  const keySource = status === null ? 'none' : status.keySource
  const activeFilters = filterAction !== 'all' || filterMode !== 'all' || query.trim().length > 0
  const resetFilters = (): void => {
    setFilterAction('all')
    setFilterMode('all')
    setQuery('')
  }
  const filterChips = ['auto-approve', 'ask', 'deny', 'delegate', 'degraded']
    .filter(action => (actionCounts[action] ?? 0) > 0)

  /** 快速开始 + 就绪度：装完 5 分钟跑通闭环的引导（完成后自动消失）。 */
  const renderOnboarding = (): React.JSX.Element | null => {
    if (status === null) return null
    const keyReady = status.keyConfigured || status.keySource === 'credentials' || status.keySource === 'env'
    const enforced = status.enabled && status.mode === 'enforce'
    if (keyReady && enforced && (readiness === null || readiness.ready)) return null
    const step = (done: boolean, index: string, text: string, action?: React.JSX.Element): React.JSX.Element => (
      <li style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
        <span style={{ color: done ? TONE.ok : TONE.brand, fontWeight: 600, flex: 'none', width: 18 }}>{done ? '✓' : index}</span>
        <span style={{ flex: 1, color: done ? 'var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))' : 'inherit', textDecoration: done ? 'line-through' : 'none' }}>{text}</span>
        {done ? null : action}
      </li>
    )
    return (
      <section className="jev-card">
        <header className="jev-card-head">
          <div>
            <div className="jev-card-title">{t('panel.quickStart')}</div>
            <div className="jev-card-sub">{t('panel.quickStartSub')}</div>
          </div>
        </header>
        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {step(keyReady, '1', t('panel.stepConfigureKey'),
            <button className="jev-btn" onClick={() => { setTab('settings') }}>{t('panel.goConfigure')}</button>)}
          {step(status.enabled, '2', t('panel.stepEnablePlugin'),
            <button className="jev-btn jev-btn--primary" disabled={busy !== ''} onClick={() => { void applyPatch('enabled', { enabled: true }, { enabled: true }) }}>{t('panel.enable')}</button>)}
          {step(enforced, '3', readiness !== null && readiness.ready
            ? t('panel.readinessHealthy')
            : readiness !== null ? readiness.reason : t('panel.readinessAssessLater'),
            status.mode === 'shadow' && readiness?.ready === true
              ? <button className="jev-btn jev-btn--primary" disabled={busy !== ''} onClick={() => { void applyPatch('mode', { mode: 'enforce' }, { mode: 'enforce' }) }}>{t('panel.switchToEnforce')}</button>
              : undefined)}
        </ol>
      </section>
    )
  }

  const renderOverview = (): React.JSX.Element => {
    const onboarding = renderOnboarding()
    if (stats.length === 0) {
      return (
        <Fragment>
          {onboarding}
          <div className="jev-empty">
            <b>{t('panel.noDecisionsYet')}</b>
            <div>
            {status !== null && status.enabled
              ? t('panel.enabledTheNextToolCallOrReference')
              : t('panel.onceEnabledJevEvaluatesEachToolCall')}
          </div>
          <div className="jev-row-actions">
            {status !== null && !status.enabled
              ? (
                <button
                  className="jev-btn jev-btn--primary"
                  disabled={busy !== ''}
                  onClick={() => { void applyPatch('enabled', { enabled: true }, { enabled: true }) }}
                >{t('panel.enableJev')}</button>
              )
              : null}
            {keySource === 'none' && (
              <button className="jev-btn" onClick={() => { setTab('settings') }}>{t('panel.configureApiKeyFirst')}</button>
            )}
          </div>
        </div>
        </Fragment>
      )
    }
    return (
      <Fragment>
        {onboarding}
        {impact !== null && impact.windowSize > 0 && (
          <section className="jev-card">
            <header className="jev-card-head">
              <div>
                <div className="jev-card-title">{t('panel.netBenefit')}</div>
                <div className="jev-card-sub">
                  {t('panel.latestRecordsEnforceMetricsFrom', { v0: fmtNum(impact.windowSize), v1: impact.firstTs !== undefined ? impact.firstTs.slice(0, 10) : '—' })
                    + `${impact.lastTs !== undefined ? ` ~ ${impact.lastTs.slice(0, 10)}` : ''}`
                    + t('panel.activeDaysSessions', { v0: String(impact.days), v1: String(impact.sessions) })}
                </div>
              </div>
              <div className="jev-card-metrics">
                {impact.latency.p50 !== undefined ? <div>{`p50 ${String(impact.latency.p50)}ms`}</div> : null}
                {fmtUsdCard(impact.cost)}
              </div>
            </header>
            <div className="jev-chips">
              <Badge tone="ok">{t('panel.confirmationsSaved', { v0: fmtNum(impact.enforce.autoApproved) })}</Badge>
              <Badge tone="err">{t('panel.blocked', { v0: fmtNum(impact.enforce.denied) })}</Badge>
              {impact.enforce.stagnationAlerts > 0
                ? <Badge tone="warn">{t('panel.stagnationAlerts', { v0: fmtNum(impact.enforce.stagnationAlerts) })}</Badge>
                : null}
              {misApprovalBadge(impact)}
              {(impact.agreement.enforce['friction-human-approved'] ?? 0) > 0
                ? <Badge tone="warn">{t('panel.extraHumanReviews', { v0: fmtNum(impact.agreement.enforce['friction-human-approved'] ?? 0) })}</Badge>
                : null}
              {(impact.agreement.shadow['would-over-approve'] ?? 0) > 0
                ? <Badge tone="muted">{t('panel.shadowComparisonWouldApproveHumanRejected', { v0: fmtNum(impact.agreement.shadow['would-over-approve'] ?? 0) })}</Badge>
                : null}
            </div>
            <p className="jev-note">{oneLineSummary(impact)}</p>
          </section>
        )}
        <DailyTrend log={log} />
        <div className="jev-grid">
          {stats.map(summary => <TagCard key={summary.tag} summary={summary} />)}
          <ToolTopCard log={log} />
        </div>
        <p className="jev-note" style={{ marginTop: -4 }}>
          {t('panel.statsWindowCaption', {
            v0: fmtNum(log.length),
            v1: log.length > 0 && log.at(-1) !== undefined
              ? t('panel.statsWindowRange', { v0: log.at(-1)!.ts.slice(0, 10), v1: log[0]!.ts.slice(0, 10) })
              : '',
          })}
        </p>
        <section className="jev-card">
          <header className="jev-card-head">
            <div>
              <div className="jev-card-title">{t('panel.recentDecisions')}</div>
              <div className="jev-card-sub">
                {recent.length === 0 ? t('panel.noRecordsYet') : t('panel.latestNewestFirst', { v0: String(recent.length) })}
              </div>
            </div>
            <button
              className="jev-btn"
              style={{ marginLeft: 'auto' }}
              disabled={log.length === 0}
              onClick={() => { setTab('log') }}
            >{t('panel.viewAll', { v0: log.length > 0 ? ` (${String(log.length)})` : '' })}</button>
          </header>
          {recent.length === 0
            ? <p className="jev-note">{t('panel.recentDecisionsWillAppearHereOnceEnabled')}</p>
            : <ul className="jev-mini">{recent.map((entry, index) => <MiniRow key={entryKey(entry, index)} entry={entry} />)}</ul>}
        </section>
      </Fragment>
    )
  }

  const renderLog = (): React.JSX.Element => {
    return (
      <Fragment>
        <div className="jev-toolbar">
          <div className="jev-chips">
            <button
              className="jev-chip"
              data-on={filterAction === 'all' ? '1' : '0'}
              onClick={() => { setFilterAction('all') }}
            >{t('panel.all')}<b>{fmtNum(log.length)}</b></button>
            {filterChips.map(action => (
              <button
                key={action}
                className="jev-chip"
                data-on={filterAction === action ? '1' : '0'}
                onClick={() => { setFilterAction(action) }}
              >{actionMeta(action).label}<b>{fmtNum(actionCounts[action] ?? 0)}</b></button>
            ))}
          </div>
          <input
            className="jev-search"
            type="search"
            placeholder={t('panel.searchToolNamesOrDetails')}
            value={query}
            onChange={event => { setQuery(event.target.value) }}
          />
          <Segmented
            label={t('panel.filterByDecisionMode')}
            value={filterMode}
            options={[
              { value: 'all', label: t('panel.all') },
              { value: 'shadow', label: t('panel.shadow') },
              { value: 'enforce', label: t('panel.enforce') },
            ]}
            onChange={setFilterMode}
          />
          {activeFilters
            ? <button className="jev-btn" onClick={resetFilters}>{t('panel.clearFilters')}</button>
            : null}
        </div>
        {log.length === 0
          ? (
            <div className="jev-empty">
              <b>{t('panel.noDecisionsYet')}</b>
              <div>{t('panel.onceJevIsEnabledEachToolCall')}</div>
            </div>
          )
          : rows.length === 0
            ? (
              <div className="jev-empty">
                <b>{t('panel.noMatchingDecisions')}</b>
                <div>{t('panel.tryDifferentFiltersOrClearTheSearch')}</div>
                <div className="jev-row-actions">
                  <button className="jev-btn" onClick={resetFilters}>{t('panel.clearFilters')}</button>
                </div>
              </div>
            )
            : (
              <div className="jev-table">
                <div className="jev-thead">
                  <span>{t('panel.time')}</span>
                  <span className="jev-col-tag">{t('panel.stage')}</span>
                  <span className="jev-col-tool">{t('panel.tool')}</span>
                  <span>{t('panel.action')}</span>
                  <span className="jev-col-lat">{t('panel.latency')}</span>
                  <span className="jev-col-mode">{t('panel.mode')}</span>
                  <span>{t('panel.details')}</span>
                </div>
                {rows.map((entry, index) => {
                  const key = entryKey(entry, index)
                  return (
                    <LogRow
                      key={key}
                      entry={entry}
                      open={expanded === key}
                      onToggle={() => { setExpanded(expanded === key ? null : key) }}
                    />
                  )
                })}
              </div>
            )}
        {/* Keep pagination visible at the bottom without negative margins or horizontal overflow. */}
        <div className="jev-toolbar" style={{
          justifyContent: 'center',
          position: 'sticky',
          bottom: 0,
          zIndex: 2,
          background: 'var(--dsw-alias-bg-base,#fff)',
          borderTop: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: '0 0 12px 12px',
          paddingTop: 8,
          paddingBottom: 8,
        }}>
          <button className="jev-btn" disabled={safePage <= 1} onClick={() => { gotoPage(1) }}>{t('panel.first')}</button>
          <button className="jev-btn" disabled={safePage <= 1} onClick={() => { gotoPage(safePage - 1) }}>{t('panel.previous')}</button>
          <span className="jev-note" style={{ whiteSpace: 'nowrap' }}>
            {t('panel.pageRecordsOnThisPageTotal', { v0: String(safePage), v1: String(totalPages), v2: fmtNum(rows.length), v3: fmtNum(filteredLog.length) })}
          </span>
          <button className="jev-btn" disabled={safePage >= totalPages} onClick={() => { gotoPage(safePage + 1) }}>{t('panel.next')}</button>
          <button className="jev-btn" disabled={safePage >= totalPages} onClick={() => { gotoPage(totalPages) }}>{t('panel.last')}</button>
          <span className="jev-note" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {t('panel.goTo')}<input
              className="jev-search"
              style={{ width: 64, flex: 'none', textAlign: 'center' }}
              type="number"
              min={1}
              max={totalPages}
              value={pageJump}
              placeholder={String(safePage)}
              onChange={event => { setPageJump(event.target.value) }}
              onKeyDown={event => {
                if (event.key !== 'Enter') return
                const target = Number.parseInt(pageJump, 10)
                if (Number.isFinite(target)) gotoPage(target)
              }}
            />
            {t('panel.page')}</span>
        </div>
        <p className="jev-note">
          {t('panel.loadedTheLatestRecordsPanelLimit500', { v0: fmtNum(log.length) })}
        </p>
      </Fragment>
    )
  }

  const renderCalibration = (): React.JSX.Element => {
    return (
      <div className="jev-grid">
        <section className="jev-card" style={{ gridColumn: '1/-1' }}>
          <header className="jev-card-head">
            <div>
              <div className="jev-card-title">{t('panel.thresholdCalibrationAdvice')}</div>
              <div className="jev-card-sub">{t('panel.suggestThresholdChangesFromShadowTelemetryAnd')}</div>
            </div>
            <button
              className="jev-btn jev-btn--primary"
              style={{ marginLeft: 'auto' }}
              disabled={calibBusy}
              onClick={() => { void runCalibration() }}
            >{calibBusy ? t('panel.analyzing') : t('panel.generateAdvice')}</button>
          </header>
          {calib === null
            ? (
              <div className="jev-empty">
                <b>{t('panel.noReportYet')}</b>
                <div>{t('panel.generateAReportToSeeWhetherThresholds')}</div>
              </div>
            )
            : (
              <Fragment>
                <div className="jev-chips">
                  <Badge tone="brand">{t('panel.windowRecords', { v0: fmtNum(calib.windowSize) })}</Badge>
                  <Badge tone="muted">{t('panel.guard2', { v0: fmtNum(calib.counts.guard) })}</Badge>
                  <Badge tone="muted">{t('panel.preapproval2', { v0: fmtNum(calib.counts.preapprove) })}</Badge>
                  <Badge tone="muted">{t('panel.agreement2', { v0: fmtNum(calib.counts.approvalLoop) })}</Badge>
                  <Badge tone="muted">{t('panel.shadowEnforce', { v0: fmtNum(calib.modeSplit.shadow), v1: fmtNum(calib.modeSplit.enforce) })}</Badge>
                  {calib.history === undefined ? null : (
                    <Badge tone={calib.history.adopted > 0 ? 'ok' : 'muted'}>
                      {t('panel.previousAdoptedIgnored', { v0: calib.history.previousTs.slice(5, 10), v1: String(calib.history.adopted), v2: String(calib.history.ignored) })
                        + (calib.history.manual !== undefined && calib.history.manual > 0 ? t('panel.manual', { v0: String(calib.history.manual) }) : '')}
                    </Badge>
                  )}
                </div>
                {calib.allowlistSuggestions !== undefined && calib.allowlistSuggestions.length > 0 && (
                  <div>
                    <div className="jev-card-title" style={{ fontSize: 12, marginBottom: 3 }}>
                      {t('panel.allowlistSuggestionsTitle')}
                    </div>
                    {calib.allowlistSuggestions.map(s => (
                      <div key={s.tool} className="jev-advice">
                        <div className="jev-advice-head">
                          <span className="jev-param" style={{ color: TONE.ok }}>{s.tool}</span>
                          <Badge tone="muted">{t('panel.samples', { v0: String(s.samples) })}</Badge>
                          <Badge tone="muted">{t('panel.avgConfidence', { v0: s.avgConfidence.toFixed(2) })}</Badge>
                          <Badge tone="muted">{t('panel.avgIrreversibility', { v0: s.avgIrreversibility.toFixed(2) })}</Badge>
                          <button
                            className="jev-btn jev-btn--primary"
                            style={{ marginLeft: 'auto' }}
                            disabled={busy !== ''}
                            title={t('panel.addToAllowlistTitle')}
                            onClick={() => { void applyAllowlist(s.tool, true) }}
                          >{t('panel.addToAllowlist')}</button>
                        </div>
                      </div>
                    ))}
                    <p className="jev-note">{t('panel.allowlistSuggestionsNote')}</p>
                  </div>
                )}
                {calib.advice.length === 0
                  ? (
                    <div className="jev-empty">
                      <b>{t('panel.noThresholdChangesNeeded')}</b>
                      <div>{t('panel.telemetryMatchesTheCurrentConfigurationOrAll')}</div>
                    </div>
                  )
                  : calib.advice.map(advice => (
                    <div key={advice.param} className="jev-advice">
                      <div className="jev-advice-head">
                        <span className="jev-param" style={{ color: TONE[paramTone(advice.param)] }}>{advice.param}</span>
                        <span className="jev-delta">
                          {advice.current.toFixed(2)}<i> → </i>{advice.suggested.toFixed(2)}
                          {` ${advice.suggested > advice.current ? '↑' : '↓'}`}
                        </span>
                        <Badge tone="muted">{t('panel.samples', { v0: fmtNum(advice.samples) })}</Badge>
                        <button
                          className="jev-btn jev-btn--primary"
                          style={{ marginLeft: 'auto' }}
                          disabled={calibBusy}
                          title={t('panel.applyThisThresholdImmediatelyWithoutRestartingPersistence')}
                          onClick={() => { void applyAdvice(advice.param, advice.suggested) }}
                        >{t('panel.apply')}</button>
                      </div>
                      <p className="jev-note">{advice.basis}</p>
                      {(advice.note ?? '').length === 0 ? null : <p className="jev-note">{advice.note}</p>}
                    </div>
                  ))}
                {calib.insufficient.length === 0 ? null : (
                  <div>
                    <div className="jev-card-title" style={{ fontSize: 12, marginBottom: 3 }}>{t('panel.insufficientSamples')}</div>
                    <p className="jev-note">{calib.insufficient.map(note => note.reason).join('; ')}</p>
                  </div>
                )}
                {calib.observations.length === 0 ? null : (
                  <div>
                    <div className="jev-card-title" style={{ fontSize: 12, marginBottom: 3 }}>{t('panel.observations')}</div>
                    <p className="jev-note">{calib.observations.map(note => note.reason).join('; ')}</p>
                  </div>
                )}
                <p className="jev-note">{t('panel.applyChangesTheThresholdImmediatelyWithoutRestarting')}</p>
              </Fragment>
            )}
        </section>
      </div>
    )
  }

  const renderSettings = (): React.JSX.Element => {
    return (
      <div className="jev-grid">
        <section className="jev-card">
          <header className="jev-card-head">
            <div>
              <div className="jev-card-title">{t('panel.connection')}</div>
              <div className="jev-card-sub">{t('panel.providerControlsTheRequestDestinationChangesTake')}</div>
            </div>
          </header>
          <div className="jev-provider">
            {providers().map(item => (
              <button
                key={item.id}
                type="button"
                data-on={provider === item.id ? '1' : '0'}
                disabled={busy !== ''}
                onClick={() => {
                  if (provider === item.id) return
                  void applyPatch('provider', { provider: item.id }, { provider: item.id })
                }}
              >
                <b>{item.label}</b>
                <span>{item.hint}</span>
              </button>
            ))}
          </div>
          {provider === 'custom'
            ? (
              <div className="jev-field">
                <label className="jev-field-label">Base URL</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="jev-input"
                    placeholder="https://your-proxy.example.com/v1/systemone"
                    value={endpointDraft}
                    onChange={event => { setEndpointDraft(event.target.value) }}
                    onKeyDown={event => {
                      if (event.key !== 'Enter') return
                      void saveEndpoint()
                    }}
                  />
                  <button
                    className="jev-btn"
                    disabled={busy !== '' || endpointDraft.trim().length === 0}
                    onClick={() => { void saveEndpoint() }}
                  >{busy === 'endpoint' ? '…' : t('panel.save')}</button>
                </div>
                <p className="jev-note">{t('panel.leaveEmptyToUseTheConfiguredEndpoint')}</p>
              </div>
            )
            : <p className="jev-note">{t('panel.theProviderSuppliesADefaultEndpointChoose')}</p>}
        </section>

        <section className="jev-card">
          <header className="jev-card-head">
            <div>
              <div className="jev-card-title">API Key</div>
              <div className="jev-card-sub">{t('panel.source', { v0: keySources()[keySource] ?? keySource })}</div>
            </div>
          </header>
          <div className="jev-field">
            <label className="jev-field-label">
              {keyLocked ? t('panel.currentKeyMasked') : keySource === 'none' ? t('panel.pasteYourJevApiKey') : t('panel.overrideExistingKey')}
            </label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {keyLocked ? (
                <Fragment>
                  <input
                    className="jev-input jev-mono"
                    value={keyMask}
                    readOnly
                    disabled
                    style={{ flex: '1 1 150px', opacity: .8 }}
                  />
                  <button
                    className="jev-btn"
                    disabled={busy !== ''}
                    title={t('panel.clearTheFieldAndPasteANew')}
                    onClick={() => { setKeyLocked(false); setKeyMask('') }}
                  >{t('panel.replace')}</button>
                </Fragment>
              ) : (
                <Fragment>
                  <input
                    className="jev-input"
                    type={showKey ? 'text' : 'password'}
                    placeholder={keySource === 'none' ? t('panel.atLeast10Characters') : t('panel.enterANewValueToOverride')}
                    value={keyDraft}
                    onChange={event => { setKeyDraft(event.target.value) }}
                    onKeyDown={event => {
                      if (event.key !== 'Enter') return
                      void saveKey()
                    }}
                  />
                  <button
                    className="jev-btn"
                    disabled={keyDraft.length === 0}
                    onClick={() => { setShowKey(!showKey) }}
                  >{showKey ? t('panel.hide') : t('panel.show')}</button>
                  <button
                    className="jev-btn jev-btn--primary"
                    disabled={busy !== '' || keyDraft.trim().length < 10}
                    onClick={() => { void saveKey() }}
                  >{busy === 'key' ? '…' : t('panel.save')}</button>
                </Fragment>
              )}
              <button
                className="jev-btn"
                disabled={pingBusy || (!keyLocked && keyDraft.trim().length < 10 && keySource === 'none')}
                title={t('panel.sendAMinimalRealRequestToThe')}
                onClick={() => { void runPing() }}
              >{pingBusy ? t('panel.testing') : t('panel.testConnection')}</button>
            </div>
            {pingResult !== null && (
              <p className="jev-note" style={{ color: pingResult.ok ? TONE.ok : TONE.err }}>
                {pingResult.ok ? '✓ ' : '✗ '}{pingText(pingResult)}
              </p>
            )}
          </div>
          <p className="jev-note">{t('panel.theKeyIsSavedOnlyToLocal')}</p>
        </section>

        <section className="jev-card">
          <header className="jev-card-head">
            <div>
              <div className="jev-card-title">{t('panel.activeCapabilities')}</div>
              <div className="jev-card-sub">{t('panel.adjustOtherSwitchesInCordisYmlOr')}</div>
            </div>
          </header>
          <div className="jev-chips">
            <Badge tone={status?.guardEnabled === true ? 'ok' : 'muted'}>{t('panel.guard2', { v0: status?.guardEnabled === true ? t('panel.on') : t('panel.off') })}</Badge>
            <Badge tone={status?.preapproveEnabled === true ? 'ok' : 'muted'}>{t('panel.preapproval2', { v0: status?.preapproveEnabled === true ? t('panel.on') : t('panel.off') })}</Badge>
            <Badge tone={status?.stagnationEnabled === true ? 'ok' : 'muted'}>{t('panel.stagnationDetection2', { v0: status?.stagnationEnabled === true ? t('panel.on') : t('panel.off') })}</Badge>
            <Badge tone={status?.enabled === true ? 'ok' : 'muted'}>{t('panel.masterSwitch', { v0: status?.enabled === true ? t('panel.on') : t('panel.off') })}</Badge>
          </div>
          <div className="jev-field">
            <label className="jev-field-label">{t('panel.mode')}</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Segmented
                label={t('panel.decisionMode')}
                value={mode}
                disabled={busy !== ''}
                options={[
                  { value: 'shadow', label: t('panel.shadow'), title: modeHints().shadow },
                  { value: 'enforce', label: t('panel.enforce'), title: modeHints().enforce },
                ]}
                onChange={next => { void applyPatch('mode', { mode: next }, { mode: next as JevStatus['mode'] }) }}
              />
              <span className="jev-note">{modeHints()[mode]}</span>
            </div>
          </div>
          <p className="jev-note">{t('panel.beforeSwitchingToEnforceModeObserveDecisions')}</p>
        </section>

        <section className="jev-card">
          <header className="jev-card-head">
            <div>
              <div className="jev-card-title">{t('panel.preapprovalAllowlist')}</div>
              <div className="jev-card-sub">
                {t('panel.preapprovalAllowlistSub', { v0: String((status?.preapproveAllowlist ?? []).length) })}
              </div>
            </div>
          </header>
          {(status?.preapproveAllowlist ?? []).length === 0 ? (
            <p className="jev-note">{t('panel.preapprovalAllowlistEmpty')}</p>
          ) : (
            <div className="jev-chips">
              {(status?.preapproveAllowlist ?? []).map(tool => (
                <button
                  key={tool}
                  className="jev-chip"
                  data-on="1"
                  disabled={busy !== ''}
                  title={t('panel.removeFromAllowlistTitle')}
                  onClick={() => { void applyAllowlist(tool, false) }}
                >{tool} ✕</button>
              ))}
            </div>
          )}
          <p className="jev-note">{t('panel.preapprovalEvidenceNote')}</p>
        </section>

        <section className="jev-card">
          <header className="jev-card-head">
            <div>
              <div className="jev-card-title">{t('panel.refresh')}</div>
              <div className="jev-card-sub">
                {updatedAt > 0 ? t('panel.lastUpdated', { v0: clockOf(new Date(updatedAt).toISOString()) }) : t('panel.notRefreshedYet')}
              </div>
            </div>
          </header>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <label className="jev-note" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={event => { setAutoRefresh(event.target.checked) }}
              />
              {t('panel.autoRefreshEverySeconds', { v0: String(REFRESH_MS / 1000) })}
            </label>
            <button
              className="jev-btn"
              disabled={loading}
              onClick={() => { void load(false) }}
            >{loading ? t('panel.refreshing') : t('panel.refreshNow')}</button>
          </div>
          <p className="jev-note">{t('panel.autoRefreshPausesWhileThePageIs')}</p>
        </section>
      </div>
    )
  }

  return (
    <div className="jev-root" lang={locale}>
      <header className="jev-head">
        <div className="jev-logo">⚡</div>
        <div className="jev-headtext">
          <div className="jev-title-row">
            <h2 className="jev-title">{t('panel.jevDecisions')}</h2>
            {status === null ? null : (
              <span className="jev-status" data-on={status.enabled ? '1' : '0'}>
                <i className="jev-dot" />
                {status.enabled
                  ? status.mode === 'shadow' ? t('panel.runningShadowMode') : t('panel.runningEnforceMode')
                  : t('panel.disabled')}
              </span>
            )}
          </div>
          <div className="jev-sub">
            {updatedAt > 0
              ? t('panel.system1RiskAssessmentUpdated', { v0: clockOf(new Date(updatedAt).toISOString()) })
              : t('panel.millisecondSystem1RiskAssessment')}
          </div>
        </div>
        <div className="jev-head-actions">
          <button
            className="jev-btn"
            disabled={loading}
            title={t('panel.reloadStatusAndRecentDecisions')}
            onClick={() => { void load(false) }}
          >{loading ? t('panel.refreshing') : t('panel.refresh')}</button>
          <button
            className="jev-btn"
            type="button"
            aria-label={locale === 'en' ? '切换到中文' : 'Switch to English'}
            disabled={calibBusy}
            onClick={() => {
              setLocale(locale === 'en' ? 'zh' : 'en')
              setToast(null)
              void load(true)
              if (calib !== null) {
                setCalib(null)
                void runCalibration()
              }
            }}
          >{locale === 'en' ? '中文' : 'English'}</button>
          {status === null ? null : (
            <button
              className={status.enabled ? 'jev-btn' : 'jev-btn jev-btn--primary'}
              disabled={busy !== ''}
              title={status.enabled ? t('panel.disableToRestoreNativeDshBehavior') : t('panel.enableJevDecisions')}
              onClick={() => {
                void applyPatch('enabled', { enabled: !status.enabled }, { enabled: !status.enabled })
              }}
            >{busy === 'enabled' ? '…' : status.enabled ? t('panel.disable') : t('panel.enable')}</button>
          )}
        </div>
      </header>

      {loadErr === '' || status === null ? null : <div className="jev-toast" data-tone="err">{loadErr}</div>}
      {toast === null ? null : <div className="jev-toast" data-tone={toast.tone}>{toast.text}</div>}

      {status === null ? null : (
        <section className="jev-hero">
          <div className="jev-kpis">
            <Kpi label={t('panel.totalDecisions')} value={aggregate.calls} hint={t('panel.allAssessmentsInTheStatisticsWindow')} />
            <Kpi label={t('panel.autoApprove')} value={aggregate.auto} tone="ok" hint={t('panel.humanConfirmationsSaved')} />
            <Kpi label={t('panel.humanReview')} value={aggregate.ask} tone="warn" hint={t('panel.uncertainRiskReturnedForHumanReview')} />
            <Kpi label={t('panel.deny')} value={aggregate.deny} tone="err" hint={t('panel.highConfidenceRiskDeniedImmediately')} />
            <Kpi label={t('panel.fallbacks2')} value={aggregate.degraded} tone={aggregate.degraded > 0 ? 'warn' : undefined} hint={t('panel.decisionFailedRevertedToNativeBehavior')} />
          </div>
          <div className="jev-hero-side">
            <div className="jev-fact">
              <span>{t('panel.mode')}</span>
              <Segmented
                label={t('panel.decisionMode')}
                value={mode}
                disabled={busy !== ''}
                options={[
                  { value: 'shadow', label: t('panel.shadow'), title: modeHints().shadow },
                  { value: 'enforce', label: t('panel.enforce'), title: modeHints().enforce },
                ]}
                onChange={next => { void applyPatch('mode', { mode: next }, { mode: next as JevStatus['mode'] }) }}
              />
            </div>
            <Fact label="Provider">{provider}</Fact>
            <Fact label={t('panel.model')}>{status.model}</Fact>
            <Fact label="API Key">{keySources()[keySource] ?? keySource}</Fact>
            <Fact label={t('panel.costToday')}>
              {status.costTodayUsd === undefined
                ? '—'
                : (status.dailyCostLimitUsd ?? 0) > 0
                  ? t('panel.limit', { v0: status.costTodayUsd.toFixed(6), v1: (status.dailyCostLimitUsd ?? 0).toFixed(2), v2: status.costTodayUsd >= (status.dailyCostLimitUsd ?? Infinity) ? t('panel.limitExceededUsingFallback') : '' })
                  : `$${status.costTodayUsd.toFixed(6)}`}
            </Fact>
          </div>
        </section>
      )}

      {status === null || !status.enabled || status.mode !== 'shadow' ? null : (
        <div className="jev-banner">{t('panel.shadowModeDecisionsAreRecordedWithoutBlocking')}</div>
      )}

      {status === null ? null : (
        <nav className="jev-tabs" role="tablist">
          {tabs().map(item => (
            <button
              key={item.id}
              role="tab"
              type="button"
              className="jev-tab"
              data-on={tab === item.id ? '1' : '0'}
              aria-selected={tab === item.id}
              onClick={() => { setTab(item.id) }}
            >
              {item.label}
              {item.id === 'log' && log.length > 0 ? <span className="jev-tab-count">{fmtNum(log.length)}</span> : null}
            </button>
          ))}
        </nav>
      )}

      {loading && status === null ? (
        <div className="jev-empty">
          <b>{t('panel.connectingToTheLocalApi')}</b>
          <div>{t('panel.initialLoadFetchesStatusStatisticsAndThe')}</div>
        </div>
      ) : null}

      {status === null ? null : (
        // The tab body owns scrolling; it does not depend on the parent height chain.
        // The host center column clips overflow, so external scrolling is unavailable.
        // Pagination handles the main log; scrolling supports longer overview and settings content.
        <div className="jev-tab-body" style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
          {tab === 'overview'
            ? renderOverview()
            : tab === 'log'
              ? renderLog()
              : tab === 'calibration'
                ? renderCalibration()
                : renderSettings()}
        </div>
      )}

      {status === null && !loading ? (
        <div className="jev-empty">
          <b>{t('panel.panelStatusIsUnavailable')}</b>
          <div>{loadErr.length === 0 ? t('panel.theHostDidNotRespond') : loadErr}</div>
          <div className="jev-row-actions">
            <button className="jev-btn" onClick={() => { void load(false) }}>{t('panel.retry')}</button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
