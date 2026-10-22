import { describe, expect, it } from 'vitest'
import { renderImpact, summarizeImpact } from '../src/impact.js'
import type { TelemetryEntry } from '../src/telemetry.js'

const TS = (day: number, seq: number): string => `2026-10-${String(day).padStart(2, '0')}T0${String(seq)}:00:00.000Z`

/** 一条遥测记录的便捷构造。 */
function entry(overrides: Partial<TelemetryEntry> & Pick<TelemetryEntry, 'tag' | 'action' | 'mode'>): TelemetryEntry {
  return { ts: TS(1, 1), ...overrides } as TelemetryEntry
}

describe('summarizeImpact', () => {
  it('counts enforce-only outcomes and separates shadow volume', () => {
    const summary = summarizeImpact([
      entry({ tag: 'guard', action: 'deny', mode: 'enforce', ts: TS(1, 1), sessionId: 's1' }),
      entry({ tag: 'guard', action: 'ask', mode: 'enforce', ts: TS(1, 2), sessionId: 's1' }),
      entry({ tag: 'preapprove', action: 'auto-approve', mode: 'enforce', ts: TS(2, 1), sessionId: 's2' }),
      entry({ tag: 'preapprove', action: 'auto-approve', mode: 'enforce', ts: TS(2, 2), sessionId: 's2' }),
      entry({ tag: 'stagnation', action: 'stagnation-alert', mode: 'enforce', ts: TS(2, 3) }),
      // shadow 期的同名动作不计入 enforce 指标。
      entry({ tag: 'guard', action: 'deny', mode: 'shadow', ts: TS(3, 1) }),
      entry({ tag: 'guard', action: 'delegate', mode: 'shadow', ts: TS(3, 2) }),
    ])
    expect(summary.enforce).toEqual({ denied: 1, asked: 1, autoApproved: 2, stagnationAlerts: 1 })
    expect(summary.modeSplit).toEqual({ shadow: 2, enforce: 5 })
    expect(summary.days).toBe(3)
    expect(summary.sessions).toBe(2)
    expect(summary.firstTs).toBe(TS(1, 1))
    expect(summary.lastTs).toBe(TS(3, 2))
  })

  it('aggregates agreement buckets by mode, cost, cache-free latency, and degrade reasons', () => {
    const summary = summarizeImpact([
      entry({ tag: 'approval-loop', action: 'agreement', mode: 'enforce', detail: 'jev=auto-approve human=rejected would-over-approve' }),
      entry({ tag: 'approval-loop', action: 'agreement', mode: 'enforce', detail: 'jev=human human=allowed-once friction-human-approved' }),
      // shadow 期的对照桶不进 enforce 分桶。
      entry({ tag: 'approval-loop', action: 'agreement', mode: 'shadow', detail: 'jev=auto-approve human=rejected would-over-approve' }),
      entry({ tag: 'guard', action: 'delegate', mode: 'enforce', latencyMs: 100, inputTokens: 1000, costUsd: 0.000042 }),
      entry({ tag: 'guard', action: 'delegate', mode: 'enforce', latencyMs: 300, inputTokens: 1000, costUsd: 0.000042 }),
      // 缓存命中：不进延迟分位、不重复计费。
      entry({ tag: 'guard', action: 'delegate', mode: 'enforce', latencyMs: 0, cached: true }),
      // 降级：不计成本（降级记录无计费字段），但延迟等待计入分位（与 /jev-stats 同口径）。
      entry({ tag: 'guard', action: 'degraded', mode: 'enforce', detail: 'timeout', latencyMs: 5000 }),
      entry({ tag: 'guard', action: 'degraded', mode: 'enforce', detail: 'no-key' }),
    ])
    expect(summary.agreement.enforce['would-over-approve']).toBe(1)
    expect(summary.agreement.enforce['friction-human-approved']).toBe(1)
    expect(summary.agreement.shadow['would-over-approve']).toBe(1)
    expect(summary.cost).toMatchObject({ inputTokens: 2000, costUsd: 0.000084, cachedDecisions: 1, estimatedCostUsd: undefined })
    // timeout 降级的 5000ms 等待计入尾部（p95 = 5000）。
    expect(summary.latency).toEqual({ p50: 300, p95: 5000 })
    expect(summary.degraded).toEqual({ total: 2, byReason: { timeout: 1, 'no-key': 1 } })
  })

  it('estimates cost only when every record lacks costUsd (reported zeros stay zero)', () => {
    // 全缺：估算是合理的。
    const missing = summarizeImpact([
      entry({ tag: 'guard', action: 'delegate', mode: 'enforce', inputTokens: 1_000_000 }),
    ])
    expect(missing.cost.estimatedCostUsd).toBeCloseTo(0.042, 10)
    // provider 明确上报 cost=0（免费窗口）：不估算、如实显示 $0。
    const free = summarizeImpact([
      entry({ tag: 'guard', action: 'delegate', mode: 'enforce', inputTokens: 1000, costUsd: 0 }),
    ])
    expect(free.cost.costUsd).toBe(0)
    expect(free.cost.estimatedCostUsd).toBeUndefined()
  })

  it('renders zero-denominator mis-approval as no-sample instead of zero', () => {
    const text = renderImpact(summarizeImpact([
      entry({ tag: 'guard', action: 'delegate', mode: 'enforce' }),
    ]))
    expect(text).toContain('无样本（预批准路径未触发')
    expect(text).not.toContain('would-over-approve = 0')
  })

  it('renders shadow would-over-approve as a hypothetical line, never inside the enforce section', () => {
    const text = renderImpact(summarizeImpact([
      entry({ tag: 'approval-loop', action: 'agreement', mode: 'shadow', detail: 'jev=auto-approve human=rejected would-over-approve' }),
    ]))
    expect(text).toContain('shadow 对照')
    expect(text).toContain('假设性')
    // 实际生效段不出现误批计数。
    expect(text).not.toContain('误批             1 次')
  })

  it('returns an all-zero summary for an empty window', () => {
    const summary = summarizeImpact([])
    expect(summary.windowSize).toBe(0)
    expect(summary.enforce).toEqual({ denied: 0, asked: 0, autoApproved: 0, stagnationAlerts: 0 })
    expect(summary.firstTs).toBeUndefined()
    expect(summary.latency.p50).toBeUndefined()
  })
})

describe('renderImpact', () => {
  it('renders the net-benefit narrative with fence and footer', () => {
    const text = renderImpact(summarizeImpact([
      entry({ tag: 'preapprove', action: 'auto-approve', mode: 'enforce', inputTokens: 500_000, costUsd: 0.021 }),
      entry({ tag: 'guard', action: 'deny', mode: 'enforce' }),
      entry({ tag: 'approval-loop', action: 'agreement', mode: 'enforce', detail: 'jev=auto-approve human=allowed-once aligned-approve' }),
    ]))
    expect(text.startsWith('```')).toBe(true)
    expect(text).toContain('省掉的审批点击')
    expect(text).toContain('误批             0 次')
    expect(text).toContain('$0.0210')
    expect(text).toContain('一句话')
    expect(text).toContain('明细: /jev-log')
  })

  it('renders the empty-window placeholder', () => {
    expect(renderImpact(summarizeImpact([]))).toContain('暂无数据')
  })
})
