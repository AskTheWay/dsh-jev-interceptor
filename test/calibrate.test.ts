import { describe, expect, it } from 'vitest'
import {
  calibrate,
  guardBranchOf,
  guardSampleOf,
  parseGuardDetail,
  parsePreapproveDetail,
  preapproveSampleOf,
  renderCalibration,
  replayGuard,
  type ThresholdsInput,
} from '../src/calibrate.js'
import { decideGuard } from '../src/matrix.js'
import type { TelemetryEntry } from '../src/telemetry.js'

/** 与 DEFAULTS 对齐的校准基线。 */
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

/** 一条带 scores 与 detail（answerDetail 同格式）的 guard 记录。 */
function guardEntry(
  risk: 'low' | 'medium' | 'high',
  p: number,
  irrev: number,
  task = 0.9,
  inj = 0.02,
): TelemetryEntry {
  return {
    ts: '2026-10-08T00:00:00.000Z',
    tag: 'guard',
    mode: 'shadow',
    action: 'delegate',
    detail: `risk=${risk} p=${p.toFixed(2)} irrev=${irrev.toFixed(2)} task=${task.toFixed(2)} inj=${inj.toFixed(2)}`,
    scores: { risk_p: p, irrev, task, inj },
  }
}

/** 一条 approval-loop 一致率桶记录（approval-loop 的 detail 格式）。 */
function loopEntry(bucket: string): TelemetryEntry {
  return {
    ts: '2026-10-08T00:00:00.000Z',
    tag: 'approval-loop',
    mode: 'shadow',
    action: 'agreement',
    detail: `jev=auto-approve human=rejected ${bucket}`,
  }
}

describe('parseGuardDetail', () => {
  it('parses the answerDetail format', () => {
    expect(parseGuardDetail('risk=medium p=0.78 irrev=0.10 task=0.90 inj=0.02')).toEqual({
      risk: 'medium', riskConfidence: 0.78, irreversibility: 0.10, taskMatch: 0.90, injection: 0.02,
    })
  })

  it('tolerates trailing additions (anchored at ^ only) and rejects garbage', () => {
    expect(parseGuardDetail('risk=high p=0.92 irrev=0.80 task=0.50 inj=0.01 extra=1')?.risk).toBe('high')
    expect(parseGuardDetail(undefined)).toBeUndefined()
    expect(parseGuardDetail('')).toBeUndefined()
    expect(parseGuardDetail('no tokens here')).toBeUndefined()
  })
})

describe('parsePreapproveDetail', () => {
  it('parses with and without a human-reason suffix (digits inside the suffix are not swallowed)', () => {
    expect(parsePreapproveDetail('scope=0.90 reversible=0.95 inj=0.02')).toEqual({ scope: 0.9, reversibility: 0.95, injection: 0.02 })
    expect(parsePreapproveDetail('scope=0.60 reversible=0.95 inj=0.02 (范围置信度 0.60 低于 0.85)')).toEqual({ scope: 0.6, reversibility: 0.95, injection: 0.02 })
  })
})

describe('sample extraction', () => {
  it('prefers full-precision scores and reads the risk option from the detail prefix', () => {
    const sample = guardSampleOf(guardEntry('medium', 0.723456, 0.1, 0.9, 0.02))
    expect(sample?.riskConfidence).toBeCloseTo(0.723456, 10)
    expect(sample?.risk).toBe('medium')
  })

  it('falls back to detail parsing for legacy entries and skips unparseable/degraded ones', () => {
    const legacy: TelemetryEntry = {
      ts: '2026-09-01T00:00:00.000Z', tag: 'guard', mode: 'shadow', action: 'ask',
      detail: 'risk=medium p=0.70 irrev=0.10 task=0.90 inj=0.02',
    }
    expect(guardSampleOf(legacy)?.riskConfidence).toBe(0.70)
    expect(guardSampleOf({ ...legacy, detail: undefined })).toBeUndefined()
    expect(guardSampleOf({ ...legacy, action: 'degraded', detail: 'no-key' })).toBeUndefined()
  })

  it('extracts preapprove samples with the same precedence', () => {
    const entry: TelemetryEntry = {
      ts: '2026-10-08T00:00:00.000Z', tag: 'preapprove', mode: 'shadow', action: 'auto-approve',
      detail: 'scope=0.90 reversible=0.95 inj=0.02',
      scores: { scope: 0.901234, reversible: 0.95, inj: 0.02 },
    }
    expect(preapproveSampleOf(entry)?.scope).toBeCloseTo(0.901234, 10)
    expect(preapproveSampleOf({ ...entry, scores: undefined })?.scope).toBe(0.9)
  })
})

