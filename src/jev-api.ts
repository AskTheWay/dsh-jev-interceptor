/** Host Web API for authenticated configuration and telemetry access. Register routes through the connection service; skip non-web compositions without that service. */

import type { Locale } from './localization.js'
import { translate } from './localization.js'
import type { Context } from '@deepseek-ai/cordis'
import { THRESHOLD_KEYS, type CalibrationReport, type ShadowReadiness } from './calibrate.js'
import type { ImpactSummary } from './impact.js'
import type { PingResult } from './jev.js'
import { clampLogLimit, LOG_PANEL_N, type TelemetryEntry } from './telemetry.js'

const BASE = '/api/jev-interceptor'

export interface JevPanelStatus {
  enabled: boolean
  mode: 'shadow' | 'enforce'
  provider: string
  model: string
  keyConfigured: boolean
  keySource: 'config' | 'credentials' | 'env' | 'none'
  /** Settings persistence path; null means changes last only for this run. */
  persistPath: string | null
  /** Today's process-local USD spending; capped by dailyCostLimitUsd. */
  costTodayUsd: number
  /** Daily spending limit in USD; zero means unlimited. */
  dailyCostLimitUsd: number
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
    /** Calibration report for panel display. */
    getCalibration: (locale?: Locale) => Promise<CalibrationReport>
    /** Read-only impact summary: benefit, cost, and latency. */
    getImpact: () => Promise<ImpactSummary>
    /** Test the connection with one minimal real decision request. @param apiKeyOverride - Unsaved draft key; omit to test the configured key. */
    testConnection: (apiKeyOverride?: string) => Promise<PingResult>
    /** Decision log; detail contains enum and numeric tokens without sensitive data. */
    getLog: (limit: number) => Promise<TelemetryEntry[]>
    /** Shadow-to-enforce readiness (the panel hero's promote hint). */
    getReadiness: (locale?: Locale) => Promise<ShadowReadiness>
    /** Language of host-generated error copy, resolved per request. */
    locale: () => Locale
    updateConfig: (patch: Record<string, unknown>) => Promise<{ rejected: string[] }>
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
    fetch: async (request: Request) => json(await deps.getCalibration(
      new URL(request.url).searchParams.get('locale') === 'en' ? 'en' : 'zh',
    )),
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
      // Optional {apiKey} body tests a draft without saving it; otherwise use the configured key.
      let override: string | undefined
      try {
        const body = JSON.parse(await request.text()) as { apiKey?: unknown }
        if (typeof body.apiKey === 'string' && body.apiKey.length >= 10) override = body.apiKey
      } catch {
        // Missing or non-JSON bodies use the configured key.
      }
      return json(await deps.testConnection(override))
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
    fetch: async (request: Request) => json(await deps.getReadiness(
      new URL(request.url).searchParams.get('locale') === 'en' ? 'en' : 'zh',
    )),
  })

  connection.fetch.register({
    path: `${BASE}/config`,
    methods: ['PUT'],
    requestBody: 'buffered',
    fetch: async (request: Request) => {
      try {
        const body = JSON.parse(await request.text()) as Record<string, unknown>
        // Whitelist: toggles/credentials plus the eight calibratable thresholds
        // (calibration's one-click apply); threshold values re-validated host-side
        // and rejected honestly (400) when out of range.
        const allowed = ['enabled', 'mode', 'apiKey', 'provider', 'endpoint', 'preapproveToolAllowlist', ...THRESHOLD_KEYS]
        const patch: Record<string, unknown> = {}
        for (const key of allowed) {
          if (Object.hasOwn(body, key)) patch[key] = body[key]
        }
        if (Object.keys(patch).length === 0) {
          return json({ error: translate(deps.locale(), 'msg.noUpdatableFields') }, 400)
        }
        const { rejected } = await deps.updateConfig(patch)
        if (rejected.length > 0) {
          return json({
            error: translate(deps.locale(), 'msg.invalidThreshold', { v0: rejected.join(', ') }),
            code: 'invalid-threshold',
            fields: rejected,
          }, 400)
        }
        return json({ ok: true })
      } catch (error: unknown) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 500)
      }
    },
  })

  ctx.logger.info('dsh-jev-interceptor: panel API registered — /api/jev-interceptor/*')
}
