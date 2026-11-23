import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Loader, type Entry } from '@deepseek-ai/cordis-plugin-loader'
import { SettingsForms } from '@deepseek-ai/dsh-settings'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { apply, Config, type ConfigType } from '../src/index.js'
import type { CalibrationReport, ShadowReadiness } from '../src/calibrate.js'
import type { JevPanelStatus } from '../src/jev-api.js'
import type { TelemetryEntry } from '../src/telemetry.js'

type Route = { path: string; methods: string[]; fetch: (request: Request) => Promise<Response> }
type Command = { name: string; handler: (invocation: { rawInput: string }) => Promise<{ text: string }> }
type RawConfig = Record<string, unknown>

const contexts: Context[] = []

async function start(config: ConfigType = {}, persist = true) {
  const routes: Route[] = []
  const commands = new Map<string, Command>()
  const drafts: Array<{ origin: string; model: string; authorization: string | null; ping: boolean }> = []
  const keys: Record<string, { value: string; source: string }> = {
    OPENROUTER_API_KEY: { value: 'fixture-router-key', source: 'user-env' },
    MY_DECISION_KEY: { value: 'fixture-custom-key', source: 'file' },
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = JSON.parse(String(init?.body)) as { model: string; questions: Record<string, { type: string }> }
    const ping = Object.hasOwn(request.questions, 'ping')
    drafts.push({ origin: String(input), model: request.model, authorization: new Headers(init?.headers).get('authorization'), ping })
    const answers = Object.fromEntries(Object.entries(request.questions).map(([key, question]) => [
      key, question.type === 'choice'
        ? { type: 'choice', choice: 'low', probabilities: { low: 1 }, confidence: 1 }
        : { type: 'noul', noul: ping ? 1 : 0.01 },
    ]))
    return Response.json({ model: request.model, answers, usage: { input_tokens: 100 } })
  })
  const telemetryDir = await mkdtemp(join(tmpdir(), 'jev-provider-flow-'))
  const documentPath = join(telemetryDir, 'cordis.patch.yml')
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('connection', { fetch: { register: (route: Route) => routes.push(route) } })
  ctx.provide('commands', { register: (command: Command) => commands.set(command.name, command) })
  ctx.provide('credentials', { resolve: async (name: string) => keys[name] })
  ctx.provide('profileContext', { home: telemetryDir })
  await ctx.plugin(Loader)
  const loader = ctx.loader
  const id = 'jev-interceptor'
  const entries = () => [...loader.entries()]
  // Exercise DSH's real settings validation and Loader's live update against
  // an isolated profile document, without touching the user's DSH profile.
  ctx.provide('configEditor', {
    documentPath,
    entries,
    configuration: () => entries().map(entry => ({ entry, inherited: {}, override: entry.options.config })),
    edit: async (entry: Entry, change: (raw: RawConfig, inherited: RawConfig) => RawConfig) => {
      if (!persist) throw new Error('fixture persistence failure')
      const next = change(entry.options.config as RawConfig, {})
      await writeFile(documentPath, JSON.stringify(next), 'utf8')
      await entry.update({ config: next })
    },
  })
  await ctx.plugin(SettingsForms)
  let mounts = 0
  loader.builtins[id] = {
    Config,
    apply: (pluginCtx: Context, parsed: ReturnType<typeof Config>) => {
      mounts++
      apply(pluginCtx, parsed)
    },
  }
  await loader.root.update([{ id, name: `cordis:${id}`, config: { telemetryDir, ...config } }])
  await loader.await()
  const fetchRoute = async (path: string, method = 'GET', body?: object): Promise<Response> => {
    const url = new URL(`/api/jev-interceptor/${path}`, 'http://localhost')
    const route = routes.find(route => route.path === url.pathname && route.methods.includes(method))!
    return route.fetch(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
  }
  const status = async (): Promise<JevPanelStatus> => (await fetchRoute('status')).json() as Promise<JevPanelStatus>
  const guard = async () => {
    return ctx.waterfall('tools/pre-execute', {
      callId: 'test-call',
      name: 'bash',
      arguments: { command: 'npm test' },
      signal: new AbortController().signal,
      agent: { session: { id: 's1', header: { cwd: '/project' }, deriveMessages: () => [] } },
    } as unknown as ToolExecution, async () => ({ kind: 'allow' }))
  }
  const savedConfig = async (): Promise<RawConfig> => JSON.parse(await readFile(documentPath, 'utf8')) as RawConfig
  const setViaHost = (patch: RawConfig) => ctx.settings.update(id, patch)
  return { status, fetchRoute, guard, commands, savedConfig, setViaHost, drafts, telemetryDir, mounts: () => mounts }
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

describe('provider settings across the host, API and decision hook', () => {
  it('uses the new pinned endpoint and new credential in both the next test and the next decision', async () => {
    const host = await start({ apiKey: 'fixture-typesafe-key', enabled: true })
    expect(await host.status()).toMatchObject({ provider: 'typesafe', keySource: 'config' })
    await host.guard()
    const invalid = await host.fetchRoute('config', 'PUT', { provider: 'openrouter' })
    expect(invalid.status).toBe(400)
    expect((await host.status()).provider).toBe('typesafe')

    const saved = await host.fetchRoute('config', 'PUT', { provider: 'openrouter', apiKey: '' })
    expect(await saved.json()).toEqual({ ok: true, persisted: true })
    expect(await host.savedConfig()).toMatchObject({ provider: 'openrouter', apiKey: '' })
    const status = await host.status()
    expect(status).toMatchObject({ provider: 'openrouter', endpointOrigin: 'https://openrouter.ai', keySource: 'env', keyReference: 'OPENROUTER_API_KEY' })
    expect(JSON.stringify(status)).not.toContain('fixture-router-key')
    const ping = await host.fetchRoute('test', 'POST', {})
    expect(await ping.json()).toMatchObject({ ok: true, model: 'typesafe/jev-1.14-20261014' })
    await host.guard()
    expect(host.drafts).toEqual([
      { origin: 'https://api.typesafe.ai/v1/systemone', model: 'jev-1.14.0', authorization: 'Bearer fixture-typesafe-key', ping: false },
      { origin: 'https://openrouter.ai/api/v1/systemone', model: 'typesafe/jev-1.14-20261014', authorization: 'Bearer fixture-router-key', ping: true },
      { origin: 'https://openrouter.ai/api/v1/systemone', model: 'typesafe/jev-1.14-20261014', authorization: 'Bearer fixture-router-key', ping: false },
    ])
    expect((await host.commands.get('jev-status')!.handler({ rawInput: '' })).text).toContain('OPENROUTER_API_KEY')
    await host.setViaHost({ provider: 'typesafe', enabled: false })
    expect(await host.status()).toMatchObject({ provider: 'typesafe', enabled: false, activeModel: 'jev-1.14.0' })
    expect(host.mounts()).toBe(1)
  })

  it('repairs an incomplete custom config, rejects invalid edits atomically, and reports persistence failures', async () => {
    const host = await start({ provider: 'custom' }, false)
    expect(await host.status()).toMatchObject({ keySource: 'none', keyConfigured: false, endpointOrigin: null })
    expect(await (await host.fetchRoute('test', 'POST', {})).json()).toMatchObject({ error: 'invalid-connection' })
    expect(host.drafts).toHaveLength(0)
    const invalid = await host.fetchRoute('config', 'PUT', { mode: 'enforce', endpoint: 'not-a-url', model: 'custom-1' })
    expect(invalid.status).toBe(400)
    expect((await host.status()).mode).toBe('shadow')

    const saved = await host.fetchRoute('config', 'PUT', {
      provider: 'custom',
      endpoint: 'https://decision.example.test/v1/systemone',
      model: 'custom-1',
      apiKeyEnv: 'MY_DECISION_KEY',
    })
    expect(await saved.json()).toEqual({ ok: true, persisted: false })
    expect(await host.status()).toMatchObject({ keySource: 'credentials', model: 'custom-1', endpointOrigin: 'https://decision.example.test' })
    await expect(host.savedConfig()).rejects.toMatchObject({ code: 'ENOENT' })
    const key = await host.commands.get('jev-key')!.handler({ rawInput: 'fixture-replacement-key' })
    expect(key.text).toContain('仅在本次运行生效')
    expect((await host.status()).keySource).toBe('config')
  })

  it('replays only the selected response model and rejects stale calibration applies', async () => {
    const host = await start({ enabled: true })
    const current = 'jev-1.14.0'
    const older = 'jev-1.13.0'
    const sample = (model?: string): TelemetryEntry => ({
      ts: '2026-11-23T01:00:00Z', tag: 'guard', mode: 'shadow', tool: 'bash', action: 'ask',
      model, detail: 'risk=medium p=0.80 irrev=0.10 task=0.90 inj=0.02',
      scores: { risk_p: 0.8, irrev: 0.1, task: 0.9, inj: 0.02, user: 0.05, untrusted: 0 },
    })
    const entries = [
      ...Array.from({ length: 30 }, () => sample(older)),
      sample(current),
      sample(current),
      sample(),
      sample('jev-latest'),
    ]
    const writeSamples = () => writeFile(join(host.telemetryDir, 'telemetry.jsonl'), entries.map(entry => JSON.stringify(entry)).join('\n') + '\n')
    const report = async (model?: string): Promise<CalibrationReport> => {
      const response = await host.fetchRoute(model === undefined ? 'calibration' : `calibration?model=${encodeURIComponent(model)}`)
      return response.json() as Promise<CalibrationReport>
    }
    await writeSamples()
    expect(await report()).toMatchObject({
      scope: { model: current, currentModel: current, scanned: 34, models: [{ model: older, samples: 30 }, { model: current, samples: 2 }] },
      windowSize: 2, advice: [],
    })
    const historical = await report(older)
    expect(historical).toMatchObject({ scope: { model: older, currentModel: current }, windowSize: 30 })
    const oldAdvice = historical.advice.find(item => item.param === 'guardConfidenceMin')!
    expect(oldAdvice.samples).toBe(30)
    expect((await host.commands.get('jev-calibrate')!.handler({ rawInput: `--model ${older}` })).text).toContain(`模型 ${older} · 纳入 30/34`)
    expect((await (await host.fetchRoute('readiness')).json()) as ShadowReadiness).toMatchObject({ shadowSamples: 2, ready: false })
    expect((await host.fetchRoute('config', 'PUT', {
      [oldAdvice.param]: oldAdvice.suggested, calibrationModel: older, calibrationCurrent: oldAdvice.current,
    })).status).toBe(400)

    entries.push(...Array.from({ length: 28 }, () => sample(current)))
    await writeSamples()
    const advice = (await report()).advice.find(item => item.param === 'guardConfidenceMin')!
    const patch = { [advice.param]: advice.suggested, calibrationModel: current, calibrationCurrent: advice.current }
    expect(advice.samples).toBe(30)
    expect(await (await host.fetchRoute('config', 'PUT', patch)).json()).toEqual({ ok: true, persisted: true })
    const config = await host.savedConfig()
    expect(config).toMatchObject({ guardConfidenceMin: advice.suggested })
    expect(config).not.toHaveProperty('calibrationModel')
    expect((await host.fetchRoute('config', 'PUT', patch)).status).toBe(400)
    expect((await report()).history).toMatchObject({ adopted: 1 })
  })
})
