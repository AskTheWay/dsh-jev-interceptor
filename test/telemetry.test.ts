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
    expect(text).toContain('缓存 10')
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
    expect(text).toContain('误批风险')
    expect(text).toContain('多余人工')
    expect(text).toContain('一致批')
  })

  it('prints no agreement line for tags without buckets', async () => {
    const text = await withLog([{ ...base, action: 'delegate' as const, latencyMs: 100 }])
    expect(text).not.toContain('agreement:')
  })
})

describe('Telemetry.entries', () => {
  it('returns the whole log without an argument and only the tail with one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-jev-tel-'))
    const telemetry = new Telemetry(dir)
    for (let i = 1; i <= 5; i++) {
      telemetry.record({ ...base, action: 'delegate' as const, detail: `#${String(i)}` })
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
    const all = await telemetry.entries()
    expect(all).toHaveLength(5)
    expect(all.at(-1)?.detail).toBe('#5')
    const tail = await telemetry.entries(2)
    expect(tail).toHaveLength(2)
    expect(tail[0]?.detail).toBe('#4')
    await rm(dir, { recursive: true, force: true })
  })

  it('reads an absent log as empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-jev-tel-'))
    const telemetry = new Telemetry(dir)
    expect(await telemetry.entries()).toEqual([])
    await rm(dir, { recursive: true, force: true })
  })
})

describe('Telemetry.recentEntries', () => {
  it('returns exactly the last N entries (oldest first) even with long lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-jev-tel-'))
    const telemetry = new Telemetry(dir)
    // 长行（detail 2 KB）逼出窗口翻倍路径。
    for (let i = 1; i <= 6; i++) {
      telemetry.record({
        ...base,
        action: 'delegate' as const,
        detail: i <= 2 ? `#${String(i)} ${'x'.repeat(2048)}` : `#${String(i)}`,
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
    const four = await telemetry.recentEntries(4)
    expect(four.map(e => e.detail?.slice(0, 2))).toEqual(['#3', '#4', '#5', '#6'])
    const all = await telemetry.recentEntries(100)
    expect(all).toHaveLength(6)
    expect(await telemetry.recentEntries(0)).toEqual([])
    await rm(dir, { recursive: true, force: true })
  })
})
