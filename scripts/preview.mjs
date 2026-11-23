/** Isolated UI workbench: fixture data only, no upstream requests or credentials. */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const routerModel = 'typesafe/jev-1.14-20261014'
const typesafeModel = 'jev-1.14.0'
const olderModel = 'jev-1.13.0'
const startStatus = () => ({
  enabled: true,
  mode: 'enforce',
  provider: 'openrouter',
  model: routerModel,
  activeModel: routerModel,
  endpointOrigin: 'https://openrouter.ai',
  keyReference: 'OPENROUTER_API_KEY',
  keyConfigured: true,
  keySource: 'config',
  persistPath: 'preview-only',
  costTodayUsd: 0.00182,
  dailyCostLimitUsd: 0.1,
  preapproveAllowlist: ['edit', 'write'],
  guardEnabled: true,
  preapproveEnabled: true,
  stagnationEnabled: false,
})
let status = startStatus()
let scenario = 'populated'
let guardConfidence = 0.8
const now = Date.now()
const tools = ['pwsh', 'edit', 'write', 'web_fetch', 'memory_write', 'read']
const records = Array.from({ length: 240 }, (_, i) => {
  const action =
    i % 31 === 5
      ? 'retention-scored'
      : i % 23 === 0
        ? 'deny'
        : i % 11 === 0
          ? 'ask'
          : i % 9 === 0
            ? 'degraded'
            : i % 7 === 0
              ? 'auto-approve'
              : 'delegate'
  const scores =
    action === 'auto-approve'
      ? { scope: 0.98, reversible: 0.99, inj: 0.03 }
      : {
          risk_p: 0.9842,
          irrev: action === 'deny' ? 0.93 : 0.08,
          task: 0.86,
          inj: action === 'ask' ? 0.74 : 0.03,
          user: 0.89,
          untrusted: 0.02,
        }
  const day = Math.floor(i / 19)
  return {
    ts: new Date(now - day * 86400000 - (i % 19) * 97000).toISOString(),
    tag:
      action === 'auto-approve'
        ? 'preapprove'
        : action === 'retention-scored'
          ? 'session-reference'
          : 'guard',
    mode: i % 3 === 0 ? 'shadow' : 'enforce',
    tool: tools[i % tools.length],
    action,
    detail:
      action === 'degraded'
        ? 'timeout'
        : action === 'retention-scored'
          ? 'messages=12 scored=10 kept=8'
          : action === 'auto-approve'
            ? 'scope=0.98 reversible=0.99 inj=0.03'
            : `risk=${action === 'deny' ? 'high' : 'low'} p=0.98 irrev=${scores.irrev} task=0.86 inj=${scores.inj}`,
    scores: action === 'degraded' || action === 'retention-scored' ? undefined : scores,
    latencyMs: i % 10 === 0 ? 0 : 180 + (i % 21) * 13,
    cached: i % 10 === 0,
    model: action === 'degraded' ? undefined : i % 4 === 0 ? olderModel : routerModel,
    sessionId: `preview-session-${Math.floor(i / 40)}`,
    callId: `preview-call-${String(i).padStart(3, '0')}`,
    inputTokens: 501,
    costUsd: action === 'degraded' || i % 10 === 0 ? 0 : 0.000021,
  }
})
const stats = () => {
  const tags = new Map()
  for (const record of records.slice(0, 200)) {
    const summary = tags.get(record.tag) ?? {
      tag: record.tag,
      calls: 0,
      degraded: 0,
      cached: 0,
      actions: {},
      latencyP50: 281,
      latencyP95: 440,
      costUsd: 0,
    }
    summary.calls++
    summary.actions[record.action] = (summary.actions[record.action] ?? 0) + 1
    summary.degraded += Number(record.action === 'degraded')
    summary.cached += Number(record.cached)
    summary.costUsd += record.costUsd
    tags.set(record.tag, summary)
  }
  return [...tags.values()]
}
const count = (action) =>
  records.filter((record) => record.mode === 'enforce' && record.action === action).length
