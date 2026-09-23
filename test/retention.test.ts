import { describe, expect, it } from 'vitest'
import type { SessionSurfaceSnapshot } from '@deepseek-ai/dsh-session-query'
import {
  previewAt,
  projectConversation,
  retainScoredSession,
  scoreCandidateIndices,
} from '../src/retention.js'

/** Minimal structural snapshot with the event shapes the projection consumes. */
function snapshot(messages: Array<{ role: 'user' | 'assistant'; text: string; checkpoint?: boolean }>): SessionSurfaceSnapshot {
  return {
    session: { id: 'session-x', cwd: '/work', version: 1, createdAt: 0 },
    capturedThroughSeq: messages.length,
    events: messages.map((message, index) => message.role === 'user'
      ? {
        type: 'user/message',
        seq: index,
        data: {
          source: message.checkpoint === true
            ? { kind: 'plugin', plugin: 'compact' }
            : { kind: 'user' },
          content: [{ type: 'text', text: message.text }],
        },
      }
      : {
        type: 'assistant/message',
        seq: index,
        data: {
          message: { content: [{ type: 'text', text: message.text }] },
          turn: 0,
          step: 0,
          attempt: 0,
          revision: 0,
          stopReason: { kind: 'stop' },
        },
      }),
  } as unknown as SessionSurfaceSnapshot
}

/** Rendered byte size of one retention result, for budget assertions. */
function sizeOf(result: { data: unknown }): number {
  return Buffer.byteLength(JSON.stringify(result.data), 'utf8')
}

describe('retainScoredSession — FIFO mode (scores=null, upstream policy)', () => {
  it('keeps everything under budget and reports untruncated stats', () => {
    const snap = snapshot([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi there' },
    ])
    const result = retainScoredSession(snap, 'label', 100_000, null)
    expect(result?.data.conversation.length).toBe(2)
    expect(result?.stats.truncated).toBe(false)
    expect(result?.stats.retainedMessages).toBe(2)
    expect(result?.fullData.conversation.length).toBe(2)
  })

  it('drops the oldest non-checkpoint messages first and protects the newest', () => {
    const snap = snapshot([
      { role: 'user', text: 'oldest'.repeat(40) },
      { role: 'user', text: 'middle'.repeat(40) },
      { role: 'assistant', text: 'newest answer' },
    ])
    const roomy = retainScoredSession(snap, 'l', 100_000, null)
    // Exact boundary: the size of the same conversation minus its first
    // message — one drop fits exactly, two drops are not needed.
    const afterOneDrop = retainScoredSession(snapshot([
      { role: 'user', text: 'middle'.repeat(40) },
      { role: 'assistant', text: 'newest answer' },
    ]), 'l', 100_000, null)
    const budget = sizeOf(afterOneDrop!)
    expect(sizeOf(roomy!)).toBeGreaterThan(budget)
    const result = retainScoredSession(snap, 'l', budget, null)
    // FIFO drops exactly one message, the oldest.
    expect(result?.stats.omittedMessages).toBe(1)
    expect(result?.data.conversation[0]?.text).toContain('middle')
    expect(result?.data.conversation.at(-1)?.text).toBe('newest answer')
    expect(sizeOf(result!)).toBeLessThanOrEqual(budget)
  })

  it('never drops checkpoint messages or the newest message whole', () => {
    const snap = snapshot([
      { role: 'user', text: 'checkpoint summary', checkpoint: true },
      { role: 'user', text: 'filler'.repeat(60) },
      { role: 'assistant', text: 'final' },
    ])
    const roomy = retainScoredSession(snap, 'l', 100_000, null)
    const budget = sizeOf(roomy!) - 350
    const result = retainScoredSession(snap, 'l', budget, null)
    const kept = result?.data.conversation.map(item => item.text) ?? []
    expect(kept.some(text => text.includes('checkpoint summary'))).toBe(true)
    expect(kept.at(-1)).toBe('final')
  })

  it('truncates the longest survivor with an omission notice once drops are exhausted', () => {
    const snap = snapshot([
      { role: 'user', text: 'checkpoint', checkpoint: true },
      { role: 'assistant', text: 'very long answer '.repeat(80) },
    ])
    const roomy = retainScoredSession(snap, 'l', 100_000, null)
    const budget = sizeOf(roomy!) - 800
    const result = retainScoredSession(snap, 'l', budget, null)
    expect(result).toBeDefined()
    expect(result?.stats.truncated).toBe(true)
    expect(result?.data.conversation.some(item => item.text.includes('omitted'))).toBe(true)
    expect(sizeOf(result!)).toBeLessThanOrEqual(budget)
  })

  it('returns undefined when even the protected content cannot fit', () => {
    const snap = snapshot([
      { role: 'user', text: 'checkpoint', checkpoint: true },
      { role: 'assistant', text: 'final' },
    ])
    expect(retainScoredSession(snap, 'l', 10, null)).toBeUndefined()
  })
})

