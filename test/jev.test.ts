import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { JevClient, type ClassifyCall } from '../src/jev.js'
import { Telemetry } from '../src/telemetry.js'

function okBody(): Response {
  return new Response(JSON.stringify({
    model: 'jev-1.13.0',
    answers: { is_urgent: { type: 'noul', noul: 0.95 } },
    usage: { input_tokens: 300, output_tokens: 20 },
  }), { status: 200 })
}

async function makeClient(fetchFn: typeof fetch): Promise<{ client: JevClient; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jev-test-'))
  const telemetry = new Telemetry(dir)
  const client = new JevClient({
    endpoint: 'https://example.test/decisions',
    model: 'jev-latest',
    timeoutMs: 1500,
    cooldownMs: 60_000,
    failureThreshold: 2,
    maxConcurrency: 4,
    cacheSize: 512,
    resolveKey: async () => 'test-key',
    telemetry,
    logger: { warn: () => {} },
    fetchFn,
  })
  return { client, dir }
}

const call: ClassifyCall = { tag: 'guard', mode: 'enforce', tool: 'bash', state: { a: 1 }, questions: { is_urgent: { type: 'noul', instructions: 'urgent?' } } }

describe('JevClient', () => {
  it('returns parsed answers with usage and estimated cost', async () => {
    const { client } = await makeClient(async () => okBody())
    const result = await client.classify(call)
    expect(result?.answers['is_urgent']).toEqual({ type: 'noul', noul: 0.95 })
    expect(result?.model).toBe('jev-1.13.0')
    expect(result?.inputTokens).toBe(300)
    expect(result?.costUsd).toBeCloseTo(300 / 1_000_000 * 0.042, 10)
  })

  it('serves a repeat decision from cache without a second request', async () => {
    let fetches = 0
    const { client } = await makeClient(async () => {
      fetches += 1
      return okBody()
    })
    await client.classify(call)
    const second = await client.classify(call)
    expect(fetches).toBe(1)
    expect(second?.cached).toBe(true)
  })

  it('degrades to null without a key and without counting failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-jev-test-'))
    const client = new JevClient({
      endpoint: 'https://example.test/decisions',
      model: 'jev-latest',
      timeoutMs: 1500,
      cooldownMs: 60_000,
      failureThreshold: 1,
      maxConcurrency: 4,
      cacheSize: 512,
      resolveKey: async () => undefined,
      telemetry: new Telemetry(dir),
      logger: { warn: () => {} },
    })
    expect(await client.classify(call)).toBeNull()
  })

  it('retries a 429 once and succeeds', async () => {
    let status = 429
    const { client } = await makeClient(async () => {
      const response = status === 429 ? new Response('rate limited', { status }) : okBody()
      status = 200
      return response
    })
    const result = await client.classify(call)
    expect(result?.answers['is_urgent']?.type).toBe('noul')
  })

  it('opens the cooldown after the failure threshold and degrades instantly', async () => {
    let fetches = 0
    const { client } = await makeClient(async () => {
      fetches += 1
      return new Response('overloaded', { status: 529 })
    })
    expect(await client.classify(call)).toBeNull()
    expect(await client.classify(call)).toBeNull()
    // Each failed classify retried once internally: 2 calls x 2 fetches.
    expect(fetches).toBe(4)
    // Third call degrades from cooldown without touching the provider.
    expect(await client.classify(call)).toBeNull()
    expect(fetches).toBe(4)
  })

  it('degrades on a malformed body', async () => {
    const { client } = await makeClient(async () => new Response('{"answers": 42}', { status: 200 }))
    expect(await client.classify(call)).toBeNull()
  })

  it('records degraded entries in telemetry', async () => {
    const { client, dir } = await makeClient(async () => new Response('nope', { status: 500 }))
    await client.classify(call)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const raw = await readFile(join(dir, 'telemetry.jsonl'), 'utf8')
    const entries = raw.trim().split('\n').map((line) => JSON.parse(line) as { action: string; detail?: string })
    expect(entries.at(-1)?.action).toBe('degraded')
    expect(entries.at(-1)?.detail).toBe('http-error')
  })
})