const impact = () => ({
  windowSize: records.length,
  firstTs: records.at(-1).ts,
  lastTs: records[0].ts,
  days: 13,
  sessions: 6,
  modeSplit: { shadow: 80, enforce: 160 },
  enforce: {
    denied: count('deny'),
    asked: count('ask'),
    autoApproved: count('auto-approve'),
    stagnationAlerts: 0,
  },
  agreement: { enforce: {}, shadow: {} },
  cost: {
    costUsd: records.reduce((sum, record) => sum + record.costUsd, 0),
    cachedDecisions: records.filter((record) => record.cached).length,
    inputTokens: records.length * 501,
  },
  latency: { p50: 281, p95: 440 },
  degraded: {
    total: records.filter((record) => record.action === 'degraded').length,
    byReason: { timeout: 24 },
  },
})

function calibration(model = status.activeModel) {
  const window = scenario === 'empty' ? [] : records.filter(record =>
    record.tag === 'guard' || record.tag === 'preapprove' || record.tag === 'approval-loop')
  const samples = window.filter(record => record.model === model)
  const guardSamples = samples.filter(record => record.tag === 'guard').length
  const shadowSamples = samples.filter(record => record.mode === 'shadow').length
  const current = model === status.activeModel
  const adopted = current && guardConfidence !== 0.8
  const advice = guardSamples === 0 || guardConfidence >= 0.85 ? [] : [{
    param: 'guardConfidenceMin',
    current: guardConfidence,
    suggested: 0.85,
    basis: '观察期中风险升级偏多，人工审批大部分选择继续。',
    samples: guardSamples,
    note: '提高升级置信门槛，减少低置信判断带来的人工确认。',
  }]
  return {
    scope: {
      model,
      currentModel: status.activeModel,
      scanned: window.length,
      models: [routerModel, olderModel]
        .map(id => ({ model: id, samples: window.filter(record => record.model === id).length }))
        .filter(entry => entry.samples > 0),
    },
    windowSize: samples.length,
    counts: { guard: guardSamples, preapprove: samples.length - guardSamples, approvalLoop: 0 },
    modeSplit: { shadow: shadowSamples, enforce: samples.length - shadowSamples },
    advice,
    insufficient: [],
    observations: [{ param: 'guardInjectionAskThreshold', reason: '注入防线维持当前阈值，继续观察新样本。' }],
    history: adopted ? { previousTs: new Date(now - 86400000).toISOString(), adopted: 1, ignored: 0 } : undefined,
    allowlistSuggestions: current && guardSamples > 0 ? [
      { tool: 'read', samples: 40, avgConfidence: 0.97, avgIrreversibility: 0.02, maxInjection: 0.04 },
    ] : [],
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  const send = (data, code = 200) => {
    response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify(data))
  }
  const body = async () => {
    let text = ''
    for await (const chunk of request) text += chunk
    return JSON.parse(text || '{}')
  }
  try {
    if (url.pathname === '/__preview/scenario' && request.method === 'POST') {
      scenario = (await body()).scenario
      status = startStatus()
      guardConfidence = 0.8
      if (scenario === 'empty')
        status = {
          ...status,
          enabled: false,
          keyConfigured: false,
          keySource: 'none',
          preapproveAllowlist: [],
        }
      if (scenario === 'shadow') status.mode = 'shadow'
      return send({ ok: true })
    }
    if (url.pathname.startsWith('/api/jev-interceptor/')) {
      const route = url.pathname.split('/').at(-1)
      if (scenario === 'offline') return send({ error: 'preview offline' }, 503)
      if (scenario === 'partial' && route === 'impact') return send({ error: 'preview partial failure' }, 503)
      if (route === 'status') return send(status)
      if (route === 'stats') return send(scenario === 'empty' ? [] : stats())
      if (route === 'log') return send(scenario === 'empty' ? [] : records)
      if (route === 'impact')
        return send(
          scenario === 'empty'
            ? {
                ...impact(),
                windowSize: 0,
                enforce: { denied: 0, asked: 0, autoApproved: 0, stagnationAlerts: 0 },
              }
            : impact(),
        )
      if (route === 'readiness')
        return send({
          shadowSamples: scenario === 'empty' ? 0 : 80,
          misApprovals: 0,
          degradedRate: 0.08,
          ready: scenario !== 'empty',
          reason: scenario === 'empty' ? '等待观察样本' : '观察样本充足，可检查校准结果后评估切换',
        })
      if (route === 'calibration') return send(calibration(url.searchParams.get('model') ?? undefined))
      if (route === 'test') {
        const { apiKey } = await body()
        if (!apiKey && !status.keyConfigured) return send({ ok: false, latencyMs: 0, error: 'no-key' })
        if (!apiKey) status.activeModel = status.model
        return send({ ok: true, latencyMs: 218, model: status.model })
      }
      if (route === 'config' && request.method === 'PUT') {
        if (scenario === 'save-error') return send({ error: '预览：模拟保存失败' }, 500)
        const patch = await body()
        const { provider, apiKey, endpoint, model, apiKeyEnv, preapproveToolAllowlist,
          calibrationModel, calibrationCurrent, guardConfidenceMin, ...settings } = patch
        if (calibrationModel !== undefined && calibrationModel !== status.activeModel) {
          return send({ error: '当前模型已变更，请重新生成校准报告。' }, 400)
        }
        if (calibrationCurrent !== undefined && calibrationCurrent !== guardConfidence) {
          return send({ error: '当前阈值已变更，请重新生成校准报告。' }, 400)
        }
        const preset = provider === 'typesafe'
          ? { endpointOrigin: 'https://api.typesafe.ai', model: typesafeModel, activeModel: typesafeModel, keyReference: 'TYPESAFE_API_KEY' }
          : provider === 'openrouter'
            ? { endpointOrigin: 'https://openrouter.ai', model: routerModel, activeModel: routerModel, keyReference: 'OPENROUTER_API_KEY' }
            : {}
        let endpointOrigin
        if (endpoint) {
          try { endpointOrigin = new URL(endpoint).origin } catch { return send({ error: '端点必须是完整的 HTTP 或 HTTPS 地址。' }, 400) }
        }
        status = {
          ...status,
          ...settings,
          ...preset,
          ...(provider ? { provider } : {}),
          ...(endpointOrigin ? { endpointOrigin } : {}),
          ...(model ? { model, activeModel: null } : {}),
          ...(apiKeyEnv ? { keyReference: apiKeyEnv } : {}),
          ...(typeof apiKey === 'string' ? { keyConfigured: apiKey.length > 0, keySource: apiKey ? 'config' : 'none' } : {}),
          ...(preapproveToolAllowlist ? { preapproveAllowlist: preapproveToolAllowlist } : {}),
        }
        if (guardConfidenceMin !== undefined) guardConfidence = guardConfidenceMin
        return send({ ok: true, persisted: true })
      }
      return send({ error: 'not found' }, 404)
    }
    if (url.pathname === '/app.js') {
      const result = await build({
        entryPoints: [fileURLToPath(new URL('./preview/main.tsx', import.meta.url))],
        absWorkingDir: root,
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'browser',
        jsx: 'automatic',
        define: { 'process.env.NODE_ENV': '"development"' },
      })
      response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
      return response.end(result.outputFiles[0].contents)
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return response.end(await readFile(new URL('./preview/index.html', import.meta.url)))
    }
    response.writeHead(404)
    response.end('Not found')
  } catch (error) {
    console.error(error)
    if (!response.headersSent) send({ error: 'Preview error' }, 500)
  }
})
server.listen(4173, '127.0.0.1', () => {
  console.log('Jev UI preview (fixture data only): http://127.0.0.1:4173')
})
