/**
 * Jev 决策面板 —— 视觉与信息结构重设计。
 *
 * 视觉层走真 CSS 类（`data-plugin-css` 幂等注入）+ 官方 `--dsw-alias-*` 主题
 * token：内联 style 没有 hover/focus/媒体查询能力，硬编码 rgba 白字在浅色
 * 主题下也会糊成一片。
 *
 * 信息结构：概览（聚合结论 + 最近决策）/ 决策记录（可筛选明细）/ 阈值校准
 * （按需生成）/ 设置（Provider、端点、Key）。配置不再和统计挤在同一列，
 * 明细也不再是没有表头的单行流。
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

interface JevStatus {
  enabled: boolean
  mode: 'shadow' | 'enforce'
  provider: string
  model: string
  keyConfigured: boolean
  keySource: 'config' | 'credentials' | 'env' | 'none'
  /** 设置服务落盘路径；null = 不落盘（保存只在本运行生效）。 */
  persistPath?: string | null
  /** 当日已花（USD，进程内记账）。 */
  costTodayUsd?: number
  /** 每日成本限额（USD）；0 = 不限。 */
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

/** 校准报告（本地镜像宿主 CalibrationReport，面板不 import 宿主类型）。 */
interface Calibration {
  windowSize: number
  counts: { guard: number; preapprove: number; approvalLoop: number }
  modeSplit: { shadow: number; enforce: number }
  advice: Array<{ param: string; current: number; suggested: number; basis: string; samples: number; note: string }>
  insufficient: Array<{ param: string; reason: string }>
  observations: Array<{ param: string; reason: string }>
  /** 与上一份快照的对比摘要（无历史时缺失）。 */
  history?: { previousTs: string; adopted: number; ignored: number; manual?: number }
  /** 预批准候选工具（影子数据推导；一键加入名单）。 */
  allowlistSuggestions?: Array<{ tool: string; samples: number; avgConfidence: number; avgIrreversibility: number; maxInjection: number }>
}

/** 效果归因（本地镜像宿主 ImpactSummary）。 */
interface Impact {
  windowSize: number
  firstTs?: string
  lastTs?: string
  days: number
  sessions: number
  modeSplit: { shadow: number; enforce: number }
  enforce: { denied: number; asked: number; autoApproved: number; stagnationAlerts: number }
  /** 一致率分桶按模式拆开：enforce 实际发生，shadow 假设性对照。 */
  agreement: { enforce: Record<string, number>; shadow: Record<string, number> }
  cost: { inputTokens: number; costUsd: number; cachedDecisions: number; estimatedCostUsd?: number }
  latency: { p50?: number; p95?: number }
  degraded: { total: number; byReason: Record<string, number> }
}

/** 决策明细行（本地镜像 TelemetryEntry 子集）。 */
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
/** 自动刷新间隔：状态灯与最近决策不需要秒级新鲜度。 */
const REFRESH_MS = 20_000
const CSS_TAG_ID = 'dsh-jev-interceptor/panel.css'

/** 主题色调（变量表达式可直接进 color-mix）。 */
const TONE = {
  ok: 'var(--dsw-alias-state-success-primary,#16a34a)',
  warn: 'var(--dsw-alias-state-warn-primary,#d97706)',
  err: 'var(--dsw-alias-state-error-primary,#dc2626)',
  brand: 'var(--dsw-alias-brand-primary,#4d76e6)',
  /** 第四语义色：DeepSeek 品牌色（官方 state-business 变量）。 */
  business: 'var(--dsw-alias-state-business-primary,#6366f1)',
  muted: 'var(--dsw-alias-label-secondary,#8a8a8a)',
} as const

type Tone = keyof typeof TONE

const MODE_LABEL: Record<string, string> = { shadow: '观察', enforce: '执行' }

const MODE_HINT: Record<string, string> = {
  shadow: '只记录决策，不拦截也不放行',
  enforce: '按决策放行或转人工',
}

/** 决策环节（tag）的中文名、一句话说明与专属色调（每个环节一种颜色）。 */
const TAG_META: Record<string, { label: string; hint: string; tone: Tone }> = {
  guard: { label: '守门人', hint: '工具调用的风险 / 不可逆 / 注入判断', tone: 'brand' },
  preapprove: { label: '预批准', hint: '明确已授权就免点击', tone: 'ok' },
  'session-reference': { label: '会话保留', hint: '@ 引用快照的价值打分', tone: 'business' },
  'approval-loop': { label: '审批一致率', hint: '影子决策与人工决定的对照', tone: 'muted' },
  stagnation: { label: '停滞检测', hint: '重复失败时提醒换路', tone: 'warn' },
}

/**
 * 决策动作的中文名与色调。视觉编码约定：
 * - 实色 = Jev 生效的决策（放行紫 / 转人工橙 / 拒绝红 / 自动批绿 / 人工蓝 / 打分绿）；
 * - 斜纹半透明（isFallback）= 降级回退（决策系统没工作，走默认）；
 * - 实灰 = 默认/跳过类。同一张卡内共现的动作颜色互异。
 */
const ACTION_META: Record<string, { label: string; tone: Tone; fallback?: boolean }> = {
  delegate: { label: '放行', tone: 'business' },
  ask: { label: '转人工', tone: 'warn' },
  deny: { label: '拒绝', tone: 'err' },
  'auto-approve': { label: '自动批准', tone: 'ok' },
  human: { label: '人工决定', tone: 'brand' },
  degraded: { label: '降级放行', tone: 'muted', fallback: true },
  skipped: { label: '跳过', tone: 'muted' },
  'retention-scored': { label: '打分保留', tone: 'ok' },
  'retention-fifo': { label: 'FIFO 淘汰', tone: 'muted' },
  agreement: { label: '一致率', tone: 'brand' },
  'stagnation-alert': { label: '停滞提醒', tone: 'warn' },
}

/** 降级回退的斜纹底（与实色决策形成"生效/未生效"的视觉区分）。 */
const FADED_FILL = 'repeating-linear-gradient(45deg, var(--dsw-alias-label-secondary,#8a8a8a) 0 3px, transparent 3px 7px)'