describe('replayGuard', () => {
  it('counts exactly what per-sample decideGuard decides (matrix stays the single source of truth)', () => {
    const samples = [
      { risk: 'low' as const, riskConfidence: 0.9, irreversibility: 0.05, taskMatch: 0.9, injection: 0.02 },
      { risk: 'medium' as const, riskConfidence: 0.8, irreversibility: 0.1, taskMatch: 0.9, injection: 0.02 },
      { risk: 'high' as const, riskConfidence: 0.9, irreversibility: 0.8, taskMatch: 0.9, injection: 0.02 },
      { risk: 'low' as const, riskConfidence: 0.9, irreversibility: 0.3, taskMatch: 0.9, injection: 0.02 },
    ]
    const thresholds = {
      confidenceMin: current.guardConfidenceMin,
      denyConfidence: current.guardDenyConfidence,
      irreversibleCeiling: current.guardIrreversibleCeiling,
      irreversibleDenyFloor: current.guardIrreversibleDenyFloor,
      injectionAskThreshold: current.guardInjectionAskThreshold,
    }
    const replay = replayGuard(samples, thresholds)
    const manual = { delegate: 0, ask: 0, deny: 0 }
    for (const sample of samples) {
      const decision = decideGuard({
        risk: { type: 'choice', choice: sample.risk, probabilities: { [sample.risk]: sample.riskConfidence }, confidence: sample.riskConfidence },
        irreversible: { type: 'noul', noul: sample.irreversibility },
        matchesTask: { type: 'noul', noul: sample.taskMatch },
        injectionSuspect: { type: 'noul', noul: sample.injection },
      }, thresholds)
      manual[decision.kind] += 1
    }
    expect(replay.actions).toEqual(manual)
  })

  it('attributes branches that mirror decideGuard conditions', () => {
    expect(guardBranchOf(
      { risk: 'high', riskConfidence: 0.9, irreversibility: 0.8, taskMatch: 0.9, injection: 0.02 },
      { confidenceMin: 0.6, denyConfidence: 0.85, irreversibleCeiling: 0.2, irreversibleDenyFloor: 0.5, injectionAskThreshold: 0.8 },
    )).toBe('deny')
  })
})

