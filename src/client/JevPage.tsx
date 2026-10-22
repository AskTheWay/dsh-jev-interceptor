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

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

interface JevStatus {
  enabled: boolean
  mode: 'shadow' | 'enforce'
  provider: string
  model: string
  keyConfigured: boolean
  keySource: 'config' | 'credentials' | 'env' | 'none'
  guardEnabled: boolean
  preapproveEnabled: boolean
  stagnationEnabled: boolean
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
  muted: 'var(--dsw-alias-label-secondary,#8a8a8a)',
} as const

type Tone = keyof typeof TONE

const MODE_LABEL: Record<string, string> = { shadow: '观察', enforce: '执行' }

const MODE_HINT: Record<string, string> = {
  shadow: '只记录决策，不拦截也不放行',
  enforce: '按决策放行或转人工',
}

/** 决策环节（tag）的中文名与一句话说明。 */
const TAG_META: Record<string, { label: string; hint: string }> = {
  guard: { label: '守门人', hint: '工具调用的风险 / 不可逆 / 注入判断' },
  preapprove: { label: '预批准', hint: '明确已授权就免点击' },
  'session-reference': { label: '会话保留', hint: '@ 引用快照的价值打分' },
  'approval-loop': { label: '审批一致率', hint: '影子决策与人工决定的对照' },
  stagnation: { label: '停滞检测', hint: '重复失败时提醒换路' },
}

/** 决策动作的中文名与色调。 */
const ACTION_META: Record<string, { label: string; tone: Tone }> = {
  delegate: { label: '放行', tone: 'muted' },
  ask: { label: '转人工', tone: 'warn' },
  deny: { label: '拒绝', tone: 'err' },
  'auto-approve': { label: '自动批准', tone: 'ok' },
  human: { label: '人工决定', tone: 'brand' },
  degraded: { label: '降级放行', tone: 'muted' },
  skipped: { label: '跳过', tone: 'muted' },
  'retention-scored': { label: '打分保留', tone: 'brand' },
  'retention-fifo': { label: 'FIFO 淘汰', tone: 'muted' },
  agreement: { label: '一致率', tone: 'brand' },
  'stagnation-alert': { label: '停滞提醒', tone: 'warn' },
}

