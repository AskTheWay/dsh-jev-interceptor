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
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { PANEL_CSS } from './panel-css.js'
import { Icon } from './Icons.js'
import type { IconName } from './Icons.js'
import { decisionDays, decisionScores, filterDecisions } from './view-model.js'

interface JevStatus {
  enabled: boolean
  mode: 'shadow' | 'enforce'
  provider: string
  model: string
  activeModel?: string | null
  endpointOrigin?: string | null
  connectionError?: string
  keyReference?: string
  keyError?: string
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
  scope?: { model: string | null; currentModel: string | null; scanned: number; models: Array<{ model: string; samples: number }> }
  counts: { guard: number; preapprove: number; approvalLoop: number }
  modeSplit: { shadow: number; enforce: number }
  advice: Array<{
    param: string
    current: number
    suggested: number
    basis: string
    samples: number
    note: string
  }>
  insufficient: Array<{ param: string; reason: string }>
  observations: Array<{ param: string; reason: string }>
  /** 与上一份快照的对比摘要（无历史时缺失）。 */
  history?: { previousTs: string; adopted: number; ignored: number; manual?: number }
  /** 预批准候选工具（影子数据推导；一键加入名单）。 */
  allowlistSuggestions?: Array<{
    tool: string
    samples: number
    avgConfidence: number
    avgIrreversibility: number
    maxInjection: number
  }>
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
  scores?: Readonly<Record<string, number>>
}

type JevPageProps = PropsRuntime<'main'>

const API = '/api/jev-interceptor'
/** 自动刷新间隔：状态灯与最近决策不需要秒级新鲜度。 */
const REFRESH_MS = 20_000
const CSS_TAG_ID = 'dsh-jev-interceptor/panel.css'

/** 主题色调（变量表达式可直接进 color-mix）。 */
const TONE = {
  ok: 'var(--j-ok)',
  warn: 'var(--j-warn)',
  err: 'var(--j-err)',
  brand: 'var(--j-brand)',
  business: 'var(--j-business)',
  muted: 'var(--j-muted)',
} as const

type Tone = keyof typeof TONE

const MODE_LABEL: Record<string, string> = { shadow: '观察', enforce: '执行' }

const MODE_HINT: Record<string, string> = {
  shadow: '只记录决策，不拦截也不放行',
  enforce: '执行风险拦截与审批，其他调用交回原生流程',
}

/** 决策环节（tag）的中文名、一句话说明与专属色调（每个环节一种颜色）。 */
const TAG_META: Record<string, { label: string; hint: string; tone: Tone }> = {
  guard: { label: '守门人', hint: '工具调用的风险 / 不可逆 / 注入判断', tone: 'brand' },
  preapprove: { label: '预批准', hint: '核对授权范围与可逆性', tone: 'ok' },
  'session-reference': { label: '会话保留', hint: '@ 引用快照的价值打分', tone: 'business' },
  'approval-loop': { label: '审批一致率', hint: '影子决策与人工决定的对照', tone: 'muted' },
  stagnation: { label: '停滞检测', hint: '重复失败时提醒换路', tone: 'warn' },
  untrusted: { label: '注入扫描', hint: '工具结果中的注入指令标记与拦截', tone: 'err' },
}

/**
 * 决策动作的中文名与色调。视觉编码约定：
 * - 实色区分动作类型；是否实际执行由模式字段决定；
 * - 斜纹 = 降级回退，继续原生流程；
 * - 实灰 = 默认/跳过类。同一张卡内共现的动作颜色互异。
 */
const ACTION_META: Record<string, { label: string; tone: Tone; fallback?: boolean }> = {
  delegate: { label: '交回原生', tone: 'business' },
  ask: { label: '转人工', tone: 'warn' },
  deny: { label: '拒绝', tone: 'err' },
  'auto-approve': { label: '自动批准', tone: 'ok' },
  human: { label: '人工决定', tone: 'brand' },
  degraded: { label: '降级回退', tone: 'muted', fallback: true },
  skipped: { label: '跳过', tone: 'muted' },
  'retention-scored': { label: '打分保留', tone: 'ok' },
  'retention-fifo': { label: 'FIFO 淘汰', tone: 'muted' },
  agreement: { label: '一致率', tone: 'brand' },
  'stagnation-alert': { label: '停滞提醒', tone: 'warn' },
  marked: { label: '标记注入', tone: 'err' },
}

/** 降级回退的斜纹底（与实色决策形成"生效/未生效"的视觉区分）。 */
const FADED_FILL = 'repeating-linear-gradient(45deg, var(--j-muted) 0 3px, transparent 3px 7px)'

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
  { id: 'typesafe', label: 'TypeSafe', hint: 'TypeSafe 直连' },
  { id: 'openrouter', label: 'OpenRouter', hint: '通过 System One 接口调用' },
  { id: 'custom', label: '自定义', hint: '兼容 Jev 协议的代理或自建端点' },
] as const

type ProviderChoice = (typeof PROVIDERS)[number]['id']

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

/** Connection feedback distinguishes a verified answer from a throttled request. */
const PING_ERROR: Record<string, string> = {
  'no-key': '未配置 API Key',
  'invalid-connection': '请先保存有效的连接配置。',
  'connection-changed': '连接已变更，请重新测试。',
  'credential-unavailable': '凭据服务暂不可用。',
  aborted: '连接测试已取消。',
  network: '网络错误：无法连接端点',
  timeout: '超时：检查网络/代理，或端点响应过慢',
  auth: '认证失败：Key 无效或已过期',
  'not-found': '端点不存在：检查 Provider 或 Base URL',
  'rate-limited': '服务返回限流，请稍后复测',
  server: '服务端错误：Provider 侧问题',
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
  return `${PING_ERROR[result.error ?? ''] ?? `失败（${result.error ?? '未知错误'}）`} · ${String(result.latencyMs)}ms`
}

const TABS = [
  { id: 'overview', label: '概览', icon: 'overview' },
  { id: 'log', label: '决策记录', icon: 'log' },
  { id: 'calibration', label: '阈值校准', icon: 'sliders' },
  { id: 'settings', label: '设置', icon: 'settings' },
] as const

export { PANEL_CSS } from './panel-css.js'

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
  const hasSamples =
    enforceWoap > 0 ||
    impact.enforce.autoApproved > 0 ||
    Object.values(impact.agreement.enforce).some((n) => n > 0)
  if (!hasSamples) return <Badge tone="muted">误批 — 无样本</Badge>
  return enforceWoap === 0 ? (
    <Badge tone="ok">误批 0</Badge>
  ) : (
    <Badge tone="err">{`误批 ${fmtNum(enforceWoap)}`}</Badge>
  )
}

/** 净收益卡的一句话（与宿主 renderImpact 的分支同构）。 */
function oneLineSummary(impact: Impact): string {
  const costText = fmtUsdCard(impact.cost)
  const suffix =
    impact.cost.cachedDecisions > 0 ? `（${fmtNum(impact.cost.cachedDecisions)} 次缓存命中免费）` : ''
  if (impact.enforce.autoApproved > 0 || impact.enforce.denied > 0) {
    return (
      `${fmtNum(impact.enforce.autoApproved + impact.enforce.denied)} 次审批或拦截由 Jev 完成，` +
      `误批 ${fmtNum(impact.agreement.enforce['would-over-approve'] ?? 0)} 次` +
      (costText.length > 0 ? `，成本 ${costText}` : '') +
      suffix
    )
  }
  if (impact.enforce.asked + impact.enforce.stagnationAlerts > 0) {
    return `执行期已转交人工 ${fmtNum(impact.enforce.asked)} 次、停滞提醒 ${fmtNum(impact.enforce.stagnationAlerts)} 次，还没有自动批准或拦截${suffix}`
  }
  if (impact.modeSplit.shadow > 0) return `尚无执行期生效动作，观察记录正在积累校准依据${suffix}`
  return `执行期尚无生效动作${suffix}`
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
  return (await response.json()) as unknown
}

