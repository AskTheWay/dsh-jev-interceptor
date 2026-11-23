import { describe, expect, it } from 'vitest'
import {
  decisionDays,
  decisionScores,
  filterDecisions,
  type DecisionRecord,
} from '../src/client/view-model.js'

const record = (patch: Partial<DecisionRecord> = {}): DecisionRecord => ({
  ts: '2026-11-20T12:00:00Z',
  tag: 'guard',
  mode: 'shadow',
  action: 'delegate',
  ...patch,
})

describe('decision presentation', () => {
  it('combines filters and searches call/session identifiers without mixing modes', () => {
    const wanted = record({ tool: 'pwsh', sessionId: 'Session-ABC', callId: 'call-1' })
    const entries = [
      wanted,
      record({ mode: 'enforce', sessionId: 'Session-ABC' }),
      record({ tag: 'preapprove', action: 'auto-approve' }),
    ]
    const filters = { action: 'delegate', tag: 'guard', mode: 'shadow', query: ' session-abc ' }
    expect(filterDecisions(entries, filters)).toEqual([wanted])
    expect(filterDecisions(entries, { ...filters, query: 'CALL-1' })).toEqual([wanted])
    expect(filterDecisions(entries, { ...filters, query: 'missing' })).toEqual([])
  })

  it('fills inactive UTC days, anchors on the last record, and excludes older entries', () => {
    const days = decisionDays([
      record({ ts: '2026-11-20T23:30:00-03:00', action: 'ask' }),
      record({ ts: '2026-11-19T00:00:00Z', action: 'degraded' }),
      record({ ts: '2026-10-01T00:00:00Z' }),
      record({ ts: 'invalid' }),
    ])
    expect(days).toHaveLength(14)
    expect(days[0]?.day).toBe('2026-11-08')
    expect(days.at(-1)).toEqual({ day: '2026-11-21', total: 1, flagged: 1, degraded: 0 })
    expect(days.find((day) => day.day === '2026-11-20')?.total).toBe(0)
    expect(days.find((day) => day.day === '2026-11-19')?.degraded).toBe(1)
    expect(days.reduce((sum, day) => sum + day.total, 0)).toBe(2)
    expect(decisionDays([])).toEqual([])
    expect(decisionDays([record({ ts: 'invalid' })])).toEqual([])
  })

  it('uses full-precision evidence, keeps zero values, and falls back for legacy records', () => {
    const scores = decisionScores(
      record({
        scores: { risk_p: 0.987654, irrev: 0, inj: NaN, task: 2, user: 0.91, untrusted: 0.02 },
        detail: 'risk=low p=0.98 irrev=0.20 inj=0.12',
      }),
    )
    expect(scores.find((score) => score.key === 'risk_p')?.value).toBe(0.987654)
    expect(scores.find((score) => score.key === 'irrev')?.value).toBe(0)
    expect(scores.find((score) => score.key === 'user')?.value).toBe(0.91)
    expect(scores.find((score) => score.key === 'untrusted')?.value).toBe(0.02)
    expect(scores.some((score) => score.key === 'inj' || score.key === 'task')).toBe(false)
    expect(decisionScores(record({ detail: 'risk=low p=0.98 irrev=0.00 task=0.75 inj=0.01' }))).toHaveLength(
      4,
    )
    expect(
      decisionScores(record({ detail: 'notinj=0.10 scope=0.97 reversible=0.99' })).map((score) => score.key),
    ).toEqual(['scope', 'reversible'])
  })
})