describe('calibrate rules', () => {
  it('returns a no-data report for an empty window', () => {
    const report = calibrate([], current)
    expect(report.windowSize).toBe(0)
    expect(report.advice).toHaveLength(0)
    expect(report.observations[0]?.reason).toContain('暂无数据')
  })

  it('R1: tightens preapproveAutoApproveMin on any would-over-approve once buckets reach the danger floor', () => {
    const entries = Array.from({ length: 10 }, () => loopEntry('would-over-approve'))
    const report = calibrate(entries, current)
    const advice = report.advice.find(a => a.param === 'preapproveAutoApproveMin')
    expect(advice?.suggested).toBeCloseTo(0.90, 10)
  })

  it('R1 guardrail: a danger signal below the floor lands in insufficient, not advice', () => {
    const entries = Array.from({ length: 9 }, () => loopEntry('would-over-approve'))
    const report = calibrate(entries, current)
    expect(report.advice).toHaveLength(0)
    expect(report.insufficient.some(n => n.param === 'preapproveAutoApproveMin')).toBe(true)
  })

  it('R2: relaxes preapproveAutoApproveMin only with zero mis-approvals, enough samples, and hot friction', () => {
    const entries = [
      ...Array.from({ length: 30 }, () => loopEntry('friction-human-approved')),
    ]
    const report = calibrate(entries, current)
    const advice = report.advice.find(a => a.param === 'preapproveAutoApproveMin')
    expect(advice?.suggested).toBeCloseTo(0.80, 10)
  })

  it('R3: raises guardConfidenceMin when asks are hot and medium-risk dominates', () => {
    const entries = Array.from({ length: 35 }, () => guardEntry('medium', 0.8, 0.1))
    const report = calibrate(entries, current)
    const advice = report.advice.find(a => a.param === 'guardConfidenceMin')
    expect(advice?.suggested).toBeCloseTo(0.65, 10)
    expect(advice?.basis).toContain('中风险')
  })

  it('R4: raises guardIrreversibleCeiling when low-risk irreversibility dominates asks', () => {
    const entries = Array.from({ length: 35 }, () => guardEntry('low', 0.9, 0.3))
    const report = calibrate(entries, current)
    const advice = report.advice.find(a => a.param === 'guardIrreversibleCeiling')
    expect(advice?.suggested).toBeCloseTo(0.25, 10)
  })

  it('R5: raises guardDenyConfidence when denies are hot', () => {
    const entries = Array.from({ length: 35 }, () => guardEntry('high', 0.9, 0.8))
    const report = calibrate(entries, current)
    const advice = report.advice.find(a => a.param === 'guardDenyConfidence')
    expect(advice?.suggested).toBeCloseTo(0.90, 10)
  })

  it('R6: lowers the deny gate when zero denies meet replay-provable denies within the cap', () => {
    // 95 low delegates + 5 high calls sitting just under the deny gate
    // (conf 0.80 < 0.85): lowering denyConfidence to 0.80 turns exactly 5% into denies.
    const entries = [
      ...Array.from({ length: 95 }, () => guardEntry('low', 0.9, 0.05)),
      ...Array.from({ length: 5 }, () => guardEntry('high', 0.80, 0.55)),
    ]
    const report = calibrate(entries, current)
    const advice = report.advice.find(a => a.param === 'guardDenyConfidence')
    expect(advice?.suggested).toBeCloseTo(0.80, 10)
    expect(advice?.basis).toContain('反事实重放')
  })

  it('R6 guardrail: replay yields no deny → observation only', () => {
    const entries = [
      ...Array.from({ length: 30 }, () => guardEntry('low', 0.9, 0.05)),
      ...Array.from({ length: 5 }, () => guardEntry('high', 0.5, 0.9)),
    ]
    const report = calibrate(entries, current)
    expect(report.advice.filter(a => a.param.startsWith('guard'))).toHaveLength(0)
    expect(report.observations.some(n => n.reason.includes('反事实重放'))).toBe(true)
  })

  it('never numerically advises the injection thresholds', () => {
    const entries = [
      // 35 个注入升级样本（inj >= 0.8）+ 10 个误批桶。
      ...Array.from({ length: 35 }, () => guardEntry('low', 0.9, 0.05, 0.9, 0.9)),
      ...Array.from({ length: 10 }, () => loopEntry('would-over-approve')),
    ]
    const report = calibrate(entries, current)
    expect(report.advice.some(a => a.param.includes('Injection'))).toBe(false)
    expect(report.observations.some(n => n.param.includes('Injection'))).toBe(true)
  })

  it('R1 direction guard: current beyond the clamp ceiling degrades to an observation, never a reversed "tighten"', () => {
    // current=1.0（schema 合法域）时 +0.05 被 clamp 到 0.95，实为放宽——必须降级为观察。
    const entries = Array.from({ length: 10 }, () => loopEntry('would-over-approve'))
    const atCeiling = calibrate(entries, { ...current, preapproveAutoApproveMin: 1.0 })
    expect(atCeiling.advice).toHaveLength(0)
    expect(atCeiling.observations.some(n => n.reason.includes('上限'))).toBe(true)
    // 默认 0.90 再收紧到 0.95 后自循环：同样降级而非重复无效建议。
    const stalled = calibrate(entries, { ...current, preapproveAutoApproveMin: 0.95 })
    expect(stalled.advice).toHaveLength(0)
    expect(stalled.observations.some(n => n.reason.includes('上限'))).toBe(true)
  })

  it('attributes a majority-injection ask surplus to the injection line (never numeric advice)', () => {
    // 40 条：20 条注入升级（占 ask 过半）+10 medium ask+5 high ask+5 delegate。
    const entries = [
      ...Array.from({ length: 20 }, () => guardEntry('low', 0.9, 0.05, 0.9, 0.9)),
      ...Array.from({ length: 10 }, () => guardEntry('medium', 0.8, 0.1)),
      ...Array.from({ length: 5 }, () => guardEntry('high', 0.7, 0.3)),
      ...Array.from({ length: 5 }, () => guardEntry('low', 0.9, 0.05)),
    ]
    const report = calibrate(entries, current)
    expect(report.advice).toHaveLength(0)
    expect(report.observations.some(n => n.reason.includes('过半来自注入嫌疑升级'))).toBe(true)
    expect(report.observations.some(n => n.reason.includes('无单一过半分支'))).toBe(false)
  })

  it('diagnoses an all-degraded preapprove window as a provider fault, not an empty allowlist', () => {
    const degraded: TelemetryEntry[] = Array.from({ length: 3 }, () => ({
      ts: '2026-10-08T00:00:00.000Z', tag: 'preapprove', mode: 'shadow', action: 'degraded',
      detail: 'answer-shape-mismatch',
    }))
    const report = calibrate(degraded, current)
    expect(report.observations.some(n => n.reason.includes('全部降级'))).toBe(true)
    expect(report.observations.some(n => n.reason.includes('preapproveToolAllowlist 为空'))).toBe(false)
  })

  it('flags legacy windows and mixed modes', () => {
    const legacy: TelemetryEntry = {
      ts: '2026-09-01T00:00:00.000Z', tag: 'guard', mode: 'enforce', action: 'delegate',
      detail: 'risk=low p=0.90 irrev=0.05 task=0.90 inj=0.02',
    }
    const report = calibrate([legacy, guardEntry('low', 0.9, 0.05)], current)
    expect(report.hasLegacySamples).toBe(true)
    expect(report.observations.some(n => n.reason.includes('旧格式'))).toBe(true)
    expect(report.observations.some(n => n.reason.includes('shadow'))).toBe(true)
  })
})

describe('renderCalibration', () => {
  it('renders a fenced report with the no-auto-apply footer', () => {
    const entries = Array.from({ length: 35 }, () => guardEntry('medium', 0.8, 0.1))
    const text = renderCalibration(calibrate(entries, current))
    expect(text.startsWith('```')).toBe(true)
    expect(text.endsWith('```')).toBe(true)
    expect(text).toContain('不自动应用')
    expect(text).toContain('0.60 → 0.65')
  })

  it('renders the empty-window placeholder without sections', () => {
    const text = renderCalibration(calibrate([], current))
    expect(text).toContain('暂无数据')
  })
})
