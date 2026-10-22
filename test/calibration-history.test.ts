import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { calibrate, type ThresholdAdvice, type ThresholdKey, type ThresholdsInput } from '../src/calibrate.js'
import {
  CalibrationHistory,
  compareWithPrevious,
  renderComparisonLines,
  shouldAppend,
  snapshotOf,
} from '../src/calibration-history.js'

const current: ThresholdsInput = {
  guardConfidenceMin: 0.6,
  guardDenyConfidence: 0.85,
  guardIrreversibleCeiling: 0.2,
  guardIrreversibleDenyFloor: 0.5,
  guardInjectionAskThreshold: 0.8,
  preapproveAutoApproveMin: 0.85,
  preapproveIrreversibleMax: 0.15,
  preapproveInjectionSuspectMax: 0.5,
}

function reportWithAdvice(params: Array<{ param: ThresholdKey; current: number; suggested: number }>): ReturnType<typeof calibrate> {
  // 直接构造带指定 advice 的报告形状（纯数据，不跑规则）。
  const advice: readonly ThresholdAdvice[] = params.map(p => ({ ...p, basis: 'test', samples: 50, note: 'test' }))
  return {
    windowSize: 50,
    counts: { guard: 50, preapprove: 0, approvalLoop: 10 },
    modeSplit: { shadow: 50, enforce: 0 },
    hasLegacySamples: false,
    advice,
    insufficient: [],
    observations: [],
  }
}

describe('CalibrationHistory', () => {
  it('persists snapshots and reads them back oldest→newest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-jev-hist-'))
    const history = new CalibrationHistory(dir)
    history.append(snapshotOf(reportWithAdvice([]), current, '2026-10-01T10:00:00.000Z', { 'aligned-approve': 3 }))
    history.append(snapshotOf(reportWithAdvice([{ param: 'guardConfidenceMin', current: 0.6, suggested: 0.65 }]), current, '2026-10-02T10:00:00.000Z', { 'aligned-approve': 5 }))
    await new Promise(resolve => setTimeout(resolve, 60))
    const recent = await history.recent(10)
    expect(recent.map(s => s.ts.slice(0, 10))).toEqual(['2026-10-01', '2026-10-02'])
    expect(recent[1]?.advice[0]).toMatchObject({ param: 'guardConfidenceMin', suggested: 0.65 })
    expect(recent[1]?.buckets).toEqual({ 'aligned-approve': 5 })
    await rm(dir, { recursive: true, force: true })
  })

  it('reads an absent file as empty and never throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-jev-hist-'))
    expect(await new CalibrationHistory(dir).recent()).toEqual([])
    await rm(dir, { recursive: true, force: true })
  })
})

describe('compareWithPrevious', () => {
  const previous = snapshotOf(
    reportWithAdvice([
      { param: 'guardConfidenceMin', current: 0.6, suggested: 0.65 },
      { param: 'preapproveAutoApproveMin', current: 0.85, suggested: 0.9 },
    ]),
    current,
    '2026-10-01T10:00:00.000Z',
    { 'would-over-approve': 2, 'aligned-approve': 8 },
  )

  it('classifies adopted (current == suggested) and ignored (current unchanged)', () => {
    // 用户采纳了第一条（0.6→0.65）、没动第二条。
    const after: ThresholdsInput = { ...current, guardConfidenceMin: 0.65 }
    const comparison = compareWithPrevious(after, previous, { 'would-over-approve': 0, 'aligned-approve': 12 })
    expect(comparison.previousTs).toBe('2026-10-01T10:00:00.000Z')
    expect(comparison.adopted).toEqual([{ param: 'guardConfidenceMin', suggested: 0.65, now: 0.65 }])
    expect(comparison.ignored).toEqual([{ param: 'preapproveAutoApproveMin', suggested: 0.9, now: 0.85 }])
    expect(comparison.bucketsDelta).toEqual({ 'would-over-approve': -2, 'aligned-approve': 4 })
  })

  it('returns empty adoption state without history', () => {
    const comparison = compareWithPrevious(current, undefined, {})
    expect(comparison.previousTs).toBeUndefined()
    expect(comparison.adopted).toEqual([])
    expect(renderComparisonLines(comparison)[0]).toContain('暂无历史')
  })

  it('manual edits to other values are classified as manual (not silently dropped)', () => {
    const after: ThresholdsInput = { ...current, guardConfidenceMin: 0.7 }
    const comparison = compareWithPrevious(after, previous, {})
    expect(comparison.adopted).toHaveLength(0)
    expect(comparison.ignored).toEqual([{ param: 'preapproveAutoApproveMin', suggested: 0.9, now: 0.85 }])
    expect(comparison.manual).toEqual([{ param: 'guardConfidenceMin', suggested: 0.65, now: 0.7 }])
    const lines = renderComparisonLines(comparison)
    expect(lines.some(l => l.includes('已手动改 guardConfidenceMin') && l.includes('0.70'))).toBe(true)
  })

  it('marks bucket deltas incomparable when window scopes differ (--all vs tail window)', () => {
    // 上次：全量 3400 条窗口的桶；本次：2000 条尾窗的桶——差值无意义。
    const comparison = compareWithPrevious(current, { ...previous, windowSize: 3400 }, { 'aligned-approve': 1000 }, 2000)
    expect(comparison.incomparable).toBe(true)
    expect(comparison.bucketsDelta).toEqual({})
    expect(renderComparisonLines(comparison).some(l => l.includes('窗口口径不同'))).toBe(true)
    // 同口径时照常给差值。
    const same = compareWithPrevious(current, previous, { 'would-over-approve': 0 }, previous.windowSize)
    expect(same.incomparable).toBe(false)
    expect(same.bucketsDelta).toEqual({ 'would-over-approve': -2, 'aligned-approve': -8 })
  })
})

describe('renderComparisonLines', () => {
  it('renders adoption, ignore, and bucket deltas in Chinese', () => {
    const previous = snapshotOf(
      reportWithAdvice([{ param: 'guardConfidenceMin', current: 0.6, suggested: 0.65 }]),
      current,
      '2026-10-01T10:00:00.000Z',
      { 'would-over-approve': 2 },
    )
    const comparison = compareWithPrevious({ ...current, guardConfidenceMin: 0.65 }, previous, { 'would-over-approve': 0 })
    const lines = renderComparisonLines(comparison)
    expect(lines[0]).toContain('上次对比')
    expect(lines.some(l => l.includes('已采纳 guardConfidenceMin'))).toBe(true)
    expect(lines.some(l => l.includes('误批风险 -2'))).toBe(true)
  })
})

describe('shouldAppend', () => {
  const base = snapshotOf(reportWithAdvice([{ param: 'guardConfidenceMin', current: 0.6, suggested: 0.65 }]), current, '2026-10-01T10:00:00.000Z', { 'aligned-approve': 3 })

  it('skips an identical snapshot inside the debounce window', () => {
    const duplicate = { ...base, ts: '2026-10-01T10:02:00.000Z' }
    expect(shouldAppend(base, duplicate)).toBe(false)
  })

  it('keeps snapshots whose advice, thresholds, or buckets changed, or after the window', () => {
    expect(shouldAppend(base, { ...base, ts: '2026-10-01T10:02:00.000Z', buckets: { 'aligned-approve': 4 } })).toBe(true)
    expect(shouldAppend(base, { ...base, ts: '2026-10-01T10:02:00.000Z', advice: [] })).toBe(true)
    expect(shouldAppend(base, { ...base, ts: '2026-10-01T10:30:00.000Z' })).toBe(true)
    expect(shouldAppend(undefined, base)).toBe(true)
  })
})