function actionMeta(action: string): { label: string; tone: Tone; fallback?: boolean } {
  return ACTION_META[action] ?? { label: action, tone: 'brand' }
}

/** 图例色块 / 堆叠条段的背景：降级类用斜纹，其余实色。 */
function actionFill(meta: { tone: Tone; fallback?: boolean }): string {
  return meta.fallback === true ? FADED_FILL : TONE[meta.tone]
}

/** 一致率分桶（approval-loop 专属）：标签 + 语义色调。 */
const BUCKET_LABEL: Record<string, { label: string; tone: Tone }> = {
  'would-over-approve': { label: '本会误批', tone: 'err' },
  'aligned-approve': { label: '与人工一致（准）', tone: 'ok' },
  'aligned-reject': { label: '与人工一致（拒）', tone: 'ok' },
  'friction-human-approved': { label: '多一次人工确认', tone: 'warn' },
  neutral: { label: '中性', tone: 'muted' },
}

const PROVIDERS = [
  { id: 'typesafe', label: 'TypeSafe', hint: '官方 Jev 端点，延迟最低' },
  { id: 'openrouter', label: 'OpenRouter', hint: '经 OpenRouter 代理，无需等待名单' },
  { id: 'custom', label: '自定义', hint: '兼容 Jev 协议的代理或自建端点' },
]

const KEY_SOURCE: Record<string, string> = {
  config: '面板或配置文件',
  credentials: '凭据库',
  env: '环境变量',
  none: '未配置',
}

/** 连接测试结果（本地镜像宿主 PingResult）。 */
interface PingResult {
  ok: boolean
  latencyMs: number
  model?: string
  error?: string
}

/** 连接测试错误码 → 中文（rate-limited 视为成功，key 已通过认证）。 */
const PING_ERROR: Record<string, string> = {
  'no-key': '未配置 API Key',
  'network': '网络错误：无法连接端点',
  'timeout': '超时：检查网络/代理，或端点响应过慢',
  'auth': '认证失败：Key 无效或已过期',
  'not-found': '端点不存在：检查 Provider 或 Base URL',
  'rate-limited': 'Key 有效（当前限流中，稍后即可正常使用）',
  'server': '服务端错误：Provider 侧问题',
  'invalid-response': '响应格式异常：端点可能不是 Jev decisions API',
}

/** Key 脱敏：保留头 3 尾 4，中间打码；过短的 key 全打码。 */
function maskKey(value: string): string {
  const v = value.trim()
  if (v.length <= 8) return '••••••••'
  return `${v.slice(0, 3)}••••${v.slice(-4)}`
}

/** 连接测试结果的一行文案。 */
function pingText(result: PingResult): string {
  if (result.ok && result.error === undefined) {
    return `连接正常${result.model !== undefined ? ` · ${result.model}` : ''} · ${String(result.latencyMs)}ms`
  }
  if (result.error === 'rate-limited') return `Key 有效（当前限流中）· ${String(result.latencyMs)}ms`
  return `${PING_ERROR[result.error ?? ''] ?? `失败（${result.error ?? '未知错误'}）`} · ${String(result.latencyMs)}ms`
}

const TABS = [
  { id: 'overview', label: '概览' },
  { id: 'log', label: '决策记录' },
  { id: 'calibration', label: '阈值校准' },
  { id: 'settings', label: '设置' },
] as const

/** 面板样式表（官方主题 token 驱动；深浅主题与第三方主题自动跟随）。 */
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

