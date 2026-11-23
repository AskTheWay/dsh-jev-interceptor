/**
 * Jev Interceptor 宿主侧 Web API：浏览器面板经 Connection 认证围栏读写配置和统计。
 *
 * 形态照 dsh-auto-memory：ctx.connection.fetch.register 注册路由（认证围栏内），
 * 非 web 组合没有 connection 服务时静默 no-op。
 */

import type { Context } from '@deepseek-ai/cordis'
import { THRESHOLD_KEYS, type CalibrationReport, type ShadowReadiness } from './calibrate.js'
import type { ImpactSummary } from './impact.js'
import type { PingResult } from './jev.js'
import type { KeySource } from './provider.js'
import { clampLogLimit, LOG_PANEL_N, type TelemetryEntry } from './telemetry.js'

const BASE = '/api/jev-interceptor'

export interface JevPanelStatus {
  enabled: boolean
  mode: 'shadow' | 'enforce'
  provider: string
  model: string
  activeModel: string | null
  endpointOrigin: string | null
  connectionError?: string
  keyReference: string
  keyError?: string
  keyConfigured: boolean
  keySource: KeySource
  /** 设置服务落盘路径；null = 不落盘（保存只在本运行生效）。 */
  persistPath: string | null
  /** 当日已花（USD，进程内记账）；限额见 dailyCostLimitUsd。 */
  costTodayUsd: number
  /** 每日成本限额（USD）；0 = 不限。 */
  dailyCostLimitUsd: number
  preapproveAllowlist: string[]
  guardEnabled: boolean
  preapproveEnabled: boolean
  stagnationEnabled: boolean
}

export type ConfigUpdateResult = { persisted: boolean } | { error: string }

export interface JevPanelTagSummary {
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

export function registerJevApi(
  ctx: Context,
  deps: {
    getStatus: () => Promise<JevPanelStatus>
    getStats: () => Promise<JevPanelTagSummary[]>
    /** 查询指定模型的校准报告；当前模型会保留报告快照。 */
    getCalibration: (model?: string) => Promise<CalibrationReport>
    /** 效果归因（净收益/成本/延迟汇总，纯读）。 */
    getImpact: () => Promise<ImpactSummary>
    /**
     * 连接测试（发一次最小真实请求；约一次最小决策的成本）。
     * @param apiKeyOverride - 面板传来的未保存草稿 key；缺省测已配置的 key。
     */
    testConnection: (apiKeyOverride?: string, signal?: AbortSignal) => Promise<PingResult>
    /** 决策明细（/log 路由用；detail 只含枚举与数值 token，无敏感数据）。 */
    getLog: (limit: number) => Promise<TelemetryEntry[]>
    /** 影子→执行的就绪度评估（面板 hero 的升级提示灯）。 */
    getReadiness: () => Promise<ShadowReadiness>
    updateConfig: (patch: Record<string, unknown>) => Promise<ConfigUpdateResult>
  },
): void {
  const connection = ctx.get('connection')
  if (connection === undefined) return

  const json = (data: unknown, status = 200): Promise<Response> =>
    Promise.resolve(new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    }))

  connection.fetch.register({
    path: `${BASE}/status`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json(await deps.getStatus()),
  })

  connection.fetch.register({
    path: `${BASE}/stats`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json(await deps.getStats()),
  })

  connection.fetch.register({
    path: `${BASE}/calibration`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request: Request) => json(await deps.getCalibration(new URL(request.url).searchParams.get('model') ?? undefined)),
  })

  connection.fetch.register({
    path: `${BASE}/impact`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json(await deps.getImpact()),
  })

  connection.fetch.register({
    path: `${BASE}/test`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request: Request) => {
      // 可选 body {apiKey}：测未保存的草稿 key（不落盘）；无 body 测已配置的。
      let override: string | undefined
      try {
        const body = JSON.parse(await request.text()) as { apiKey?: unknown }
        if (typeof body.apiKey === 'string' && body.apiKey.length >= 10) override = body.apiKey
      } catch {
        // 无 body 或非 JSON：测已配置的 key。
      }
      return json(await deps.testConnection(override, request.signal))
    },
  })

  connection.fetch.register({
    path: `${BASE}/log`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request: Request) => json(
      await deps.getLog(clampLogLimit(new URL(request.url).searchParams.get('limit'), LOG_PANEL_N)),
    ),
  })

  connection.fetch.register({
    path: `${BASE}/readiness`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json(await deps.getReadiness()),
  })

  connection.fetch.register({
    path: `${BASE}/config`,
    methods: ['PUT'],
    requestBody: 'buffered',
    fetch: async (request: Request) => {
      let body: unknown
      try { body = JSON.parse(await request.text()) } catch {
        return json({ error: '请求必须为 JSON 对象。' }, 400)
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return json({ error: '请求必须为 JSON 对象。' }, 400)
      }
      const allowed = ['enabled', 'mode', 'apiKey', 'apiKeyEnv', 'provider', 'endpoint', 'model', 'preapproveToolAllowlist', 'calibrationModel', 'calibrationCurrent', ...THRESHOLD_KEYS]
      const patch = Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key)))
      if (Object.keys(patch).length === 0) return json({ error: '没有可更新的字段。' }, 400)
      const result = await deps.updateConfig(patch)
      return 'error' in result ? json(result, 400) : json({ ok: true, ...result })
    },
  })

  ctx.logger.info('dsh-jev-interceptor: panel API registered — /api/jev-interceptor/*')
}