/** 一致率分桶（approval-loop 专属）。 */
const BUCKET_LABEL: Record<string, string> = {
  'would-over-approve': '本会误批',
  'aligned-approve': '与人工一致（准）',
  'aligned-reject': '与人工一致（拒）',
  'friction-human-approved': '多一次人工确认',
  neutral: '中性',
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

const TABS = [
  { id: 'overview', label: '概览' },
  { id: 'log', label: '决策记录' },
  { id: 'calibration', label: '阈值校准' },
  { id: 'settings', label: '设置' },
] as const

/** 面板样式表（官方主题 token 驱动；深浅主题与第三方主题自动跟随）。 */
export const PANEL_CSS = `
.jev-root{height:100%;overflow-y:auto;box-sizing:border-box;padding:20px 24px 48px;display:flex;flex-direction:column;gap:14px;max-width:1120px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary);}
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

function actionMeta(action: string): { label: string; tone: Tone } {
  return ACTION_META[action] ?? { label: action, tone: 'brand' }
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

function tagMeta(tag: string): { label: string; hint: string } {
  return TAG_META[tag] ?? { label: tag, hint: '' }
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

/** 单个决策环节的分布卡：堆叠条 + 图例。 */
function TagCard({ summary }: { summary: TagSummary }): React.JSX.Element {
  const meta = tagMeta(summary.tag)
  const actions = summary.actions ?? {}
  const entries = Object.entries(actions).filter(entry => entry[1] > 0).sort((left, right) => right[1] - left[1])
  const total = summary.calls > 0 ? summary.calls : entries.reduce((sum, entry) => sum + entry[1], 0)
  const buckets = summary.agreementBuckets === undefined
    ? []
    : Object.entries(summary.agreementBuckets).filter(entry => entry[1] > 0)
  return (
    <article className="jev-card">
      <header className="jev-card-head">
        <div style={{ minWidth: 0 }}>
          <div className="jev-card-title">{meta.label}</div>
          <div className="jev-card-sub">{meta.hint}</div>
        </div>
        <div className="jev-card-metrics">
          <div>{fmtNum(total)} 次</div>
          {summary.latencyP50 === undefined ? null : <div>{`p50 ${String(summary.latencyP50)}ms`}</div>}
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
              style={{ width: `${String(total > 0 ? entry[1] / total * 100 : 0)}%`, background: TONE[actionMeta(entry[0]).tone] }}
            />
          ))}
      </div>
      {entries.length === 0
        ? <p className="jev-note">窗口内还没有记录。</p>
        : (
          <ul className="jev-legend">
            {entries.map(entry => (
              <li key={entry[0]}>
                <span className="jev-swatch" style={{ background: TONE[actionMeta(entry[0]).tone] }} />
                <span className="jev-legend-label">{actionMeta(entry[0]).label}</span>
                <b>{fmtNum(entry[1])}</b>
                <span className="jev-legend-pct">{`${String(total > 0 ? Math.round(entry[1] / total * 100) : 0)}%`}</span>
              </li>
            ))}
          </ul>
        )}
      {buckets.length === 0 ? null : (
        <p className="jev-note">
          一致率分桶：
          {buckets.map(entry => `${BUCKET_LABEL[entry[0]] ?? entry[0]} ${String(entry[1])}`).join(' · ')}
        </p>
      )}
    </article>
  )
}

/** 一条决策明细（点击展开全字段）。 */
function LogRow({ entry, open, onToggle }: {
  entry: LogEntry
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
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
      <span className="jev-cell jev-col-tag jev-strong">{tagMeta(entry.tag).label}</span>
      <span className="jev-cell jev-mono jev-col-tool" title={entry.tool ?? ''}>{entry.tool ?? '—'}</span>
      <span className="jev-cell"><Badge tone={meta.tone}>{meta.label}</Badge></span>
      <span className="jev-cell jev-num jev-col-lat">{latency}</span>
      <span className="jev-cell jev-num jev-col-mode">{MODE_LABEL[entry.mode] ?? entry.mode}</span>
      <span className="jev-cell jev-mono jev-detail jev-col-detail" title={detail}>{detail.length === 0 ? '—' : detail}</span>
      {open && (
        <div className="jev-detail-full">
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
  const [tab, setTab] = useState<string>('overview')
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState('')
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [updatedAt, setUpdatedAt] = useState(0)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [calibBusy, setCalibBusy] = useState(false)
  const [keyDraft, setKeyDraft] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [endpointDraft, setEndpointDraft] = useState('')
  const [filterAction, setFilterAction] = useState('all')
  const [filterMode, setFilterMode] = useState('all')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = useCallback(async (silent: boolean): Promise<void> => {
    if (!silent) setLoading(true)
    try {
      const [statusResult, statsResult, logResult, impactResult] = await Promise.allSettled([
        getJson('/status'),
        getJson('/stats'),
        getJson('/log?limit=80'),
        getJson('/impact'),
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
      setUpdatedAt(Date.now())
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => { void load(false) }, [load])

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
      setToast({ tone: 'ok', text: '已保存' })
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
    if (ok) setKeyDraft('')
  }, [keyDraft, applyPatch])

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

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return log.filter(entry => (filterAction === 'all' || entry.action === filterAction)
      && (filterMode === 'all' || entry.mode === filterMode)
      && (needle.length === 0
        || (entry.tool ?? '').toLowerCase().includes(needle)
        || (entry.detail ?? '').toLowerCase().includes(needle)))
      .slice(0, 120)
  }, [log, filterAction, filterMode, query])

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

  const renderOverview = (): React.JSX.Element => {
    if (stats.length === 0) {
      return (
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
      )
    }
    return (
      <Fragment>
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
        <div className="jev-grid">
          {stats.map(summary => <TagCard key={summary.tag} summary={summary} />)}
        </div>
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
        <p className="jev-note">
          {`已载入最近 ${fmtNum(log.length)} 条，显示 ${fmtNum(rows.length)} 条；点一行展开完整字段。`}
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
                {calib.advice.length === 0
                  ? <p className="jev-note">没有需要调整的阈值，当前参数与遥测分布一致。</p>
                  : calib.advice.map(advice => (
                    <div key={advice.param} className="jev-advice">
                      <div className="jev-advice-head">
                        <span className="jev-param">{advice.param}</span>
                        <span className="jev-delta">
                          {advice.current.toFixed(2)}<i> → </i>{advice.suggested.toFixed(2)}
                          {` ${advice.suggested > advice.current ? '↑' : '↓'}`}
                        </span>
                        <Badge tone="muted">{`样本 ${fmtNum(advice.samples)}`}</Badge>
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
                <p className="jev-note">报告不写回配置：确认后再改 cordis.yml，或等下一版面板提供一键应用。</p>
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
            <label className="jev-field-label">{keySource === 'none' ? '粘贴你的 Jev API Key' : '覆盖已有 Key'}</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
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
            </div>
          </div>
          <p className="jev-note">Key 只写入本机配置；面板不回显已保存的值。</p>
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

      {status === null
        ? null
        : tab === 'overview'
          ? renderOverview()
          : tab === 'log'
            ? renderLog()
            : tab === 'calibration'
              ? renderCalibration()
              : renderSettings()}

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