/** 幂等注入面板样式（官方 data-plugin-css 约定）。 */
export function injectPanelCss(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${CSS_TAG_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-jev-interceptor'
  tag.dataset.pluginCss = CSS_TAG_ID
  tag.textContent = PANEL_CSS
  document.head.appendChild(tag)
}

/** 半透明底色拼装（color-mix 里放主题变量，深浅主题都自洽）。 */
function tint(color: string, amount: number): string {
  return `color-mix(in srgb,${color} ${String(amount)}%,transparent)`
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** ISO 时间戳 → 本地 HH:MM:SS。 */
function clockOf(ts: string): string {
  const millis = Date.parse(ts)
  if (!Number.isFinite(millis)) return '--:--:--'
  const date = new Date(millis)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

/** 相对时间（刷新时才重算，够用）。 */
function relativeOf(ts: string): string {
  const millis = Date.parse(ts)
  if (!Number.isFinite(millis)) return ''
  const delta = Date.now() - millis
  if (!Number.isFinite(delta) || delta < 0) return ''
  if (delta < 5_000) return '刚刚'
  if (delta < 60_000) return `${String(Math.floor(delta / 1_000))} 秒前`
  if (delta < 3_600_000) return `${String(Math.floor(delta / 60_000))} 分钟前`
  if (delta < 86_400_000) return `${String(Math.floor(delta / 3_600_000))} 小时前`
  return `${String(Math.floor(delta / 86_400_000))} 天前`
}

function fmtNum(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '0'
}

function shortId(value: string | undefined): string {
  if (typeof value !== 'string' || value.length === 0) return '—'
  return value.length > 14 ? `${value.slice(0, 10)}…` : value
}


/** 美元格式化（与宿主 renderImpact 的 usd() 同口径：<$0.01 用 6 位小数）。 */
function fmtUsd(value: number): string {
  return `$${value < 0.01 ? value.toFixed(6) : value.toFixed(4)}`
}

/** 净收益卡的成本指标（有记录值用记录值，全缺时给估算，都没有返回空串）。 */
function fmtUsdCard(cost: Impact['cost']): string {
  if (cost.costUsd > 0) return fmtUsd(cost.costUsd)
  if (cost.estimatedCostUsd !== undefined) return `≈${fmtUsd(cost.estimatedCostUsd)}`
  return ''
}

/** 误批徽章：零分母（预批未触发）如实标"无样本"，不把 0/0 包装成 0。 */
function misApprovalBadge(impact: Impact): React.JSX.Element {
  const enforceWoap = impact.agreement.enforce['would-over-approve'] ?? 0
  const hasSamples = enforceWoap > 0 || impact.enforce.autoApproved > 0
    || Object.values(impact.agreement.enforce).some(n => n > 0)
  if (!hasSamples) return <Badge tone="muted">误批 — 无样本</Badge>
  return enforceWoap === 0
    ? <Badge tone="ok">误批 0</Badge>
    : <Badge tone="err">{`误批 ${fmtNum(enforceWoap)} ⚠️`}</Badge>
}

/** 净收益卡的一句话（与宿主 renderImpact 的分支同构）。 */
function oneLineSummary(impact: Impact): string {
  const costText = fmtUsdCard(impact.cost)
  const suffix = impact.cost.cachedDecisions > 0 ? `（${fmtNum(impact.cost.cachedDecisions)} 次缓存命中免费）` : ''
  if (impact.enforce.autoApproved > 0 || impact.enforce.denied > 0) {
    return `${fmtNum(impact.enforce.autoApproved + impact.enforce.denied)} 次该人工把关的判断被自动完成，`
      + `误批 ${fmtNum(impact.agreement.enforce['would-over-approve'] ?? 0)} 次`
      + (costText.length > 0 ? `，成本 ${costText}` : '')
      + suffix
  }
  if (impact.enforce.asked + impact.enforce.stagnationAlerts > 0) {
    return `enforce 期已转人工 ${fmtNum(impact.enforce.asked)} 次、停滞提醒 ${fmtNum(impact.enforce.stagnationAlerts)} 次，还没有自动批准或拦截${suffix}`
  }
  if (impact.modeSplit.shadow > 0) return `enforce 期还没有生效动作；shadow 期数据在积累校准依据${suffix}`
  return `enforce 期还没有生效动作${suffix}`
}

function tagMeta(tag: string): { label: string; hint: string; tone: Tone } {
  return TAG_META[tag] ?? { label: tag, hint: '', tone: 'muted' }
}

/** 阈值参数名的归属色调（guard* → 守门人蓝，preapprove* → 预批准绿）。 */
function paramTone(param: string): Tone {
  if (param.startsWith('guard')) return 'brand'
  if (param.startsWith('preapprove')) return 'ok'
  return 'muted'
}

/** 一条决策的稳定行键（ts 可能重复，附加序号）。 */
function entryKey(entry: LogEntry, index: number): string {
  return `${entry.ts}|${entry.callId ?? entry.tool ?? ''}|${entry.action}|${String(index)}`
}

/** 取 JSON；非 2xx 抛出带 status 的错误，供上层区分 401/404。 */
async function getJson(path: string): Promise<unknown> {
  const response = await fetch(API + path, { headers: { 'cache-control': 'no-store' } })
  if (!response.ok) {
    const error = new Error(`HTTP ${String(response.status)}`) as Error & { status?: number }
    error.status = response.status
    throw error
  }
  return await response.json() as unknown
}

/** 写配置；失败时把服务端 error 文案抛出来。 */
async function putConfig(patch: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${API}/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (response.ok) return
  let detail = `HTTP ${String(response.status)}`
  try {
    const body = await response.json() as { error?: unknown }
    if (typeof body.error === 'string') detail = body.error
  } catch {
    // 响应不是 JSON：保留状态码文案。
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

/** 单个决策环节的分布卡：环节专属色条 + 堆叠条 + 图例。 */
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
          <div className="jev-card-title">每日决策量</div>
          <div className="jev-card-sub">近 {String(days.length)} 个活跃日</div>
        </div>
        {/* 标准色点图例：两段成分，不用文字解释图本身 */}
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>
            <i style={{ width: 9, height: 9, borderRadius: 2, background: TONE.brand, display: 'inline-block' }} />常规决策
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>
            <i style={{ width: 9, height: 9, borderRadius: 2, background: TONE.warn, display: 'inline-block' }} />拦截 / 转人工
          </span>
          <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))' }}>{`峰值 ${String(max)}/天`}</span>
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
              title={`${day.slice(5)} · 共 ${String(total)} 次${flagged > 0 ? `（拦截/转人工 ${String(flagged)}）` : ''}`}
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
          <div className="jev-card-title">工具 Top 8</div>
          <div className="jev-card-sub">决策量与动作构成（统计窗口内）</div>
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
          <div>{fmtNum(total)} 次</div>
          {summary.latencyP50 !== undefined ? <div>{`p50 ${String(summary.latencyP50)} / p95 ${String(summary.latencyP95 ?? summary.latencyP50)}ms`}</div> : null}
          {summary.costUsd !== undefined && summary.costUsd > 0 ? <div>{fmtUsd(summary.costUsd)}</div> : null}
          {summary.cached > 0 ? <div style={{ color: TONE.business }}>{`⚡缓存 ${String(summary.cached)}`}</div> : null}
          {summary.degraded > 0 ? <div style={{ color: TONE.warn }}>{`降级 ${String(summary.degraded)}`}</div> : null}
        </div>
      </header>
      <div className="jev-stack">
        {entries.length === 0
          ? <i title="窗口内没有决策" style={{ width: '100%', background: TONE.muted, opacity: .22 }} />
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
        ? <p className="jev-note">窗口内还没有记录。</p>
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
            const bucket = BUCKET_LABEL[entry[0]] ?? { label: entry[0], tone: 'muted' as Tone }
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

/** 一条决策明细（点击展开全字段；展开时把详情滚进视野，不被视口裁掉）。 */
function LogRow({ entry, open, onToggle }: {
  entry: LogEntry
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const detailRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    // 表格末尾的行展开后，详情会延伸到视口之外——自动滚到最近可见位置。
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
      <span className="jev-cell jev-num jev-col-mode">{MODE_LABEL[entry.mode] ?? entry.mode}</span>
      <span className="jev-cell jev-mono jev-detail jev-col-detail" title={detail}>{detail.length === 0 ? '—' : detail}</span>
      {open && (
        <div ref={detailRef} className="jev-detail-full">
          <div className="jev-kv"><span>模式</span><b>{`${MODE_LABEL[entry.mode] ?? entry.mode}（${entry.mode === 'shadow' ? '未生效' : '已生效'}）`}</b></div>
          <div className="jev-kv"><span>模型</span><b>{entry.model ?? '—'}</b></div>
          <div className="jev-kv"><span>工具</span><b>{entry.tool ?? '—'}</b></div>
          <div className="jev-kv"><span>调用</span><b className="jev-mono" title={entry.callId ?? ''}>{shortId(entry.callId)}</b></div>
          <div className="jev-kv"><span>会话</span><b className="jev-mono" title={entry.sessionId ?? ''}>{shortId(entry.sessionId)}</b></div>
          <div className="jev-kv"><span>输入 Token</span><b>{entry.inputTokens === undefined ? '—' : fmtNum(entry.inputTokens)}</b></div>
          <div className="jev-kv"><span>成本</span><b>{entry.costUsd === undefined ? '—' : `$${entry.costUsd.toFixed(6)}`}</b></div>
          <div className="jev-kv" style={{ gridColumn: '1/-1' }}><span>详情</span><b className="jev-mono" style={{ whiteSpace: 'normal' }}>{detail.length === 0 ? '—' : detail}</b></div>
        </div>
      )}
    </div>
  )
}

/** 概览里的紧凑明细行（最近几条）。 */
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
  // 保存成功后的脱敏展示：不清空输入栏，以掩码回填并锁定，「更换」解锁。
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
  // 决策记录分页：一次拉满 API 上限 500 条本地分页，翻页零延迟。
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
        getJson('/readiness'),
      ])
      if (statusResult.status === 'fulfilled') {
        setStatus(statusResult.value as JevStatus)
        setLoadErr('')
      } else {
        const code = (statusResult.reason as { status?: number } | undefined)?.status
        setLoadErr(code === 401
          ? '需要登录后才能读取面板数据。'
          : code === 404
            ? '当前组合没有注册面板 API（需要 web 组合）。'
            : '无法连接本地 API，请确认 dsh 宿主仍在运行。')
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

  // 自动刷新：页面不可见时跳过，避免后台空转。
  useEffect(() => {
    if (!autoRefresh) return undefined
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void load(true)
    }, REFRESH_MS)
    return () => { clearInterval(timer) }
  }, [autoRefresh, load])

  // 提示 4 秒后自动消失。
  useEffect(() => {
    if (toast === null) return undefined
    const timer = setTimeout(() => { setToast(null) }, 4_000)
    return () => { clearTimeout(timer) }
  }, [toast])

  /** 乐观更新 + 失败回滚的统一写入口。 */
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
      // 诚实反馈：设置服务不落盘时（persistPath 探测为 null）明确说"重启丢失"。
      const volatile = previous !== null && previous.persistPath === null
      setToast({
        tone: volatile ? 'warn' : 'ok',
        text: volatile
          ? '已生效（仅本运行）：设置服务不落盘，重启丢失——请写入 cordis.patch.yml 的 jev-interceptor 行'
          : '已保存',
      })
      void load(true)
      return true
    } catch (error) {
      if (previous !== null) setStatus(previous)
      setToast({ tone: 'err', text: `保存失败：${error instanceof Error ? error.message : String(error)}` })
      return false
    } finally {
      setBusy('')
    }
  }, [status, load])

  const saveKey = useCallback(async (): Promise<void> => {
    const value = keyDraft.trim()
    if (value.length < 10) {
      setToast({ tone: 'err', text: 'API Key 至少 10 个字符。' })
      return
    }
    const ok = await applyPatch('key', { apiKey: value }, { keyConfigured: true, keySource: 'config' })
    if (ok) {
      // 输入栏不清空：以脱敏掩码回填并锁定，用户明确看到「配的是哪把钥匙」。
      setKeyMask(maskKey(value))
      setKeyDraft('')
      setKeyLocked(true)
      setPingResult(null)
    }
  }, [keyDraft, applyPatch])

  /** 连接测试：有未保存的草稿 key 先测草稿，否则测已配置的。 */
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
      setToast({ tone: 'err', text: '端点不能为空。' })
      return
    }
    const ok = await applyPatch('endpoint', { endpoint: value })
    if (ok) setEndpointDraft('')
  }, [endpointDraft, applyPatch])

  const runCalibration = useCallback(async (): Promise<void> => {
    setCalibBusy(true)
    setToast(null)
    try {
      setCalib(await getJson('/calibration') as Calibration)
    } catch (error) {
      setToast({ tone: 'err', text: `校准失败：${error instanceof Error ? error.message : String(error)}` })
    } finally {
      setCalibBusy(false)
    }
  }, [])

  /** 一键应用单条校准建议：PUT 阈值（热生效），成功后重新生成报告看采纳标记。 */
  const applyAdvice = useCallback(async (param: string, suggested: number): Promise<void> => {
    setToast(null)
    // 入口即置忙：PUT 往返期间禁用所有应用/生成按钮（防双击重复 PUT 与并发报告）。
    setCalibBusy(true)
    try {
      await putConfig({ [param]: suggested })
      setToast({ tone: 'ok', text: `已应用 ${param} → ${suggested.toFixed(2)}（下一个调用即生效）` })
      await runCalibration()
    } catch (error) {
      setToast({ tone: 'err', text: `应用失败：${error instanceof Error ? error.message : String(error)}` })
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
        text: add ? `已把 ${tool} 加入预批准名单（下一个审批请求即生效）` : `已把 ${tool} 移出预批准名单`,
      })
    } catch (error) {
      setToast({ tone: 'err', text: `名单更新失败：${error instanceof Error ? error.message : String(error)}` })
    } finally {
      setBusy('')
    }
  }, [status])

  /** 跨环节汇总：总数 / 自动批准 / 转人工 / 拒绝 / 降级。 */
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

  /** 每页条数：20 条保证一屏内完整可见（表格 + 分页栏不依赖滚动）。 */
  const LOG_PAGE_SIZE = 20
  const totalPages = Math.max(1, Math.ceil(filteredLog.length / LOG_PAGE_SIZE))
  const safePage = Math.min(Math.max(1, logPage), totalPages)
  const rows = useMemo(
    () => filteredLog.slice((safePage - 1) * LOG_PAGE_SIZE, safePage * LOG_PAGE_SIZE),
    [filteredLog, safePage],
  )

  /** 筛选变化回第 1 页（避免停在一个不存在的高页码上看空表）。 */
  useEffect(() => { setLogPage(1) }, [filterAction, filterMode, query])

  /** 翻页：切页并把 tab 内容区滚回顶部（新页内容从表格第一行开始看）。 */
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
            <div className="jev-card-title">快速开始</div>
            <div className="jev-card-sub">三步跑通：配 Key → 开观察 → 数字健康后切执行</div>
          </div>
        </header>
        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {step(keyReady, '1', '配置 API Key（设置 tab，可先测试连接）',
            <button className="jev-btn" onClick={() => { setTab('settings') }}>去配置</button>)}
          {step(status.enabled, '2', '启用插件（观察模式只记录，不影响任何行为）',
            <button className="jev-btn jev-btn--primary" disabled={busy !== ''} onClick={() => { void applyPatch('enabled', { enabled: true }, { enabled: true }) }}>启用</button>)}
          {step(enforced, '3', readiness !== null && readiness.ready
            ? '影子数据健康，建议切到执行模式'
            : readiness !== null ? readiness.reason : '观察一段时间后评估是否切执行',
            status.mode === 'shadow' && readiness?.ready === true
              ? <button className="jev-btn jev-btn--primary" disabled={busy !== ''} onClick={() => { void applyPatch('mode', { mode: 'enforce' }, { mode: 'enforce' }) }}>切执行</button>
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
            <b>还没有决策记录</b>
            <div>
            {status !== null && status.enabled
              ? '已启用：下一次工具调用或 @ 引用就会留下第一条判断。'
              : '启用后，每次工具调用都会先过一遍 Jev，并在「决策记录」里留痕。'}
          </div>
          <div className="jev-row-actions">
            {status !== null && !status.enabled
              ? (
                <button
                  className="jev-btn jev-btn--primary"
                  disabled={busy !== ''}
                  onClick={() => { void applyPatch('enabled', { enabled: true }, { enabled: true }) }}
                >启用 Jev</button>
              )
              : null}
            {keySource === 'none' && (
              <button className="jev-btn" onClick={() => { setTab('settings') }}>先配置 API Key</button>
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
                <div className="jev-card-title">净收益</div>
                <div className="jev-card-sub">
                  {`最近 ${fmtNum(impact.windowSize)} 条 · enforce 期口径 · ${impact.firstTs !== undefined ? impact.firstTs.slice(0, 10) : '—'} 起`
                    + `${impact.lastTs !== undefined ? ` ~ ${impact.lastTs.slice(0, 10)}` : ''}`
                    + ` · ${String(impact.days)} 个活跃日 ${String(impact.sessions)} 个会话`}
                </div>
              </div>
              <div className="jev-card-metrics">
                {impact.latency.p50 !== undefined ? <div>{`p50 ${String(impact.latency.p50)}ms`}</div> : null}
                {fmtUsdCard(impact.cost)}
              </div>
            </header>
            <div className="jev-chips">
              <Badge tone="ok">{`省点击 ${fmtNum(impact.enforce.autoApproved)} 次`}</Badge>
              <Badge tone="err">{`拦截 ${fmtNum(impact.enforce.denied)} 次`}</Badge>
              {impact.enforce.stagnationAlerts > 0
                ? <Badge tone="warn">{`停滞提醒 ${fmtNum(impact.enforce.stagnationAlerts)} 次`}</Badge>
                : null}
              {misApprovalBadge(impact)}
              {(impact.agreement.enforce['friction-human-approved'] ?? 0) > 0
                ? <Badge tone="warn">{`多余人工 ${fmtNum(impact.agreement.enforce['friction-human-approved'] ?? 0)}`}</Badge>
                : null}
              {(impact.agreement.shadow['would-over-approve'] ?? 0) > 0
                ? <Badge tone="muted">{`shadow 对照·会批人拒 ${fmtNum(impact.agreement.shadow['would-over-approve'] ?? 0)}`}</Badge>
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
          {`统计窗口：最近 ${fmtNum(log.length)} 条决策${log.length > 0 && log.at(-1) !== undefined ? `（${log.at(-1)!.ts.slice(0, 10)} ~ ${log[0]!.ts.slice(0, 10)}）` : ''}；面板上限 500 条，更早用 /jev-log 查看。`}
        </p>
        <section className="jev-card">
          <header className="jev-card-head">
            <div>
              <div className="jev-card-title">最近决策</div>
              <div className="jev-card-sub">
                {recent.length === 0 ? '暂无记录' : `最新 ${String(recent.length)} 条，按时间倒序`}
              </div>
            </div>
            <button
              className="jev-btn"
              style={{ marginLeft: 'auto' }}
              disabled={log.length === 0}
              onClick={() => { setTab('log') }}
            >{`查看全部${log.length > 0 ? `（${String(log.length)}）` : ''}`}</button>
          </header>
          {recent.length === 0
            ? <p className="jev-note">启用后这里会出现最近几条判断。</p>
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
            >全部<b>{fmtNum(log.length)}</b></button>
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
            placeholder="搜索工具名或详情…"
            value={query}
            onChange={event => { setQuery(event.target.value) }}
          />
          <Segmented
            label="按生效模式筛选"
            value={filterMode}
            options={[
              { value: 'all', label: '全部' },
              { value: 'shadow', label: '观察' },
              { value: 'enforce', label: '执行' },
            ]}
            onChange={setFilterMode}
          />
          {activeFilters
            ? <button className="jev-btn" onClick={resetFilters}>清除筛选</button>
            : null}
        </div>
        {log.length === 0
          ? (
            <div className="jev-empty">
              <b>还没有决策记录</b>
              <div>启用 Jev 之后，每次工具调用与 @ 引用都会在这里留一条。</div>
            </div>
          )
          : rows.length === 0
            ? (
              <div className="jev-empty">
                <b>没有匹配的决策</b>
                <div>换个筛选条件或清空搜索词。</div>
                <div className="jev-row-actions">
                  <button className="jev-btn" onClick={resetFilters}>清除筛选</button>
                </div>
              </div>
            )
            : (
              <div className="jev-table">
                <div className="jev-thead">
                  <span>时间</span>
                  <span className="jev-col-tag">环节</span>
                  <span className="jev-col-tool">工具</span>
                  <span>动作</span>
                  <span className="jev-col-lat">延迟</span>
                  <span className="jev-col-mode">模式</span>
                  <span>详情</span>
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
        {/* 分页导航吸在视口底部：翻页无需滚动找按钮（不用负边距铺满，避免横向溢出）。 */}
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
          <button className="jev-btn" disabled={safePage <= 1} onClick={() => { gotoPage(1) }}>首页</button>
          <button className="jev-btn" disabled={safePage <= 1} onClick={() => { gotoPage(safePage - 1) }}>← 上一页</button>
          <span className="jev-note" style={{ whiteSpace: 'nowrap' }}>
            {`第 ${String(safePage)} / ${String(totalPages)} 页 · 本页 ${fmtNum(rows.length)} 条（共 ${fmtNum(filteredLog.length)} 条）`}
          </span>
          <button className="jev-btn" disabled={safePage >= totalPages} onClick={() => { gotoPage(safePage + 1) }}>下一页 →</button>
          <button className="jev-btn" disabled={safePage >= totalPages} onClick={() => { gotoPage(totalPages) }}>末页</button>
          <span className="jev-note" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            跳至
            <input
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
            页
          </span>
        </div>
        <p className="jev-note">
          {`已载入最近 ${fmtNum(log.length)} 条（面板上限 500）；点一行展开完整字段，更早记录用 /jev-log 500 --json。`}
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
              <div className="jev-card-title">阈值校准建议</div>
              <div className="jev-card-sub">读影子遥测的决策分布与一致率，给阈值调整方向；不自动应用</div>
            </div>
            <button
              className="jev-btn jev-btn--primary"
              style={{ marginLeft: 'auto' }}
              disabled={calibBusy}
              onClick={() => { void runCalibration() }}
            >{calibBusy ? '分析中…' : '生成建议'}</button>
          </header>
          {calib === null
            ? (
              <div className="jev-empty">
                <b>还没有生成报告</b>
                <div>先生成一次，看看当前阈值是否值得调整。</div>
              </div>
            )
            : (
              <Fragment>
                <div className="jev-chips">
                  <Badge tone="brand">{`窗口 ${fmtNum(calib.windowSize)} 条`}</Badge>
                  <Badge tone="muted">{`守门人 ${fmtNum(calib.counts.guard)}`}</Badge>
                  <Badge tone="muted">{`预批准 ${fmtNum(calib.counts.preapprove)}`}</Badge>
                  <Badge tone="muted">{`一致率 ${fmtNum(calib.counts.approvalLoop)}`}</Badge>
                  <Badge tone="muted">{`观察 ${fmtNum(calib.modeSplit.shadow)} · 执行 ${fmtNum(calib.modeSplit.enforce)}`}</Badge>
                  {calib.history === undefined ? null : (
                    <Badge tone={calib.history.adopted > 0 ? 'ok' : 'muted'}>
                      {`上次 ${calib.history.previousTs.slice(5, 10)}：采纳 ${String(calib.history.adopted)} / 未采纳 ${String(calib.history.ignored)}`
                        + (calib.history.manual !== undefined && calib.history.manual > 0 ? ` / 手调 ${String(calib.history.manual)}` : '')}
                    </Badge>
                  )}
                </div>
                {calib.allowlistSuggestions !== undefined && calib.allowlistSuggestions.length > 0 && (
                  <div>
                    <div className="jev-card-title" style={{ fontSize: 12, marginBottom: 3 }}>
                      预批准候选（影子数据：全部低风险、高置信、低不可逆、无注入嫌疑）
                    </div>
                    {calib.allowlistSuggestions.map(s => (
                      <div key={s.tool} className="jev-advice">
                        <div className="jev-advice-head">
                          <span className="jev-param" style={{ color: TONE.ok }}>{s.tool}</span>
                          <Badge tone="muted">{`样本 ${String(s.samples)}`}</Badge>
                          <Badge tone="muted">{`平均置信 ${s.avgConfidence.toFixed(2)}`}</Badge>
                          <Badge tone="muted">{`平均不可逆 ${s.avgIrreversibility.toFixed(2)}`}</Badge>
                          <button
                            className="jev-btn jev-btn--primary"
                            style={{ marginLeft: 'auto' }}
                            disabled={busy !== ''}
                            title="加入预批准名单并立即生效；自动批仍受双 noul 证据门约束"
                            onClick={() => { void applyAllowlist(s.tool, true) }}
                          >加入名单</button>
                        </div>
                      </div>
                    ))}
                    <p className="jev-note">候选只统计「全部调用均为低风险」的工具；加入后每次自动批仍单独过证据门，一致率遥测持续监督。</p>
                  </div>
                )}
                {calib.advice.length === 0
                  ? (
                    <div className="jev-empty">
                      <b>当前无需调整阈值</b>
                      <div>遥测分布与现配置一致（或上次建议已全部应用）。有新的调整建议时，每条建议卡右上角会出现「应用」按钮。</div>
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
                        <Badge tone="muted">{`样本 ${fmtNum(advice.samples)}`}</Badge>
                        <button
                          className="jev-btn jev-btn--primary"
                          style={{ marginLeft: 'auto' }}
                          disabled={calibBusy}
                          title="写入该阈值并立即生效（不重启）；持久化取决于设置服务"
                          onClick={() => { void applyAdvice(advice.param, advice.suggested) }}
                        >应用</button>
                      </div>
                      <p className="jev-note">{advice.basis}</p>
                      {(advice.note ?? '').length === 0 ? null : <p className="jev-note">{advice.note}</p>}
                    </div>
                  ))}
                {calib.insufficient.length === 0 ? null : (
                  <div>
                    <div className="jev-card-title" style={{ fontSize: 12, marginBottom: 3 }}>样本不足</div>
                    <p className="jev-note">{calib.insufficient.map(note => note.reason).join('；')}</p>
                  </div>
                )}
                {calib.observations.length === 0 ? null : (
                  <div>
                    <div className="jev-card-title" style={{ fontSize: 12, marginBottom: 3 }}>观察项</div>
                    <p className="jev-note">{calib.observations.map(note => note.reason).join('；')}</p>
                  </div>
                )}
                <p className="jev-note">「应用」写入阈值并立即生效（无需重启）；持久化取决于设置服务是否落盘。</p>
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
              <div className="jev-card-title">连接</div>
              <div className="jev-card-sub">Provider 决定请求发往哪里；切换立即生效</div>
            </div>
          </header>
          <div className="jev-provider">
            {PROVIDERS.map(item => (
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
                  >{busy === 'endpoint' ? '…' : '保存'}</button>
                </div>
                <p className="jev-note">留空则沿用配置里的 endpoint。</p>
              </div>
            )
            : <p className="jev-note">端点由 Provider 预置；选「自定义」可覆盖。</p>}
        </section>

        <section className="jev-card">
          <header className="jev-card-head">
            <div>
              <div className="jev-card-title">API Key</div>
              <div className="jev-card-sub">{`来源：${KEY_SOURCE[keySource] ?? keySource}`}</div>
            </div>
          </header>
          <div className="jev-field">
            <label className="jev-field-label">
              {keyLocked ? '当前使用的 Key（已脱敏）' : keySource === 'none' ? '粘贴你的 Jev API Key' : '覆盖已有 Key'}
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
                    title="清空输入框，粘贴新 Key"
                    onClick={() => { setKeyLocked(false); setKeyMask('') }}
                  >更换</button>
                </Fragment>
              ) : (
                <Fragment>
                  <input
                    className="jev-input"
                    type={showKey ? 'text' : 'password'}
                    placeholder={keySource === 'none' ? '至少 10 个字符' : '输入新值以覆盖'}
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
                  >{showKey ? '隐藏' : '显示'}</button>
                  <button
                    className="jev-btn jev-btn--primary"
                    disabled={busy !== '' || keyDraft.trim().length < 10}
                    onClick={() => { void saveKey() }}
                  >{busy === 'key' ? '…' : '保存'}</button>
                </Fragment>
              )}
              <button
                className="jev-btn"
                disabled={pingBusy || (!keyLocked && keyDraft.trim().length < 10 && keySource === 'none')}
                title="向 Provider 发一次最小真实请求，验证 Key 与端点（约 $0.00001）"
                onClick={() => { void runPing() }}
              >{pingBusy ? '测试中…' : '测试连接'}</button>
            </div>
            {pingResult !== null && (
              <p className="jev-note" style={{ color: pingResult.ok ? TONE.ok : TONE.err }}>
                {pingResult.ok ? '✓ ' : '✗ '}{pingText(pingResult)}
              </p>
            )}
          </div>
          <p className="jev-note">Key 只写入本机配置，保存后以脱敏形式显示；「测试连接」会先测未保存的草稿 Key，再测已配置的。</p>
        </section>

        <section className="jev-card">
          <header className="jev-card-head">
            <div>
              <div className="jev-card-title">生效中的能力</div>
              <div className="jev-card-sub">其余开关在 cordis.yml / 设置面板调整</div>
            </div>
          </header>
          <div className="jev-chips">
            <Badge tone={status?.guardEnabled === true ? 'ok' : 'muted'}>{`守门人 ${status?.guardEnabled === true ? '开' : '关'}`}</Badge>
            <Badge tone={status?.preapproveEnabled === true ? 'ok' : 'muted'}>{`预批准 ${status?.preapproveEnabled === true ? '开' : '关'}`}</Badge>
            <Badge tone={status?.stagnationEnabled === true ? 'ok' : 'muted'}>{`停滞检测 ${status?.stagnationEnabled === true ? '开' : '关'}`}</Badge>
            <Badge tone={status?.enabled === true ? 'ok' : 'muted'}>{`总开关 ${status?.enabled === true ? '开' : '关'}`}</Badge>
          </div>
          <div className="jev-field">
            <label className="jev-field-label">模式</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Segmented
                label="决策模式"
                value={mode}
                disabled={busy !== ''}
                options={[
                  { value: 'shadow', label: '观察', title: MODE_HINT.shadow },
                  { value: 'enforce', label: '执行', title: MODE_HINT.enforce },
                ]}
                onChange={next => { void applyPatch('mode', { mode: next }, { mode: next as JevStatus['mode'] }) }}
              />
              <span className="jev-note">{MODE_HINT[mode]}</span>
            </div>
          </div>
          <p className="jev-note">切到执行前，建议先观察一段时间，确认拒绝与转人工的判断符合预期。</p>
        </section>

        <section className="jev-card">
          <header className="jev-card-head">
            <div>
              <div className="jev-card-title">预批准名单</div>
              <div className="jev-card-sub">
                {`名单内的工具，审批请求会经 Jev 双重判断（授权范围 + 可逆）后自动放行；当前 ${String((status?.preapproveAllowlist ?? []).length)} 个`}
              </div>
            </div>
          </header>
          {(status?.preapproveAllowlist ?? []).length === 0 ? (
            <p className="jev-note">名单为空——预批准不会自动批任何工具（这就是「省点击」还没发生的原因）。去「阈值校准」tab 生成建议，影子数据会推荐可信工具。</p>
          ) : (
            <div className="jev-chips">
              {(status?.preapproveAllowlist ?? []).map(tool => (
                <button
                  key={tool}
                  className="jev-chip"
                  data-on="1"
                  disabled={busy !== ''}
                  title="点击移出预批准名单（立即生效）"
                  onClick={() => { void applyAllowlist(tool, false) }}
                >{tool} ✕</button>
              ))}
            </div>
          )}
          <p className="jev-note">自动批仍受证据门约束：Jev 会核对参数证据与授权范围，任何怀疑都转人工。</p>
        </section>

        <section className="jev-card">
          <header className="jev-card-head">
            <div>
              <div className="jev-card-title">刷新</div>
              <div className="jev-card-sub">
                {updatedAt > 0 ? `上次更新 ${clockOf(new Date(updatedAt).toISOString())}` : '尚未刷新'}
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
              {`每 ${String(REFRESH_MS / 1000)} 秒自动刷新`}
            </label>
            <button
              className="jev-btn"
              disabled={loading}
              onClick={() => { void load(false) }}
            >{loading ? '刷新中…' : '立即刷新'}</button>
          </div>
          <p className="jev-note">页面不可见时自动暂停，不产生后台请求。</p>
        </section>
      </div>
    )
  }

  return (
    <div className="jev-root">
      <header className="jev-head">
        <div className="jev-logo">⚡</div>
        <div className="jev-headtext">
          <div className="jev-title-row">
            <h2 className="jev-title">Jev 决策</h2>
            {status === null ? null : (
              <span className="jev-status" data-on={status.enabled ? '1' : '0'}>
                <i className="jev-dot" />
                {status.enabled
                  ? status.mode === 'shadow' ? '运行中 · 观察模式' : '运行中 · 执行模式'
                  : '已停用'}
              </span>
            )}
          </div>
          <div className="jev-sub">
            {updatedAt > 0
              ? `系统一风险判断 · 更新于 ${clockOf(new Date(updatedAt).toISOString())}`
              : '毫秒级系统一风险判断'}
          </div>
        </div>
        <div className="jev-head-actions">
          <button
            className="jev-btn"
            disabled={loading}
            title="重新拉取状态与最近决策"
            onClick={() => { void load(false) }}
          >{loading ? '刷新中…' : '刷新'}</button>
          {status === null ? null : (
            <button
              className={status.enabled ? 'jev-btn' : 'jev-btn jev-btn--primary'}
              disabled={busy !== ''}
              title={status.enabled ? '停用后恢复 dsh 原生行为' : '启用 Jev 决策'}
              onClick={() => {
                void applyPatch('enabled', { enabled: !status.enabled }, { enabled: !status.enabled })
              }}
            >{busy === 'enabled' ? '…' : status.enabled ? '停用' : '启用'}</button>
          )}
        </div>
      </header>

      {loadErr === '' || status === null ? null : <div className="jev-toast" data-tone="err">{loadErr}</div>}
      {toast === null ? null : <div className="jev-toast" data-tone={toast.tone}>{toast.text}</div>}

      {status === null ? null : (
        <section className="jev-hero">
          <div className="jev-kpis">
            <Kpi label="决策总数" value={aggregate.calls} hint="统计窗口内的全部判断" />
            <Kpi label="自动批准" value={aggregate.auto} tone="ok" hint="省掉的人工确认次数" />
            <Kpi label="转人工" value={aggregate.ask} tone="warn" hint="风险不确定，交回人工" />
            <Kpi label="拒绝" value={aggregate.deny} tone="err" hint="高置信风险，直接否决" />
            <Kpi label="降级" value={aggregate.degraded} tone={aggregate.degraded > 0 ? 'warn' : undefined} hint="决策失败，回落原生行为" />
          </div>
          <div className="jev-hero-side">
            <div className="jev-fact">
              <span>模式</span>
              <Segmented
                label="决策模式"
                value={mode}
                disabled={busy !== ''}
                options={[
                  { value: 'shadow', label: '观察', title: MODE_HINT.shadow },
                  { value: 'enforce', label: '执行', title: MODE_HINT.enforce },
                ]}
                onChange={next => { void applyPatch('mode', { mode: next }, { mode: next as JevStatus['mode'] }) }}
              />
            </div>
            <Fact label="Provider">{provider}</Fact>
            <Fact label="模型">{status.model}</Fact>
            <Fact label="API Key">{KEY_SOURCE[keySource] ?? keySource}</Fact>
            <Fact label="今日成本">
              {status.costTodayUsd === undefined
                ? '—'
                : (status.dailyCostLimitUsd ?? 0) > 0
                  ? `$${status.costTodayUsd.toFixed(6)} / 限 $${(status.dailyCostLimitUsd ?? 0).toFixed(2)}${status.costTodayUsd >= (status.dailyCostLimitUsd ?? Infinity) ? '（已超限，降级中）' : ''}`
                  : `$${status.costTodayUsd.toFixed(6)}`}
            </Fact>
          </div>
        </section>
      )}

      {status === null || !status.enabled || status.mode !== 'shadow' ? null : (
        <div className="jev-banner">观察模式：决策只记录，不拦截也不放行；确认判断符合预期后再切到执行。</div>
      )}

      {status === null ? null : (
        <nav className="jev-tabs" role="tablist">
          {TABS.map(item => (
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
          <b>正在连接本地 API…</b>
          <div>首次加载会拉取状态、统计与最近 80 条决策。</div>
        </div>
      ) : null}

      {status === null ? null : (
        // tab 内容区自带滚动（flex:1 + min-height:0）：不依赖 dsh 布局的父级
        // 高度链（centerCol 是 overflow:hidden 裁剪容器，外部滚动不可用）。
        // 主路径（分页 20 条/页）不依赖滚动，这里只是长内容（概览/设置）的兜底。
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
          <b>面板暂时读不到状态</b>
          <div>{loadErr.length === 0 ? '宿主半没有响应。' : loadErr}</div>
          <div className="jev-row-actions">
            <button className="jev-btn" onClick={() => { void load(false) }}>重试</button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
