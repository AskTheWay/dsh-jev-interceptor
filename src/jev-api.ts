/**
 * Jev Interceptor 宿主侧 Web API：浏览器面板经 Connection 认证围栏读写配置和统计。
 *
 * 形态照 dsh-auto-memory：ctx.connection.fetch.register 注册路由（认证围栏内），
 * 非 web 组合没有 connection 服务时静默 no-op。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CalibrationReport } from './calibrate.js'
import { clampLogLimit, LOG_PANEL_N, type TelemetryEntry } from './telemetry.js'

const BASE = '/api/jev-interceptor'

export interface JevPanelStatus {
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
    getStatus: () => JevPanelStatus
    getStats: () => Promise<JevPanelTagSummary[]>
    /** 校准报告（面板只读展示；纯读，无状态写入）。 */
    getCalibration: () => Promise<CalibrationReport>
    /** 决策明细（/log 路由用；detail 只含枚举与数值 token，无敏感数据）。 */
    getLog: (limit: number) => Promise<TelemetryEntry[]>
    updateConfig: (patch: Record<string, unknown>) => Promise<void>
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
    fetch: async () => json(deps.getStatus()),
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
    fetch: async () => json(await deps.getCalibration()),
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
    path: `${BASE}/config`,
    methods: ['PUT'],
    requestBody: 'buffered',
    fetch: async (request: Request) => {
      try {
        const body = JSON.parse(await request.text()) as Record<string, unknown>
        // Whitelist: only these fields are updatable from the panel.
        const allowed = ['enabled', 'mode', 'apiKey', 'provider', 'endpoint']
        const patch: Record<string, unknown> = {}
        for (const key of allowed) {
          if (Object.hasOwn(body, key)) patch[key] = body[key]
        }
        if (Object.keys(patch).length === 0) {
          return json({ error: 'no updatable fields' }, 400)
        }
        await deps.updateConfig(patch)
        return json({ ok: true })
      } catch (error: unknown) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 500)
      }
    },
  })

  ctx.logger.info('dsh-jev-interceptor: panel API registered — /api/jev-interceptor/*')
}