/** 写配置；失败时把服务端 error 文案抛出来。 */
async function putConfig(patch: Record<string, unknown>): Promise<boolean | undefined> {
  const response = await fetch(`${API}/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  let detail = `HTTP ${String(response.status)}`
  try {
    const body = (await response.json()) as { error?: unknown; persisted?: boolean }
    if (response.ok) return body.persisted
    if (typeof body.error === 'string') detail = body.error
  } catch {
    // 响应不是 JSON：保留状态码文案。
  }
  if (response.ok) return undefined
  throw new Error(detail)
}

const MEMORY_ONLY = '仅本次运行生效。可在 profile 配置中保存。'

function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }): React.JSX.Element {
  const color = TONE[tone]
  return (
    <span className="jev-badge" style={{ color, background: tint(color, 12), borderColor: tint(color, 30) }}>
      {children}
    </span>
  )
}

function Kpi({
  label,
  value,
  tone,
  hint,
  icon,
}: {
  label: string
  value: number
  tone?: Tone
  hint: string
  icon: IconName
}): React.JSX.Element {
  return (
    <div className="jev-kpi" data-tone={tone}>
      <span className="jev-kpi-label">
        <Icon name={icon} size={14} />
        {label}
      </span>
      <b>{fmtNum(value)}</b>
      <small>{hint}</small>
    </div>
  )
}

interface SegmentOption {
  value: string
  label: string
  title?: string
}

function Segmented({
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  value: string
  options: readonly SegmentOption[]
  onChange: (next: string) => void
  disabled?: boolean
  label: string
}): React.JSX.Element {
  return (
    <div className="jev-seg" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          data-on={option.value === value ? '1' : '0'}
          title={option.title}
          aria-pressed={option.value === value}
          disabled={disabled}
          onClick={() => {
            if (option.value !== value) onChange(option.value)
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="jev-fact">
      <span>{label}</span>
      <b>{children}</b>
    </div>
  )
}

/** Calendar days are continuous, with the same UTC boundary as the host summary. */
function DailyTrend({ log }: { log: LogEntry[] }): React.JSX.Element | null {
  const days = useMemo(() => decisionDays(log), [log])
  if (days.length === 0) return null
  const max = Math.max(...days.map((day) => day.total), 1)
  return (
    <section className="jev-card">
      <header className="jev-card-head">
        <div>
          <div className="jev-card-title">决策活动</div>
          <div className="jev-card-sub">最近记录所在的 14 天，按 UTC 日期</div>
        </div>
        <span className="jev-card-metrics">峰值 {fmtNum(max)} 次 / 天</span>
      </header>
      <div className="jev-chart">
        <div className="jev-chart-axis" aria-hidden="true">
          <span>{fmtNum(max)}</span>
          <span>{fmtNum(Math.round(max / 2))}</span>
          <span>0</span>
        </div>
        <div className="jev-chart-body">
          <div className="jev-chart-bars" role="group" aria-label="每日决策量，含观察模式">
            {days.map((day) => (
              <div
                key={day.day}
                className="jev-chart-bar"
                tabIndex={0}
                aria-label={`${day.day}，${day.total} 次决策，${day.flagged} 次需关注，${day.degraded} 次降级`}
              >
                <span className="jev-chart-tooltip" aria-hidden="true">
                  {day.day.slice(5)}：{day.total} 次，关注 {day.flagged}，降级 {day.degraded}
                </span>
                {day.flagged > 0 && (
                  <i style={{ height: `${(day.flagged / max) * 100}%`, background: TONE.warn }} />
                )}
                {day.degraded > 0 && (
                  <i style={{ height: `${(day.degraded / max) * 100}%`, background: FADED_FILL }} />
                )}
                {day.total - day.flagged - day.degraded > 0 && (
                  <i
                    style={{
                      height: `${((day.total - day.flagged - day.degraded) / max) * 100}%`,
                      background: TONE.brand,
                    }}
                  />
                )}
              </div>
            ))}
          </div>
          <div className="jev-chart-ticks" aria-hidden="true">
            {days.map((day, index) => (
              <span key={day.day}>
                {[0, 4, 9, 13].includes(index) ? day.day.slice(5).replace('-', '/') : ''}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="jev-chart-legend">
        <span>
          <i className="jev-swatch" style={{ background: TONE.brand }} />
          其他决策
        </span>
        <span>
          <i className="jev-swatch" style={{ background: TONE.warn }} />
          需关注
        </span>
        <span>
          <i className="jev-swatch" style={{ background: FADED_FILL }} />
          降级回退
        </span>
        <span style={{ marginLeft: 'auto' }}>含观察模式记录</span>
      </div>
    </section>
  )
}

function ToolTopCard({
  log,
  onSelect,
}: {
  log: LogEntry[]
  onSelect: (tool: string) => void
}): React.JSX.Element | null {
  const tools = useMemo(() => {
    const byTool = new Map<string, { total: number; byAction: Record<string, number> }>()
    for (const entry of log) {
      if (entry.tool === undefined) continue
      const bucket = byTool.get(entry.tool) ?? { total: 0, byAction: {} }
      bucket.total += 1
      bucket.byAction[entry.action] = (bucket.byAction[entry.action] ?? 0) + 1
      byTool.set(entry.tool, bucket)
    }
    return [...byTool.entries()].sort((left, right) => right[1].total - left[1].total).slice(0, 5)
  }, [log])
  if (tools.length === 0) return null
  const max = tools[0]![1].total
  return (
    <section className="jev-card">
      <header className="jev-card-head">
        <div>
          <div className="jev-card-title">工具分布</div>
          <div className="jev-card-sub">最近 {fmtNum(log.length)} 条中的前 5 个工具，点击查看记录</div>
        </div>
      </header>
      {tools.map(([tool, { total, byAction }]) => (
        <button
          key={tool}
          className="jev-tool-row"
          onClick={() => {
            onSelect(tool)
          }}
          title={`查看 ${tool} 的决策记录`}
        >
          <span className="jev-cell jev-mono">{tool}</span>
          <span className="jev-tool-bar">
            {Object.entries(byAction)
              .sort((l, r) => r[1] - l[1])
              .map(([action, n]) => (
                <i
                  key={action}
                  title={`${actionMeta(action).label} ${n}`}
                  style={{ width: `${(n / max) * 100}%`, background: actionFill(actionMeta(action)) }}
                />
              ))}
          </span>
          <b>{fmtNum(total)}</b>
        </button>
      ))}
    </section>
  )
}

function TagCard({ summary }: { summary: TagSummary }): React.JSX.Element {
  const meta = tagMeta(summary.tag)
  const toneColor = TONE[meta.tone]
  const actions = summary.actions ?? {}
  const entries = Object.entries(actions)
    .filter((entry) => entry[1] > 0)
    .sort((left, right) => right[1] - left[1])
  const total = summary.calls > 0 ? summary.calls : entries.reduce((sum, entry) => sum + entry[1], 0)
  const buckets =
    summary.agreementBuckets === undefined
      ? []
      : Object.entries(summary.agreementBuckets).filter((entry) => entry[1] > 0)
  return (
    <article className="jev-card">
      <header className="jev-card-head">
        <div style={{ minWidth: 0 }}>
          <div className="jev-card-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span
              className="jev-swatch"
              style={{ background: toneColor, width: 9, height: 9, flex: 'none' }}
            />
            {meta.label}
          </div>
          <div className="jev-card-sub">{meta.hint}</div>
        </div>
        <div className="jev-card-metrics">
          <div>{fmtNum(total)} 次</div>
          {summary.latencyP50 !== undefined ? (
            <div>{`p50 ${String(summary.latencyP50)} / p95 ${String(summary.latencyP95 ?? summary.latencyP50)}ms`}</div>
          ) : null}
          {summary.costUsd !== undefined && summary.costUsd > 0 ? <div>{fmtUsd(summary.costUsd)}</div> : null}
          {summary.cached > 0 ? (
            <div style={{ color: TONE.business }}>{`缓存 ${String(summary.cached)}`}</div>
          ) : null}
          {summary.degraded > 0 ? (
            <div style={{ color: TONE.warn }}>{`降级 ${String(summary.degraded)}`}</div>
          ) : null}
        </div>
      </header>
      <div className="jev-stack">
        {entries.length === 0 ? (
          <i title="窗口内没有决策" style={{ width: '100%', background: TONE.muted, opacity: 0.22 }} />
        ) : (
          entries.map((entry) => (
            <i
              key={entry[0]}
              title={`${actionMeta(entry[0]).label} ${String(entry[1])}`}
              style={{
                width: `${String(total > 0 ? (entry[1] / total) * 100 : 0)}%`,
                background: actionFill(actionMeta(entry[0])),
                // 堆叠段之间的表面间隙（可视化规范）；末段不加避免贴边空隙。
                borderRight: entry === entries.at(-1) ? undefined : '2px solid var(--j-surface)',
              }}
            />
          ))
        )}
      </div>
      {entries.length === 0 ? (
        <p className="jev-note">窗口内还没有记录。</p>
      ) : (
        <ul className="jev-legend">
          {entries.map((entry) => (
            <li key={entry[0]}>
              <span className="jev-swatch" style={{ background: actionFill(actionMeta(entry[0])) }} />
              <span className="jev-legend-label">{actionMeta(entry[0]).label}</span>
              <b>{fmtNum(entry[1])}</b>
              <span className="jev-legend-pct">{`${String(total > 0 ? Math.round((entry[1] / total) * 100) : 0)}%`}</span>
            </li>
          ))}
        </ul>
      )}
      {buckets.length === 0 ? null : (
        <ul className="jev-mini">
          {buckets.map((entry) => {
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

/** Rows remain keyboard-operable; evidence keeps original values and scope. */
function LogRow({
  entry,
  open,
  onToggle,
}: {
  entry: LogEntry
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const detailRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open || detailRef.current === null) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    detailRef.current.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'instant' : 'smooth' })
  }, [open])
  const meta = actionMeta(entry.action)
  const scores = decisionScores(entry)
  return (
    <div
      className="jev-row"
      data-open={open ? '1' : '0'}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-label={`${clockOf(entry.ts)} ${entry.tool ?? tagMeta(entry.tag).label} ${meta.label}，${entry.mode === 'shadow' ? '观察记录' : '执行记录'}，${open ? '收起' : '展开'}证据`}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onToggle()
        }
      }}
    >
      <span className="jev-cell jev-time" title={entry.ts}>
        {clockOf(entry.ts)}
        <i>{relativeOf(entry.ts)}</i>
      </span>
      <span className="jev-cell jev-col-tag" style={{ color: TONE[tagMeta(entry.tag).tone] }}>
        {tagMeta(entry.tag).label}
      </span>
      <span className="jev-cell jev-mono jev-col-tool" title={entry.tool}>
        {entry.tool ?? '—'}
      </span>
      <span className="jev-cell">
        <Badge tone={meta.tone}>{meta.label}</Badge>
      </span>
      <span className="jev-cell jev-num jev-col-lat" title={entry.cached ? '缓存命中' : undefined}>
        {entry.latencyMs === undefined ? '—' : `${entry.latencyMs} ms`}
        {entry.cached && <Icon name="bolt" size={10} />}
      </span>
      <span className="jev-cell jev-num jev-col-mode">{MODE_LABEL[entry.mode] ?? entry.mode}</span>
      <span className="jev-cell jev-mono jev-detail jev-col-detail" title={entry.detail}>
        {entry.detail ?? '—'}
      </span>
      <span className="jev-row-chevron">
        <Icon name="chevron" size={13} style={{ color: TONE.muted }} />
      </span>
      {open && (
        <div ref={detailRef} className="jev-detail-full">
          <div className="jev-chips">
            <Badge tone={entry.mode === 'shadow' ? 'business' : 'brand'}>
              {entry.mode === 'shadow' ? '观察记录，未执行干预' : '执行模式记录'}
            </Badge>
            <span className="jev-note">{entry.ts}</span>
          </div>
          {scores.length > 0 && (
            <div className="jev-evidence" aria-label="判断证据">
              {scores.map((score) => (
                <div key={score.key}>
                  <div className="jev-score-label">
                    <span>{score.label}</span>
                    <b title={String(score.value)}>{score.value.toFixed(2)}</b>
                  </div>
                  <div className="jev-score-track">
                    <i
                      style={{
                        width: `${score.value * 100}%`,
                        background: score.key === 'inj' || score.key === 'irrev' ? TONE.warn : TONE.brand,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="jev-detail-grid">
            <div className="jev-kv">
              <span>模型</span>
              <b>{entry.model ?? '—'}</b>
            </div>
            <div className="jev-kv">
              <span>输入 Token</span>
              <b>{entry.inputTokens === undefined ? '—' : fmtNum(entry.inputTokens)}</b>
            </div>
            <div className="jev-kv">
              <span>成本</span>
              <b>{entry.costUsd === undefined ? '—' : fmtUsd(entry.costUsd)}</b>
            </div>
            <div className="jev-kv">
              <span>工具</span>
              <b className="jev-mono">{entry.tool ?? '—'}</b>
            </div>
            <div className="jev-kv">
              <span>调用 ID</span>
              <b className="jev-mono">{entry.callId ?? '—'}</b>
            </div>
            <div className="jev-kv">
              <span>会话 ID</span>
              <b className="jev-mono">{entry.sessionId ?? '—'}</b>
            </div>
          </div>
          <pre className="jev-raw">{entry.detail ?? '没有附加详情'}</pre>
        </div>
      )}
    </div>
  )
}

function MiniRow({ entry, onSelect }: { entry: LogEntry; onSelect: () => void }): React.JSX.Element {
  const meta = actionMeta(entry.action)
  return (
    <li>
      <button className="jev-mini-button" onClick={onSelect} title="查看这条决策的完整证据">
        <span className="jev-time">{clockOf(entry.ts)}</span>
        <span className="jev-cell jev-mono">{entry.tool ?? tagMeta(entry.tag).label}</span>
        <span>
          <Badge tone={meta.tone}>{meta.label}</Badge>
        </span>
        <span className="jev-detail">{entry.detail ?? '—'}</span>
        <Icon name="chevron" size={13} />
      </button>
    </li>
  )
}

export function JevPage(_props: JevPageProps): React.JSX.Element {
  const [status, setStatus] = useState<JevStatus | null>(null)
  const [stats, setStats] = useState<TagSummary[]>([])
  const [log, setLog] = useState<LogEntry[]>([])
  const [calib, setCalib] = useState<Calibration | null>(null)
  const [reportModel, setReportModel] = useState('')
  const [impact, setImpact] = useState<Impact | null>(null)
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  const [tab, setTab] = useState<string>('overview')
  const [loading, setLoading] = useState(true)
  const loadSequence = useRef(0)
  const [loadErr, setLoadErr] = useState('')
  const [dataWarning, setDataWarning] = useState('')
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
  const [providerDraft, setProviderDraft] = useState<ProviderChoice | null>(null)
  const [endpointDraft, setEndpointDraft] = useState('')
  const [modelDraft, setModelDraft] = useState('')
  const [credentialDraft, setCredentialDraft] = useState('')
  const [filterAction, setFilterAction] = useState('all')
  const [filterMode, setFilterMode] = useState('all')
  const [filterTag, setFilterTag] = useState('all')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  // 决策记录分页：一次拉满 API 上限 500 条本地分页，翻页零延迟。
  const [logPage, setLogPage] = useState(1)
  const [pageJump, setPageJump] = useState('')

  const load = useCallback(async (silent: boolean): Promise<void> => {
    const sequence = ++loadSequence.current
    if (!silent) setLoading(true)
    try {
      const [statusResult, statsResult, logResult, impactResult, readinessResult] = await Promise.allSettled([
        getJson('/status'),
        getJson('/stats'),
        getJson('/log?limit=500'),
        getJson('/impact'),
        getJson('/readiness'),
      ])
      if (sequence !== loadSequence.current) return
      if (statusResult.status === 'fulfilled') {
        setStatus(statusResult.value as JevStatus)
        setLoadErr('')
      } else {
        const code = (statusResult.reason as { status?: number } | undefined)?.status
        setLoadErr(
          code === 401
            ? '需要登录后才能读取面板数据。'
            : code === 404
              ? '当前组合没有注册面板 API（需要 web 组合）。'
              : '无法连接本地 API，请确认 dsh 宿主仍在运行。',
        )
      }
      if (statsResult.status === 'fulfilled') {
        setStats(Array.isArray(statsResult.value) ? (statsResult.value as TagSummary[]) : [])
      }
      if (logResult.status === 'fulfilled') {
        const entries = Array.isArray(logResult.value) ? (logResult.value as LogEntry[]) : []
        entries.sort((left, right) => (left.ts < right.ts ? 1 : left.ts > right.ts ? -1 : 0))
        setLog(entries)
      }
      if (impactResult.status === 'fulfilled') {
        setImpact(impactResult.value as Impact)
      }
      if (readinessResult.status === 'fulfilled') {
        setReadiness(readinessResult.value as Readiness)
      }
      const unavailable = [
        [statsResult, '环节统计'],
        [logResult, '决策记录'],
        [impactResult, '效果汇总'],
        [readinessResult, '就绪度'],
      ] as const
      setDataWarning(
        unavailable
          .filter(([result]) => result.status === 'rejected')
          .map(([, label]) => label)
          .join('、'),
      )
      if (statusResult.status === 'fulfilled') setUpdatedAt(Date.now())
    } finally {
      if (sequence === loadSequence.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(false)
  }, [])

  // 自动刷新：页面不可见时跳过，避免后台空转。
  useEffect(() => {
    if (!autoRefresh) return undefined
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void load(true)
    }, REFRESH_MS)
    return () => {
      clearInterval(timer)
    }
  }, [autoRefresh, load])

  // 提示 4 秒后自动消失。
  useEffect(() => {
    if (toast === null) return undefined
    const timer = setTimeout(() => {
      setToast(null)
    }, 4_000)
    return () => {
      clearTimeout(timer)
    }
  }, [toast])

  /** 乐观更新 + 失败回滚的统一写入口。 */
  const applyPatch = useCallback(
    async (
      busyKey: string,
      patch: Record<string, unknown>,
      optimistic?: Partial<JevStatus>,
    ): Promise<boolean> => {
      const previous = status
      setBusy(busyKey)
      setToast(null)
      if (previous !== null && optimistic !== undefined) setStatus({ ...previous, ...optimistic })
      try {
        const persisted = await putConfig(patch)
        const volatile = persisted === false || (persisted === undefined && previous?.persistPath === null)
        setToast({
          tone: volatile ? 'warn' : 'ok',
          text: volatile ? MEMORY_ONLY : '已保存',
        })
        await load(true)
        return true
      } catch (error) {
        if (previous !== null) setStatus(previous)
        setToast({ tone: 'err', text: `保存失败：${error instanceof Error ? error.message : String(error)}` })
        return false
      } finally {
        setBusy('')
      }
    },
    [status, load],
  )

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
      if (!response.ok) {
        setPingResult({ ok: false, latencyMs: 0, error: `http-${response.status}` })
      } else {
        const result = (await response.json()) as PingResult
        setPingResult(result)
        if (result.ok && result.error === undefined && draft === undefined) void load(true)
      }
    } catch {
      setPingResult({ ok: false, latencyMs: 0, error: 'network' })
    } finally {
      setPingBusy(false)
    }
  }, [keyDraft, keyLocked, load])

  const runCalibration = useCallback(async (model: string): Promise<void> => {
    setCalibBusy(true)
    setToast(null)
    try {
      const path = model === '' ? '/calibration' : `/calibration?model=${encodeURIComponent(model)}`
      setCalib((await getJson(path)) as Calibration)
      setReportModel(model)
    } catch (error) {
      setToast({ tone: 'err', text: `校准失败：${error instanceof Error ? error.message : String(error)}` })
    } finally {
      setCalibBusy(false)
    }
  }, [])

  /** 一键应用单条校准建议：PUT 阈值（热生效），成功后重新生成报告看采纳标记。 */
  const applyAdvice = useCallback(
    async (param: string, current: number, suggested: number): Promise<void> => {
      setToast(null)
      // 入口即置忙：PUT 往返期间禁用所有应用/生成按钮（防双击重复 PUT 与并发报告）。
      setCalibBusy(true)
      try {
        const model = calib?.scope?.model
        const scope = model == null ? {} : { calibrationModel: model, calibrationCurrent: current }
        const persisted = await putConfig({ [param]: suggested, ...scope })
        const text = `已应用 ${param} → ${suggested.toFixed(2)}。${persisted === false ? MEMORY_ONLY : ''}`
        try {
          setCalib(await getJson('/calibration') as Calibration)
          setReportModel('')
          setToast({ tone: persisted === false ? 'warn' : 'ok', text })
        } catch {
          setToast({ tone: 'warn', text: `${text}报告未能刷新。` })
        }
      } catch (error) {
        setToast({ tone: 'err', text: `应用失败：${error instanceof Error ? error.message : String(error)}` })
      } finally {
        setCalibBusy(false)
      }
    },
    [calib],
  )

  /** 更新预批准名单（整组替换，热生效）；add=true 加入 / false 移除。 */
  const applyAllowlist = useCallback(
    async (tool: string, add: boolean): Promise<void> => {
      if (status === null) return
      const current = status.preapproveAllowlist ?? []
      const next = add ? [...new Set([...current, tool])].sort() : current.filter((item) => item !== tool)
      setToast(null)
      setBusy('allowlist')
      try {
        const model = calib?.scope?.model
        const scope = add && model != null ? { calibrationModel: model } : {}
        const persisted = await putConfig({ preapproveToolAllowlist: next, ...scope })
        setStatus({ ...status, preapproveAllowlist: next })
        setToast({
          tone: persisted === false ? 'warn' : 'ok',
          text: `${add ? `已把 ${tool} 加入预批准名单。` : `已把 ${tool} 移出预批准名单。`}${persisted === false ? MEMORY_ONLY : ''}`,
        })
      } catch (error) {
        setToast({
          tone: 'err',
          text: `名单更新失败：${error instanceof Error ? error.message : String(error)}`,
        })
      } finally {
        setBusy('')
      }
    },
    [status, calib],
  )

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

  const filteredLog = useMemo(
    () =>
      filterDecisions(log, {
        action: filterAction,
        mode: filterMode,
        tag: filterTag,
        query,
      }),
    [log, filterAction, filterMode, filterTag, query],
  )

  /** 每页 20 条，翻页不需要再次请求宿主。 */
  const LOG_PAGE_SIZE = 20
  const totalPages = Math.max(1, Math.ceil(filteredLog.length / LOG_PAGE_SIZE))
  const safePage = Math.min(Math.max(1, logPage), totalPages)
  const rows = useMemo(
    () => filteredLog.slice((safePage - 1) * LOG_PAGE_SIZE, safePage * LOG_PAGE_SIZE),
    [filteredLog, safePage],
  )

  /** 筛选变化回第 1 页（避免停在一个不存在的高页码上看空表）。 */
  useEffect(() => {
    setLogPage(1)
  }, [filterAction, filterMode, filterTag, query])

  /** 翻页：切页并把 tab 内容区滚回顶部（新页内容从表格第一行开始看）。 */
  const gotoPage = useCallback(
    (page: number): void => {
      setLogPage(Math.min(Math.max(1, page), totalPages))
      setPageJump('')
      if (typeof document !== 'undefined') {
        const body = document.querySelector('.jev-tab-body')
        if (body !== null) body.scrollTop = 0
      }
    },
    [totalPages],
  )

  const recent = useMemo(() => log.slice(0, 6), [log])

  const provider = status === null ? 'typesafe' : status.provider
  const mode = status === null ? 'shadow' : status.mode
  const keySource = status === null ? 'none' : status.keySource
  const selectedProvider = providerDraft ?? provider
  const choosingCustom = selectedProvider === 'custom'
  const endpointInput = endpointDraft.trim()
  const modelInput = modelDraft.trim()
  const credentialInput = credentialDraft.trim()
  const connectionDirty = selectedProvider !== provider
    || (choosingCustom && (endpointInput !== '' || modelInput !== '' || credentialInput !== ''))
  let draftOrigin = status?.endpointOrigin
  if (choosingCustom && endpointInput !== '') {
    try { draftOrigin = new URL(endpointInput).origin } catch { draftOrigin = null }
  }
  const changesTarget = selectedProvider !== provider || draftOrigin !== status?.endpointOrigin
  const customReady = (!changesTarget || (endpointInput !== '' && draftOrigin !== null))
    && (endpointInput !== '' || status?.endpointOrigin != null)
    && (modelInput !== '' || (provider === 'custom' && !!status?.model))
    && (!changesTarget || credentialInput !== '')
  const clearConnectionDraft = (): void => {
    setProviderDraft(null)
    setEndpointDraft('')
    setModelDraft('')
    setCredentialDraft('')
  }
  const clearKeyDraft = (): void => {
    setKeyDraft('')
    setKeyMask('')
    setKeyLocked(false)
    setShowKey(false)
    setPingResult(null)
  }
  const useCredentialReference = async (): Promise<void> => {
    if (await applyPatch('key-reference', { apiKey: '' })) clearKeyDraft()
  }
  const saveConnection = async (): Promise<void> => {
    if (!connectionDirty || (choosingCustom && !customReady) || busy !== '' || pingBusy) return
    const patch: Record<string, unknown> = { provider: selectedProvider }
    if (choosingCustom) {
      if (endpointInput !== '') patch.endpoint = endpointInput
      if (modelInput !== '') patch.model = modelInput
      if (credentialInput !== '') patch.apiKeyEnv = credentialInput
    } else {
      Object.assign(patch, { endpoint: '', model: '', apiKeyEnv: '' })
    }
    if (changesTarget) patch.apiKey = ''
    if (await applyPatch('connection', patch)) {
      clearConnectionDraft()
      setPingResult(null)
      if (changesTarget) clearKeyDraft()
    }
  }

  useEffect(() => { setPingResult(null) }, [status?.provider, status?.model, status?.endpointOrigin])
  const canApplyCalibration = calib?.scope === undefined
    || (calib.scope.model !== null && calib.scope.model === (status?.activeModel === undefined ? calib.scope.currentModel : status.activeModel))
  const activeFilters =
    filterAction !== 'all' || filterMode !== 'all' || filterTag !== 'all' || query.trim().length > 0
  const resetFilters = (): void => {
    setFilterAction('all')
    setFilterMode('all')
    setFilterTag('all')
    setQuery('')
    setExpanded(null)
  }
  const filterChips = Object.keys(actionCounts).sort(
    (left, right) => (actionCounts[right] ?? 0) - (actionCounts[left] ?? 0),
  )

  const openRecord = (entry: LogEntry): void => {
    resetFilters()
    const index = log.indexOf(entry)
    const page = Math.floor(Math.max(0, index) / LOG_PAGE_SIZE) + 1
    setLogPage(page)
    setExpanded(entryKey(entry, Math.max(0, index) % LOG_PAGE_SIZE))
    setTab('log')
  }

  const selectTool = (tool: string): void => {
    resetFilters()
    setQuery(tool)
    setTab('log')
  }

  const exportLog = (): void => {
    const blob = new Blob([JSON.stringify(filteredLog, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `jev-decisions-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    setTimeout(() => {
      URL.revokeObjectURL(url)
    }, 1_000)
    setToast({ tone: 'ok', text: `已导出当前筛选的 ${filteredLog.length} 条记录` })
  }

  const renderOnboarding = (): React.JSX.Element | null => {
    if (status === null) return null
    const keyReady = status.keyConfigured || status.keySource === 'credentials' || status.keySource === 'env'
    if (keyReady && status.enabled && status.mode === 'enforce') return null
    if (keyReady && status.enabled && aggregate.calls > 0)
      return (
        <div className="jev-banner">
          <Icon name="info" />
          <span>{readiness?.reason ?? '正在积累观察数据，确认判断符合预期后再切换执行模式。'}</span>
          <button
            className="jev-btn jev-btn--quiet"
            onClick={() => {
              setTab('calibration')
            }}
          >
            查看校准
            <Icon name="arrow" size={14} />
          </button>
        </div>
      )
    const steps = [
      {
        done: keyReady,
        title: '连接 Jev',
        hint: '在设置中配置 Key 并测试连接',
        action: (
          <button
            className="jev-btn"
            onClick={() => {
              setTab('settings')
            }}
          >
            配置连接
          </button>
        ),
      },
      {
        done: status.enabled,
        title: '开始观察',
        hint: '记录判断，保持原有审批流程',
        action: (
          <button
            className="jev-btn"
            disabled={busy !== ''}
            onClick={() => {
              void applyPatch('enabled', { enabled: true, mode: 'shadow' }, { enabled: true, mode: 'shadow' })
            }}
          >
            启用观察
          </button>
        ),
      },
      {
        done: false,
        title: '评估后执行',
        hint: readiness?.reason ?? '积累样本后，检查风险与一致率',
        action:
          keyReady && status.enabled && readiness?.ready ? (
            <button
              className="jev-btn"
              disabled={busy !== ''}
              onClick={() => {
                void applyPatch('mode', { mode: 'enforce' }, { mode: 'enforce' })
              }}
            >
              切换执行
            </button>
          ) : null,
      },
    ]
    return (
      <section className="jev-card jev-onboarding">
        <div className="jev-card-title">开始使用</div>
        <ol className="jev-onboarding-steps">
          {steps.map((step, index) => (
            <li key={step.title}>
              <span className="jev-step-number" style={{ color: step.done ? TONE.ok : undefined }}>
                {step.done ? <Icon name="check" size={13} /> : index + 1}
              </span>
              <div className="jev-step-copy">
                <b>{step.title}</b>
                <p className="jev-note">{step.hint}</p>
                {!step.done && step.action}
              </div>
            </li>
          ))}
        </ol>
      </section>
    )
  }

  const renderImpact = (): React.JSX.Element => (
    <section className="jev-card jev-card--impact">
      <header className="jev-card-head">
        <div>
          <div className="jev-card-title">实际效果</div>
          <div className="jev-card-sub">仅统计执行模式下生效的动作</div>
        </div>
        <Icon name="shield" style={{ marginLeft: 'auto', color: TONE.ok }} />
      </header>
      {impact === null ? (
        <p className="jev-note">效果汇总暂不可用，请刷新重试。</p>
      ) : (
        <Fragment>
          <div className="jev-impact-values">
            <div>
              <b style={{ color: TONE.ok }}>{fmtNum(impact.enforce.autoApproved)}</b>
              <span>省去审批</span>
            </div>
            <div>
              <b style={{ color: TONE.warn }}>{fmtNum(impact.enforce.asked)}</b>
              <span>转交人工</span>
            </div>
            <div>
              <b style={{ color: TONE.err }}>{fmtNum(impact.enforce.denied)}</b>
              <span>风险拦截</span>
            </div>
          </div>
          <div className="jev-impact-facts">
            <Fact label="全部模式成本">{fmtUsdCard(impact.cost) || '未报告'}</Fact>
            <Fact label="响应 p50 / p95">
              {impact.latency.p50 === undefined
                ? '—'
                : `${impact.latency.p50} / ${impact.latency.p95 ?? '—'} ms`}
            </Fact>
            <Fact label="免费缓存命中">{fmtNum(impact.cost.cachedDecisions)} 次</Fact>
          </div>
          <div className="jev-chips">
            {misApprovalBadge(impact)}
            {(impact.agreement.enforce['friction-human-approved'] ?? 0) > 0 && (
              <Badge tone="warn">
                多余人工 {fmtNum(impact.agreement.enforce['friction-human-approved'])}
              </Badge>
            )}
            {(impact.agreement.shadow['would-over-approve'] ?? 0) > 0 && (
              <Badge tone="business">
                观察对照误批 {fmtNum(impact.agreement.shadow['would-over-approve'])}
              </Badge>
            )}
            {impact.enforce.stagnationAlerts > 0 && (
              <Badge tone="warn">停滞提醒 {fmtNum(impact.enforce.stagnationAlerts)}</Badge>
            )}
          </div>
          <p className="jev-note">{oneLineSummary(impact)}</p>
          <p className="jev-card-sub">
            汇总 {fmtNum(impact.windowSize)} 条，{impact.firstTs?.slice(0, 10) ?? '—'} 至{' '}
            {impact.lastTs?.slice(0, 10) ?? '—'}（UTC）
          </p>
        </Fragment>
      )}
    </section>
  )

  const renderOverview = (): React.JSX.Element => (
    <div className="jev-page">
      <div className="jev-section-head">
        <div>
          <h3>决策概况</h3>
          <p>风险如何处理，每一次都有迹可循。</p>
        </div>
        <span className="jev-scope">环节统计窗口 {fmtNum(aggregate.calls)} 条，含观察记录</span>
      </div>
      {renderOnboarding()}
      <div className="jev-metrics">
        <Kpi label="决策总数" value={aggregate.calls} icon="activity" hint="当前环节统计窗口" />
        <Kpi label="自动批准" value={aggregate.auto} tone="ok" icon="check" hint="含观察模式的预期动作" />
        <Kpi label="转交人工" value={aggregate.ask} tone="warn" icon="pause" hint="风险不确定，交回人工" />
        <Kpi label="风险拒绝" value={aggregate.deny} tone="err" icon="shield" hint="含观察模式的预期动作" />
        <Kpi
          label="降级回退"
          value={aggregate.degraded}
          tone="muted"
          icon="refresh"
          hint="未完成判断，回到原生流程"
        />
      </div>
      {stats.length === 0 && !loading ? (
        <div className="jev-empty">
          <Icon name="activity" size={30} />
          <b>等待第一条决策</b>
          <div>启用后，工具调用或会话引用会在这里留下记录。</div>
          <button
            className="jev-btn"
            onClick={() => {
              setTab('settings')
            }}
          >
            检查连接设置
          </button>
        </div>
      ) : (
        <Fragment>
          <div className="jev-overview-main">
            <DailyTrend log={log} />
            {renderImpact()}
          </div>
          <div className="jev-section-head">
            <h3>各环节表现</h3>
            <span className="jev-scope">与上方概况同一统计窗口</span>
          </div>
          <div className="jev-tag-grid">
            {stats.map((summary) => (
              <TagCard key={summary.tag} summary={summary} />
            ))}
          </div>
          <div className="jev-grid">
            <section className="jev-card">
              <header className="jev-card-head">
                <div>
                  <div className="jev-card-title">最近决策</div>
                  <div className="jev-card-sub">点击记录，查看判断证据</div>
                </div>
                <button
                  className="jev-btn jev-btn--quiet"
                  style={{ marginLeft: 'auto' }}
                  onClick={() => {
                    setTab('log')
                  }}
                >
                  全部记录
                  <Icon name="arrow" size={14} />
                </button>
              </header>
              <ul className="jev-mini">
                {recent.map((entry, index) => (
                  <MiniRow
                    key={entryKey(entry, index)}
                    entry={entry}
                    onSelect={() => {
                      openRecord(entry)
                    }}
                  />
                ))}
              </ul>
            </section>
            <ToolTopCard log={log} onSelect={selectTool} />
          </div>
          <p className="jev-note">
            活动图与工具分布取自最近 {fmtNum(log.length)} 条记录。观察模式只记录预期动作，实际效果单独统计。
          </p>
        </Fragment>
      )}
    </div>
  )

  const renderLog = (): React.JSX.Element => (
    <div className="jev-page">
      <div className="jev-section-head">
        <div>
          <h3>决策记录</h3>
          <p>从动作追到证据，核对每一次判断。</p>
        </div>
        <button className="jev-btn" disabled={filteredLog.length === 0} onClick={exportLog}>
          <Icon name="download" size={14} />
          导出 JSON
        </button>
      </div>
      <div className="jev-filterbox">
        <div className="jev-chips" role="group" aria-label="按决策动作筛选">
          <button
            className="jev-chip"
            data-on={filterAction === 'all' ? '1' : '0'}
            aria-pressed={filterAction === 'all'}
            onClick={() => {
              setFilterAction('all')
            }}
          >
            全部<b>{fmtNum(log.length)}</b>
          </button>
          {filterChips.map((action) => (
            <button
              key={action}
              className="jev-chip"
              data-on={filterAction === action ? '1' : '0'}
              aria-pressed={filterAction === action}
              onClick={() => {
                setFilterAction(action)
              }}
            >
              <i className="jev-swatch" style={{ background: actionFill(actionMeta(action)) }} />
              {actionMeta(action).label}
              <b>{fmtNum(actionCounts[action])}</b>
            </button>
          ))}
        </div>
        <div className="jev-toolbar">
          <div className="jev-search-wrap">
            <Icon name="search" size={15} />
            <input
              className="jev-search"
              type="search"
              aria-label="搜索决策记录"
              placeholder="搜索工具、详情、会话或调用 ID"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
              }}
            />
          </div>
          <select
            className="jev-select"
            value={filterTag}
            aria-label="按决策环节筛选"
            onChange={(event) => {
              setFilterTag(event.target.value)
            }}
          >
            <option value="all">全部环节</option>
            {[...new Set(log.map((entry) => entry.tag))].map((tag) => (
              <option key={tag} value={tag}>
                {tagMeta(tag).label}
              </option>
            ))}
          </select>
          <Segmented
            label="按生效模式筛选"
            value={filterMode}
            options={[
              { value: 'all', label: '全部模式' },
              { value: 'shadow', label: '观察' },
              { value: 'enforce', label: '执行' },
            ]}
            onChange={setFilterMode}
          />
          {activeFilters && (
            <button className="jev-btn jev-btn--quiet" onClick={resetFilters}>
              重置
            </button>
          )}
        </div>
      </div>
      <div className="jev-section-head">
        <span className="jev-note" aria-live="polite">
          {activeFilters
            ? `匹配 ${fmtNum(filteredLog.length)} 条 / 已载入 ${fmtNum(log.length)} 条`
            : `已载入最近 ${fmtNum(log.length)} 条`}
        </span>
        <span className="jev-scope">时间倒序，点击或按 Enter 展开证据</span>
      </div>
      {log.length === 0 ? (
        <div className="jev-empty">
          <Icon name="log" size={30} />
          <b>还没有决策记录</b>
          <div>启用后，工具调用与会话引用会在这里留痕。</div>
        </div>
      ) : rows.length === 0 ? (
        <div className="jev-empty">
          <Icon name="search" size={30} />
          <b>没有匹配的决策</b>
          <div>尝试其他工具名、调用 ID，或清除筛选。</div>
          <button className="jev-btn" onClick={resetFilters}>
            清除筛选
          </button>
        </div>
      ) : (
        <div className="jev-table">
          <div className="jev-thead" aria-hidden="true">
            <span>时间</span>
            <span className="jev-col-tag">环节</span>
            <span>工具</span>
            <span>动作</span>
            <span className="jev-col-lat">延迟</span>
            <span className="jev-col-mode">模式</span>
            <span className="jev-col-detail">判断摘要</span>
            <span />
          </div>
          {rows.map((entry, index) => {
            const key = entryKey(entry, index)
            return (
              <LogRow
                key={key}
                entry={entry}
                open={expanded === key}
                onToggle={() => {
                  setExpanded(expanded === key ? null : key)
                }}
              />
            )
          })}
        </div>
      )}
      <div className="jev-pagination">
        <span className="jev-note">
          {filteredLog.length === 0
            ? '0 条记录'
            : `${(safePage - 1) * LOG_PAGE_SIZE + 1}–${Math.min(safePage * LOG_PAGE_SIZE, filteredLog.length)} / ${fmtNum(filteredLog.length)} 条`}
        </span>
        <div className="jev-pagination-nav">
          <button
            className="jev-btn"
            disabled={safePage <= 1}
            onClick={() => {
              gotoPage(1)
            }}
            aria-label="第一页"
          >
            «
          </button>
          <button
            className="jev-btn"
            disabled={safePage <= 1}
            onClick={() => {
              gotoPage(safePage - 1)
            }}
            aria-label="上一页"
          >
            ‹
          </button>
          <label className="jev-note" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input
              className="jev-input"
              style={{ width: 48, textAlign: 'center', padding: 4 }}
              aria-label="跳转页码，按 Enter 确认"
              type="number"
              min={1}
              max={totalPages}
              value={pageJump}
              placeholder={String(safePage)}
              onChange={(event) => {
                setPageJump(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  const target = Number.parseInt(pageJump, 10)
                  if (Number.isFinite(target)) gotoPage(target)
                }
              }}
            />{' '}
            / {totalPages}
          </label>
          <button
            className="jev-btn"
            disabled={safePage >= totalPages}
            onClick={() => {
              gotoPage(safePage + 1)
            }}
            aria-label="下一页"
          >
            ›
          </button>
          <button
            className="jev-btn"
            disabled={safePage >= totalPages}
            onClick={() => {
              gotoPage(totalPages)
            }}
            aria-label="最后一页"
          >
            »
          </button>
        </div>
      </div>
      <p className="jev-note">
        面板最多展示最近 500 条；更早记录可用 /jev-log 查看。导出只包含当前筛选结果。
      </p>
    </div>
  )

  const renderCalibration = (): React.JSX.Element => (
    <div className="jev-page">
      <div className="jev-section-head">
        <div>
          <h3>阈值校准</h3>
          <p>用观察数据检验阈值，逐项决定是否采纳。</p>
        </div>
        <button
          className="jev-btn jev-btn--primary"
          disabled={calibBusy || busy !== ''}
          onClick={() => {
            void runCalibration(reportModel)
          }}
        >
          <Icon name="sliders" size={14} />
          {calibBusy ? '分析中…' : calib === null ? '生成校准报告' : '重新分析'}
        </button>
      </div>
      <div className="jev-calibration-layout">
        <div className="jev-advice-list">
          {calib === null ? (
            <div className="jev-empty">
              <Icon name="sliders" size={32} />
              <b>让数据给出调整依据</b>
              <div>
                分析现有遥测，查看阈值建议、样本量和可能的影响。
                <br />
                报告不会自动修改配置。
              </div>
            </div>
          ) : (
            <Fragment>
              <section className="jev-card">
                <header className="jev-card-head">
                  <div>
                    <div className="jev-card-title">本次分析</div>
                    <div className="jev-card-sub">{calib.scope === undefined
                      ? `最近 ${fmtNum(calib.windowSize)} 条遥测记录`
                      : `纳入 ${fmtNum(calib.windowSize)} / ${fmtNum(calib.scope.scanned)} 条决策与一致率记录`}</div>
                  </div>
                  <Badge tone="business">{calib.advice.length} 项阈值建议</Badge>
                </header>
                {calib.scope !== undefined && <div className="jev-field">
                  <label className="jev-field-label" htmlFor="jev-calibration-model">回放模型版本</label>
                  <select id="jev-calibration-model" className="jev-select" value={reportModel}
                    disabled={calibBusy || busy !== ''} onChange={(event) => { void runCalibration(event.target.value) }}>
                    <option value="">当前模型</option>
                    {calib.scope.models.map(item => <option key={item.model} value={item.model}>{item.model}（{fmtNum(item.samples)} 条）</option>)}
                  </select>
                  <Fact label="本次使用的版本">{calib.scope.model ?? '待连接测试确认'}</Fact>
                  {!canApplyCalibration && calib.scope.model !== null &&
                    <p className="jev-note">这份报告对应历史版本。选择当前模型可生成可用建议。</p>}
                </div>}
                <div className="jev-chips">
                  <Badge tone="brand">守门人 {fmtNum(calib.counts.guard)}</Badge>
                  <Badge tone="ok">预批准 {fmtNum(calib.counts.preapprove)}</Badge>
                  <Badge tone="muted">一致率 {fmtNum(calib.counts.approvalLoop)}</Badge>
                </div>
                <Fact label="模式构成">
                  观察 {fmtNum(calib.modeSplit.shadow)} / 执行 {fmtNum(calib.modeSplit.enforce)}
                </Fact>
                {calib.history !== undefined && (
                  <p className="jev-note">
                    与 {calib.history.previousTs.slice(0, 10)} 的报告相比：采纳 {calib.history.adopted}{' '}
                    项，未采纳 {calib.history.ignored} 项
                    {calib.history.manual ? `，手动修改 ${calib.history.manual} 项` : ''}。
                  </p>
                )}
              </section>
              {calib.advice.length === 0 ? (
                <div className="jev-empty">
                  <Icon name="check" size={28} />
                  <b>{calib.windowSize === 0 ? '没有可用于回放的样本' : calib.insufficient.length > 0 ? '暂不建议调整' : '当前无需调整阈值'}</b>
                  <div>
                    {calib.windowSize === 0 ? '检查连接，或选择已有记录的模型版本。' : calib.insufficient.length > 0
                      ? '部分环节样本不足，继续观察后再分析。'
                      : '当前样本没有产生新的阈值建议。'}
                  </div>
                </div>
              ) : (
                calib.advice.map((advice) => (
                  <article key={advice.param} className="jev-advice">
                    <div className="jev-advice-head">
                      <Badge tone={paramTone(advice.param)}>
                        {advice.param.startsWith('guard') ? '守门人' : '预批准'}
                      </Badge>
                      <span className="jev-param">{advice.param}</span>
                      <Badge tone="muted">{fmtNum(advice.samples)} 条样本</Badge>
                    </div>
                    <div className="jev-advice-head">
                      <span className="jev-delta">
                        <del>{advice.current.toFixed(2)}</del>
                        <i>→</i>
                        {advice.suggested.toFixed(2)}
                      </span>
                      <button
                        className="jev-btn"
                        style={{ marginLeft: 'auto' }}
                        disabled={calibBusy || busy !== '' || !canApplyCalibration}
                        onClick={() => {
                          void applyAdvice(advice.param, advice.current, advice.suggested)
                        }}
                      >
                        应用此建议
                      </button>
                    </div>
                    <p className="jev-note">{advice.basis}</p>
                    {advice.note && <p className="jev-note">{advice.note}</p>}
                  </article>
                ))
              )}
              {(calib.allowlistSuggestions?.length ?? 0) > 0 && (
                <section className="jev-card">
                  <div className="jev-card-title">预批准候选工具</div>
                  <p className="jev-note">
                    观察记录均为低风险。加入名单后，每次调用仍需通过授权与参数证据检查。
                  </p>
                  {calib.allowlistSuggestions!.map((item) => {
                    const added = status?.preapproveAllowlist?.includes(item.tool) === true
                    return (
                      <div key={item.tool} className="jev-advice">
                        <div className="jev-advice-head">
                          <span className="jev-param">{item.tool}</span>
                          <button
                            className="jev-btn"
                            style={{ marginLeft: 'auto' }}
                            disabled={busy !== '' || calibBusy || added || !canApplyCalibration}
                            onClick={() => {
                              void applyAllowlist(item.tool, true)
                            }}
                          >
                            {added ? '已在名单' : '加入名单'}
                          </button>
                        </div>
                        <p className="jev-note">
                          {item.samples} 条样本，平均置信 {item.avgConfidence.toFixed(2)}，平均不可逆{' '}
                          {item.avgIrreversibility.toFixed(2)}，最高注入嫌疑 {item.maxInjection.toFixed(2)}
                        </p>
                      </div>
                    )
                  })}
                </section>
              )}
              {calib.insufficient.length > 0 && (
                <section className="jev-card">
                  <div className="jev-card-title">样本仍需积累</div>
                  {calib.insufficient.map((item) => (
                    <p key={item.param} className="jev-note">
                      {item.reason}
                    </p>
                  ))}
                </section>
              )}
              {calib.observations.length > 0 && (
                <section className="jev-card">
                  <div className="jev-card-title">需要留意</div>
                  {calib.observations.map((item, index) => (
                    <p key={`${item.param}-${index}`} className="jev-note">
                      {item.reason}
                    </p>
                  ))}
                </section>
              )}
            </Fragment>
          )}
        </div>
        <aside className="jev-card jev-calibration-intro">
          <Icon name="shield" size={25} />
          <div className="jev-card-title">小步调整，持续验证</div>
          <p className="jev-note">建议由现有决策重放得出。先看样本量与影响，再应用单项调整。</p>
          <Fact label="当前模型">{status?.activeModel ?? status?.model ?? '—'}</Fact>
          <Fact label="当前观察样本">{readiness === null ? '—' : fmtNum(readiness.shadowSamples)}</Fact>
          <Fact label="观察期降级率">
            {readiness === null ? '—' : `${(readiness.degradedRate * 100).toFixed(1)}%`}
          </Fact>
          {readiness !== null && <p className="jev-note">{readiness.reason}</p>}
          <p className="jev-note">应用后，下一个调用即使用新阈值。建议采纳情况会在下次报告中展示。</p>
        </aside>
      </div>
    </div>
  )

  const renderSettings = (): React.JSX.Element => {
    return (
      <div className="jev-page">
        <div className="jev-section-head">
          <div>
            <h3>连接与运行设置</h3>
            <p>配置服务、管理审批范围，修改后即时生效。</p>
          </div>
          <span className="jev-setting-status">
            <i className="jev-dot" style={{ color: keySource === 'none' ? TONE.warn : TONE.ok }} />
            {keySource === 'none' ? '尚未配置 Key' : '已配置凭据'}
          </span>
        </div>
        <div className="jev-grid">
          <section className="jev-card">
            <header className="jev-card-head">
              <div>
                <div className="jev-card-title">连接</div>
                <div className="jev-card-sub">保存后使用选定的服务与模型。</div>
              </div>
            </header>
            <div className="jev-provider">
              {PROVIDERS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  data-on={selectedProvider === item.id ? '1' : '0'}
                  aria-pressed={selectedProvider === item.id}
                  disabled={busy !== '' || pingBusy}
                  onClick={() => {
                    clearConnectionDraft()
                    setProviderDraft(item.id === provider ? null : item.id)
                  }}
                >
                  <b>{item.label}</b>
                  <span>{item.hint}</span>
                </button>
              ))}
            </div>
            <Fact label="请求模型">{status?.model || '未配置'}</Fact>
            {status?.activeModel != null && status.activeModel !== status.model &&
              <Fact label="实际响应模型">{status.activeModel}</Fact>}
            {status?.endpointOrigin && <Fact label="当前地址">{status.endpointOrigin}</Fact>}
            {status?.connectionError && <p className="jev-note" style={{ color: TONE.err }}>{status.connectionError}</p>}
            <form className="jev-field" onSubmit={(event) => { event.preventDefault(); void saveConnection() }}>
              {choosingCustom && <Fragment>
                <div className="jev-field">
                  <label className="jev-field-label" htmlFor="jev-endpoint">完整端点</label>
                  <input className="jev-input" id="jev-endpoint" type="url"
                    placeholder="https://example.com/v1/systemone" value={endpointDraft}
                    onChange={(event) => { setEndpointDraft(event.target.value) }} />
                </div>
                <div className="jev-field">
                  <label className="jev-field-label" htmlFor="jev-model">模型 ID</label>
                  <input className="jev-input" id="jev-model" placeholder={provider === 'custom' ? status?.model : '例如 jev-1.14.0'}
                    value={modelDraft} onChange={(event) => { setModelDraft(event.target.value) }} />
                </div>
                <div className="jev-field">
                  <label className="jev-field-label" htmlFor="jev-credential">凭据引用</label>
                  <input className="jev-input" id="jev-credential" placeholder={changesTarget ? '例如 JEV_CUSTOM_API_KEY' : status?.keyReference}
                    value={credentialDraft} onChange={(event) => { setCredentialDraft(event.target.value) }} />
                  <p className="jev-note">填写环境变量名。在新地址上使用对应的凭据。</p>
                </div>
              </Fragment>}
              {connectionDirty && <div className="jev-field">
                {changesTarget && keySource === 'config' && <p className="jev-note">保存新连接会移除当前保存的 Key，并改用新连接的凭据引用。</p>}
                <div className="jev-toolbar">
                  <button type="submit" className="jev-btn jev-btn--primary" disabled={busy !== '' || pingBusy || (choosingCustom && !customReady)}>{busy === 'connection' ? '保存中…' : '保存连接'}</button>
                  <button type="button" className="jev-btn jev-btn--quiet" disabled={busy !== ''} onClick={clearConnectionDraft}>取消</button>
                </div>
              </div>}
            </form>
          </section>

          <section className="jev-card">
            <header className="jev-card-head">
              <div>
                <div className="jev-card-title">API Key</div>
                <div className="jev-card-sub">来源：{KEY_SOURCE[keySource] ?? keySource}{keySource !== 'config' && status?.keyReference ? `（${status.keyReference}）` : ''}</div>
              </div>
            </header>
            {status?.keyError && <p className="jev-note" style={{ color: TONE.warn }}>{status.keyError}</p>}
            {connectionDirty && <p className="jev-note">先保存连接，再输入或测试对应的 API Key。</p>}
            <div className="jev-field">
              <label className="jev-field-label" htmlFor="jev-api-key">
                {keyLocked
                  ? '当前使用的 Key（已脱敏）'
                  : keySource === 'none'
                    ? '粘贴你的 Jev API Key'
                    : '覆盖已有 Key'}
              </label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {keyLocked ? (
                  <Fragment>
                    <input
                      id="jev-api-key"
                      className="jev-input jev-mono"
                      value={keyMask}
                      readOnly
                      disabled
                      style={{ flex: '1 1 150px', opacity: 0.8 }}
                    />
                    <button
                      className="jev-btn"
                      disabled={busy !== '' || connectionDirty}
                      title="清空输入框，粘贴新 Key"
                      onClick={() => {
                        setKeyLocked(false)
                        setKeyMask('')
                      }}
                    >
                      更换
                    </button>
                  </Fragment>
                ) : (
                  <Fragment>
                    <input
                      className="jev-input"
                      id="jev-api-key"
                      autoComplete="off"
                      spellCheck={false}
                      type={showKey ? 'text' : 'password'}
                      placeholder={keySource === 'none' ? '至少 10 个字符' : '输入新值以覆盖'}
                      value={keyDraft}
                      disabled={connectionDirty || !!status?.connectionError || busy !== ''}
                      onChange={(event) => {
                        setKeyDraft(event.target.value)
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' || busy !== '' || pingBusy) return
                        void saveKey()
                      }}
                    />
                    <button
                      className="jev-btn"
                      disabled={keyDraft.length === 0 || connectionDirty}
                      onClick={() => {
                        setShowKey(!showKey)
                      }}
                    >
                      {showKey ? '隐藏' : '显示'}
                    </button>
                    <button
                      className="jev-btn jev-btn--primary"
                      disabled={busy !== '' || pingBusy || connectionDirty || !!status?.connectionError || keyDraft.trim().length < 10}
                      onClick={() => {
                        void saveKey()
                      }}
                    >
                      {busy === 'key' ? '…' : '保存'}
                    </button>
                  </Fragment>
                )}
                <button
                  className="jev-btn"
                  disabled={
                    busy !== '' ||
                    pingBusy ||
                    connectionDirty ||
                    !!status?.connectionError ||
                    (keyDraft.trim().length > 0 ? keyDraft.trim().length < 10 : keySource === 'none')
                  }
                  title="向 Provider 发一次最小真实请求，验证 Key 与端点（约 $0.00001）"
                  onClick={() => {
                    void runPing()
                  }}
                >
                  {pingBusy ? '测试中…' : '测试连接'}
                </button>
                {keySource === 'config' && (
                  <button
                    className="jev-btn jev-btn--quiet"
                    disabled={busy !== '' || pingBusy || connectionDirty || !!status?.connectionError}
                    title="清除已保存的 Key，改用当前凭据引用"
                    onClick={() => { void useCredentialReference() }}
                  >
                    改用凭据引用
                  </button>
                )}
              </div>
              {pingResult !== null && (
                <p className="jev-note" role="status" style={{ color: pingResult.error === 'rate-limited' ? TONE.warn : pingResult.ok ? TONE.ok : TONE.err }}>
                  {pingResult.error === 'rate-limited' ? '' : pingResult.ok ? '✓ ' : '✗ '}
                  {pingText(pingResult)}
                </p>
              )}
            </div>
            <p className="jev-note">测试连接会用当前输入的 Key。输入框为空时使用已配置的凭据。</p>
          </section>

          <section className="jev-card">
            <header className="jev-card-head">
              <div>
                <div className="jev-card-title">生效中的能力</div>
                <div className="jev-card-sub">当前各能力的启用状态</div>
              </div>
            </header>
            <div className="jev-chips">
              <Badge
                tone={status?.guardEnabled === true ? 'ok' : 'muted'}
              >{`守门人 ${status?.guardEnabled === true ? '开' : '关'}`}</Badge>
              <Badge
                tone={status?.preapproveEnabled === true ? 'ok' : 'muted'}
              >{`预批准 ${status?.preapproveEnabled === true ? '开' : '关'}`}</Badge>
              <Badge
                tone={status?.stagnationEnabled === true ? 'ok' : 'muted'}
              >{`停滞检测 ${status?.stagnationEnabled === true ? '开' : '关'}`}</Badge>
              <Badge
                tone={status?.enabled === true ? 'ok' : 'muted'}
              >{`总开关 ${status?.enabled === true ? '开' : '关'}`}</Badge>
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
                  onChange={(next) => {
                    void applyPatch('mode', { mode: next }, { mode: next as JevStatus['mode'] })
                  }}
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
              <p className="jev-note">
                名单为空，当前不会自动批准工具。可在阈值校准中查看基于观察数据的候选工具。
              </p>
            ) : (
              <div className="jev-chips">
                {(status?.preapproveAllowlist ?? []).map((tool) => (
                  <button
                    key={tool}
                    className="jev-chip"
                    data-on="1"
                    disabled={busy !== ''}
                    title="点击移出预批准名单（立即生效）"
                    onClick={() => {
                      void applyAllowlist(tool, false)
                    }}
                  >
                    {tool} ✕
                  </button>
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
              <label
                className="jev-note"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={(event) => {
                    setAutoRefresh(event.target.checked)
                  }}
                />
                {`每 ${String(REFRESH_MS / 1000)} 秒自动刷新`}
              </label>
              <button
                className="jev-btn"
                disabled={loading}
                onClick={() => {
                  void load(false)
                }}
              >
                {loading ? '刷新中…' : '立即刷新'}
              </button>
            </div>
            <p className="jev-note">页面不可见时自动暂停，不产生后台请求。</p>
          </section>
        </div>
      </div>
    )
  }

  return (
    <div className="jev-root">
      <header className="jev-head">
        <div className="jev-logo">
          <Icon name="bolt" size={23} />
        </div>
        <div className="jev-headtext">
          <div className="jev-title-row">
            <h2 className="jev-title">Jev 决策</h2>
            {status !== null && (
              <span className="jev-status" data-on={status.enabled ? '1' : '0'}>
                <i className="jev-dot" />
                {status.enabled ? '运行中' : '已停用'}
              </span>
            )}
          </div>
          <div className="jev-sub">工具风险判断与审批记录</div>
        </div>
        <div className="jev-head-actions">
          <button
            className="jev-btn"
            disabled={loading}
            title="重新读取状态与最近决策"
            onClick={() => {
              void load(false)
            }}
          >
            <Icon name="refresh" size={14} />
            {loading ? '刷新中…' : '刷新'}
          </button>
          {status !== null && (
            <button
              className="jev-btn jev-btn--quiet"
              disabled={busy !== ''}
              title={status.enabled ? '停用后恢复原生流程' : '启用 Jev 决策'}
              onClick={() => {
                void applyPatch('enabled', { enabled: !status.enabled }, { enabled: !status.enabled })
              }}
            >
              <Icon name="power" size={14} />
              {busy === 'enabled' ? '保存中…' : status.enabled ? '停用' : '启用'}
            </button>
          )}
        </div>
      </header>
      {status !== null && (
        <div className="jev-runbar">
          <span>
            <Icon name="activity" size={14} />
            <b>{PROVIDERS.find((item) => item.id === provider)?.label ?? provider}</b>
          </span>
          <span className="jev-run-model">{status.model}</span>
          <span
            title={
              (status.dailyCostLimitUsd ?? 0) > 0
                ? `今日限额 $${status.dailyCostLimitUsd!.toFixed(2)}`
                : '未设置每日限额'
            }
          >
            <small>今日成本</small>
            <b>{status.costTodayUsd === undefined ? '—' : fmtUsd(status.costTodayUsd)}</b>
          </span>
          <Segmented
            label="决策模式"
            value={mode}
            disabled={busy !== ''}
            options={[
              { value: 'shadow', label: '观察模式', title: MODE_HINT.shadow },
              { value: 'enforce', label: '执行模式', title: MODE_HINT.enforce },
            ]}
            onChange={(next) => {
              void applyPatch('mode', { mode: next }, { mode: next as JevStatus['mode'] })
            }}
          />
        </div>
      )}
      {status !== null && (
        <nav
          className="jev-tabs"
          role="tablist"
          aria-label="Jev 面板"
          onKeyDown={(event) => {
            const index = TABS.findIndex((item) => item.id === tab)
            const next =
              event.key === 'ArrowRight'
                ? (index + 1) % TABS.length
                : event.key === 'ArrowLeft'
                  ? (index + TABS.length - 1) % TABS.length
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? TABS.length - 1
                      : -1
            if (next < 0) return
            event.preventDefault()
            const target = TABS[next]!
            setTab(target.id)
            document.getElementById(`jev-tab-${target.id}`)?.focus()
          }}
        >
          {TABS.map((item) => (
            <button
              key={item.id}
              id={`jev-tab-${item.id}`}
              role="tab"
              type="button"
              className="jev-tab"
              data-on={tab === item.id ? '1' : '0'}
              aria-selected={tab === item.id}
              aria-controls="jev-tabpanel"
              tabIndex={tab === item.id ? 0 : -1}
              onClick={() => {
                setTab(item.id)
              }}
            >
              <Icon name={item.icon} size={15} />
              {item.label}
              {item.id === 'log' && log.length > 0 && (
                <span className="jev-tab-count">{fmtNum(log.length)}</span>
              )}
            </button>
          ))}
          <span className="jev-live" title={autoRefresh ? '每 20 秒自动刷新，后台暂停' : '自动刷新已暂停'}>
            <i className="jev-dot" style={{ color: autoRefresh ? TONE.ok : TONE.muted }} />
            {updatedAt > 0 ? `${clockOf(new Date(updatedAt).toISOString())} 更新` : '等待读取'}
          </span>
        </nav>
      )}
      {loadErr !== '' && status !== null && (
        <div className="jev-toast jev-feedback" role="alert" data-tone="err">
          {loadErr} 当前显示上次成功读取的数据。
        </div>
      )}
      {dataWarning !== '' && status !== null && (
        <div className="jev-toast jev-feedback" role="status" data-tone="warn">
          {dataWarning}暂不可用，可能显示上次数据。请刷新重试。
        </div>
      )}
      {toast !== null && (
        <div
          className="jev-toast jev-feedback"
          role={toast.tone === 'err' ? 'alert' : 'status'}
          data-tone={toast.tone}
        >
          {toast.text}
        </div>
      )}
      {status !== null &&
        status.enabled &&
        (status.dailyCostLimitUsd ?? 0) > 0 &&
        (status.costTodayUsd ?? 0) >= status.dailyCostLimitUsd! && (
          <div className="jev-toast jev-feedback" role="status" data-tone="warn">
            今日已达成本限额，新增判断将降级回原生流程。
          </div>
        )}
      {loading && status === null && (
        <div className="jev-tab-body">
          <div className="jev-empty" role="status">
            <Icon name="activity" size={28} />
            <b>正在读取决策数据</b>
            <div>连接本地服务，加载状态与最近记录。</div>
          </div>
        </div>
      )}
      {status !== null && (
        <div
          className="jev-tab-body"
          id="jev-tabpanel"
          role="tabpanel"
          aria-labelledby={`jev-tab-${tab}`}
          key={tab}
        >
          {tab === 'overview'
            ? renderOverview()
            : tab === 'log'
              ? renderLog()
              : tab === 'calibration'
                ? renderCalibration()
                : renderSettings()}
        </div>
      )}
      {status === null && !loading && (
        <div className="jev-tab-body">
          <div className="jev-empty">
            <Icon name="info" size={28} />
            <b>暂时无法连接决策服务</b>
            <div>{loadErr || '请确认本地宿主正在运行。'}</div>
            <button
              className="jev-btn"
              onClick={() => {
                void load(false)
              }}
            >
              重新连接
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