describe('retainScoredSession — scored mode', () => {
  it('drops the low-value message where FIFO would drop the critical one', () => {
    // Hero case: the OLDEST message is the error evidence, the newer one is
    // noise. FIFO kills the evidence; scoring keeps it.
    const snap = snapshot([
      { role: 'user', text: 'ERROR: stack trace at auth.ts:88 — fix this' },
      { role: 'user', text: 'thanks! ' + 'chit chat '.repeat(30) },
      { role: 'assistant', text: 'working on it' },
    ])
    const roomy = retainScoredSession(snap, 'l', 100_000, null)
    const budget = sizeOf(roomy!) - 260
    const fifo = retainScoredSession(snap, 'l', budget, null)
    expect(fifo?.data.conversation.some(item => item.text.includes('ERROR'))).toBe(false)

    const scores = new Map([[0, 1.0], [1, 0.0]])
    const scored = retainScoredSession(snap, 'l', budget, scores)
    expect(scored?.data.conversation.some(item => item.text.includes('ERROR'))).toBe(true)
    expect(scored?.data.conversation.some(item => item.text.includes('chit chat'))).toBe(false)
    expect(sizeOf(scored!)).toBeLessThanOrEqual(budget)
  })

  it('truncates the low-value long survivor before the high-value one', () => {
    // No whole message is droppable (checkpoint + newest), so the budget is
    // met by truncation — and the low-value long survivor is cut first.
    const snap = snapshot([
      { role: 'user', text: 'critical decision: use option B', checkpoint: true },
      { role: 'assistant', text: 'low-value log spam '.repeat(60) },
    ])
    const roomy = retainScoredSession(snap, 'l', 100_000, null)
    const budget = sizeOf(roomy!) - 300
    const scores = new Map([[0, 1.0], [1, 0.0]])
    const scored = retainScoredSession(snap, 'l', budget, scores)
    expect(scored).toBeDefined()
    const truncated = scored!.data.conversation.find(item => item.text.includes('omitted'))
    expect(truncated?.text.includes('log spam')).toBe(true)
    expect(scored!.data.conversation[0]?.text).toBe('critical decision: use option B')
  })

  it('falls back toward FIFO order for unscored indices (neutral tiebreak)', () => {
    const snap = snapshot([
      { role: 'user', text: 'a'.repeat(60) },
      { role: 'user', text: 'b'.repeat(60) },
      { role: 'user', text: 'c'.repeat(60) },
      { role: 'assistant', text: 'final' },
    ])
    const roomy = retainScoredSession(snap, 'l', 100_000, null)
    const budget = sizeOf(roomy!) - 130
    // No scores map entries at all: every index neutral -> oldest dropped first.
    const scored = retainScoredSession(snap, 'l', budget, new Map())
    const fifo = retainScoredSession(snap, 'l', budget, null)
    expect(scored?.data.conversation.map(item => item.text)).toEqual(fifo?.data.conversation.map(item => item.text))
  })
})

describe('projection helpers', () => {
  it('projects only user and assistant text, marking checkpoints', () => {
    const snap = snapshot([
      { role: 'user', text: 'plain' },
      { role: 'user', text: 'ckpt', checkpoint: true },
      { role: 'assistant', text: 'answer' },
    ])
    const projected = projectConversation(snap)
    expect(projected.length).toBe(3)
    expect(projected[1]?.checkpoint).toBe(true)
    expect(projected[0]?.checkpoint).toBe(false)
  })

  it('selects only droppable indices, oldest first, capped', () => {
    const snap = snapshot([
      { role: 'user', text: 'one' },
      { role: 'user', text: 'ckpt', checkpoint: true },
      { role: 'user', text: 'two' },
      { role: 'user', text: 'three' },
      { role: 'assistant', text: 'latest' },
    ])
    const projected = projectConversation(snap)
    // Checkpoints and the newest message are never drop candidates.
    expect(scoreCandidateIndices(projected, 10)).toEqual([0, 2, 3])
    expect(scoreCandidateIndices(projected, 1)).toEqual([0])
  })

  it('bounds previews to the configured characters', () => {
    const snap = snapshot([{ role: 'user', text: 'x'.repeat(1000) }])
    const projected = projectConversation(snap)
    expect(previewAt(projected, 0, 300).length).toBe(300)
    expect(previewAt(projected, 5, 300)).toBe('')
  })
})
