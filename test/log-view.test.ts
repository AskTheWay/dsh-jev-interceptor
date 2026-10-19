import { describe, expect, it } from 'vitest'
import {
  clampLogLimit,
  detailPreview,
  LOG_CSV_COLUMNS,
  parseLogArgs,
  renderLogTable,
  toLogCsv,
  toLogJson,
  type TelemetryEntry,
} from '../src/telemetry.js'

/** 一条典型明细记录。 */
function entry(overrides: Partial<TelemetryEntry> = {}): TelemetryEntry {
  return {
    ts: '2026-10-18T08:30:15.000Z',
    tag: 'guard',
    mode: 'enforce',
    tool: 'bash',
    callId: 'call-7',
    action: 'ask',
    detail: 'risk=medium 0.72 · irrev=0.30 · inj=0.01',
    latencyMs: 240,
    cached: false,
    ...overrides,
  }
}

describe('parseLogArgs', () => {
  it('defaults to 20 table entries and parses n plus format flags', () => {
    expect(parseLogArgs('')).toEqual({ n: 20, format: 'table' })
    expect(parseLogArgs('5')).toEqual({ n: 5, format: 'table' })
    expect(parseLogArgs('5 --csv')).toEqual({ n: 5, format: 'csv' })
    expect(parseLogArgs('--json 100')).toEqual({ n: 100, format: 'json' })
  })

  it('json wins over csv, garbage numbers fall back, bounds clamp', () => {
    expect(parseLogArgs('--csv --json').format).toBe('json')
    expect(parseLogArgs('abc').n).toBe(20)
    expect(parseLogArgs('0').n).toBe(1)
    expect(parseLogArgs('-5').n).toBe(1)
    expect(parseLogArgs('9999').n).toBe(500)
  })
})

describe('clampLogLimit', () => {
  it('clamps and falls back on non-numeric values', () => {
    expect(clampLogLimit('10', 50)).toBe(10)
    expect(clampLogLimit(null, 50)).toBe(50)
    expect(clampLogLimit('abc', 50)).toBe(50)
    expect(clampLogLimit('600', 50)).toBe(500)
    expect(clampLogLimit(0, 50)).toBe(1)
  })
})

describe('detailPreview', () => {
  it('flattens, truncates with ellipsis, and renders absence as a dash', () => {
    expect(detailPreview('a\n  b\tc')).toBe('a b c')
    expect(detailPreview('x'.repeat(100), 48)).toHaveLength(49)
    expect(detailPreview('x'.repeat(100), 48).endsWith('…')).toBe(true)
    expect(detailPreview(undefined)).toBe('—')
  })
})

describe('renderLogTable', () => {
  it('renders newest first with CJK labels, fenced', () => {
    const text = renderLogTable([
      entry({ ts: '2026-10-18T08:00:00.000Z', action: 'delegate', detail: 'risk=low p=0.90 irrev=0.05 task=0.90 inj=0.02' }),
      entry({ action: 'deny', detail: 'risk=high 0.92 · irrev=0.80 · inj=0.01' }),
    ])
    expect(text.startsWith('```')).toBe(true)
    // 新→旧：deny（08:30:15）在 delegate（08:00:00）之前。
    expect(text.indexOf('08:30:15')).toBeLessThan(text.indexOf('08:00:00'))
    expect(text).toContain('拒绝')
    expect(text).toContain('放行')
    expect(text).toContain('守门')
    expect(text).toContain('最近 2 条')
  })

  it('optionally footers the full-log path', () => {
    expect(renderLogTable([entry()], '/home/u/.dsh/plugins/dsh-jev-interceptor/telemetry.jsonl')).toContain('全量:')
  })
})

describe('toLogCsv', () => {
  it('emits the header row and escapes per RFC 4180', () => {
    const csv = toLogCsv([
      entry({ detail: 'has "quotes", commas\nand newlines' }),
      entry({ tool: undefined, callId: undefined, detail: undefined, latencyMs: undefined }),
    ])
    const lines = csv.split('\n')
    expect(lines[0]).toBe(LOG_CSV_COLUMNS.join(','))
    // 含逗号/引号的字段被引号包裹、内部引号翻倍、换行压平。
    expect(lines[1]).toContain('"has ""quotes"", commas and newlines"')
    expect(lines[1]).not.toContain('\n')
  })
})

describe('toLogJson', () => {
  it('round-trips through JSON.parse', () => {
    const entries = [entry(), entry({ tag: 'stagnation', action: 'stagnation-alert' })]
    expect(JSON.parse(toLogJson(entries))).toEqual(entries)
  })
})
