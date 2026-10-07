import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Telemetry, type TelemetryEntry } from '../src/telemetry.js'

async function withLog(entries: readonly TelemetryEntry[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jev-tel-'))
  const telemetry = new Telemetry(dir)
  for (const entry of entries) telemetry.record(entry)
  // Fire-and-forget writes need one macrotask to land.
  await new Promise((resolve) => setTimeout(resolve, 50))
  const text = await telemetry.stats()
  await rm(dir, { recursive: true, force: true })
  return text
}

const base = {
  ts: '2026-10-08T00:00:00.000Z',
  tag: 'guard' as const,
  mode: 'shadow' as const,
}

describe('Telemetry.stats', () => {
  it('excludes cache hits from latency percentiles', async () => {
    const text = await withLog([
      { ...base, action: 'delegate' as const, latencyMs: 400 },
      { ...base, action: 'delegate' as const, latencyMs: 500 },
      { ...base, action: 'delegate' as const, latencyMs: 600 },
      // Ten cache hits at latency 0 would drag p50 to zero if counted.
      ...Array.from({ length: 10 }, () => ({ ...base, action: 'delegate' as const, latencyMs: 0, cached: true })),
    ])
    expect(text).toContain('cached: 10')
    // p50 over [400, 500, 600] is 500; if cache zeros leaked in it would be 0.
    expect(text).toContain('p50 500ms')
    expect(text).not.toContain('p50 0ms')
  })

  it('summarizes approval-loop agreement buckets as a headline line', async () => {
    const text = await withLog([
      { ...base, tag: 'approval-loop' as const, action: 'agreement' as const, detail: 'jev=auto-approve human=rejected would-over-approve' },
      { ...base, tag: 'approval-loop' as const, action: 'agreement' as const, detail: 'jev=auto-approve human=rejected would-over-approve' },
      { ...base, tag: 'approval-loop' as const, action: 'agreement' as const, detail: 'jev=human human=allowed-once friction-human-approved' },
      { ...base, tag: 'approval-loop' as const, action: 'agreement' as const, detail: 'jev=auto-approve human=allowed-once aligned-approve' },
    ])
    expect(text).toContain('would-over-approve=2')
    expect(text).toContain('friction-human-approved=1')
    expect(text).toContain('aligned-approve=1')
  })

  it('prints no agreement line for tags without buckets', async () => {
    const text = await withLog([{ ...base, action: 'delegate' as const, latencyMs: 100 }])
    expect(text).not.toContain('agreement:')
  })
})
