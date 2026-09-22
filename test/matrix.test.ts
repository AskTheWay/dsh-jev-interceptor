import { describe, expect, it } from 'vitest'
import { decideGuard, decidePreapprove, type GuardAnswers, type GuardThresholds } from '../src/matrix.js'

const thresholds: GuardThresholds = {
  confidenceMin: 0.6,
  denyConfidence: 0.85,
  irreversibleCeiling: 0.2,
  irreversibleDenyFloor: 0.5,
  injectionAskThreshold: 0.8,
}

function answers(overrides: Partial<GuardAnswers> = {}): GuardAnswers {
  return {
    risk: { type: 'choice', choice: 'low', probabilities: { low: 0.9, medium: 0.08, high: 0.02 }, confidence: 0.9 },
    irreversible: { type: 'noul', noul: 0.05 },
    matchesTask: { type: 'noul', noul: 0.9 },
    injectionSuspect: { type: 'noul', noul: 0.02 },
    ...overrides,
  }
}

describe('decideGuard', () => {
  it('delegates on confident low risk with reversible effects', () => {
    expect(decideGuard(answers(), thresholds)).toEqual({ kind: 'delegate' })
  })

  it('escalates low risk with confidence below the floor instead of acting', () => {
    const low = answers({ risk: { type: 'choice', choice: 'low', probabilities: { low: 0.7, medium: 0.2, high: 0.1 }, confidence: 0.5 } })
    expect(decideGuard(low, thresholds).kind).toBe('ask')
  })

  it('escalates low risk that is possibly irreversible', () => {
    const irrev = answers({ irreversible: { type: 'noul', noul: 0.3 } })
    expect(decideGuard(irrev, thresholds).kind).toBe('ask')
  })

  it('asks on confident medium risk', () => {
    const medium = answers({ risk: { type: 'choice', choice: 'medium', probabilities: { low: 0.1, medium: 0.8, high: 0.1 }, confidence: 0.8 } })
    const decision = decideGuard(medium, thresholds)
    expect(decision.kind).toBe('ask')
    expect(decision.kind === 'ask' && decision.reason.startsWith('jev-guard:')).toBe(true)
  })

  it('delegates on low-confidence medium risk (no basis to escalate)', () => {
    const medium = answers({ risk: { type: 'choice', choice: 'medium', probabilities: { low: 0.35, medium: 0.4, high: 0.25 }, confidence: 0.31 } })
    expect(decideGuard(medium, thresholds).kind).toBe('delegate')
  })

  it('never lets high risk delegate', () => {
    const high = answers({
      risk: { type: 'choice', choice: 'high', probabilities: { low: 0.05, medium: 0.15, high: 0.8 }, confidence: 0.7 },
      irreversible: { type: 'noul', noul: 0.3 },
    })
    expect(decideGuard(high, thresholds).kind).toBe('ask')
  })

  it('denies confident high risk with irreversible effects', () => {
    const high = answers({
      risk: { type: 'choice', choice: 'high', probabilities: { low: 0.02, medium: 0.08, high: 0.9 }, confidence: 0.9 },
      irreversible: { type: 'noul', noul: 0.8 },
    })
    const decision = decideGuard(high, thresholds)
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason.startsWith('jev-guard:')).toBe(true)
  })

  it('escalates regardless of risk when injection is suspected', () => {
    const injected = answers({ injectionSuspect: { type: 'noul', noul: 0.9 } })
    const decision = decideGuard(injected, thresholds)
    expect(decision.kind).toBe('ask')
    expect(decision.kind === 'ask' && decision.reason.includes('injection')).toBe(true)
  })
})

describe('decidePreapprove', () => {
  const thresholds = { autoApproveMin: 0.85, irreversibleMax: 0.15 }

  it('auto-approves only confident in-scope reversible calls', () => {
    expect(decidePreapprove(
      { withinGrantedScope: { type: 'noul', noul: 0.9 }, reversible: { type: 'noul', noul: 0.95 } },
      thresholds,
    )).toEqual({ kind: 'auto-approve' })
  })

  it('blocks on scope doubt', () => {
    const verdict = decidePreapprove(
      { withinGrantedScope: { type: 'noul', noul: 0.6 }, reversible: { type: 'noul', noul: 0.95 } },
      thresholds,
    )
    expect(verdict.kind).toBe('human')
  })

  it('blocks on irreversibility at or above the ceiling', () => {
    const verdict = decidePreapprove(
      { withinGrantedScope: { type: 'noul', noul: 0.95 }, reversible: { type: 'noul', noul: 0.8 } },
      thresholds,
    )
    expect(verdict.kind).toBe('human')
  })
})
