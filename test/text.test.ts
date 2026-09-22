import { describe, expect, it } from 'vitest'
import { canonicalArguments, digestRecent, headTailPreview } from '../src/text.js'

describe('headTailPreview', () => {
  it('passes short text through unchanged', () => {
    expect(headTailPreview('short', 10, 10)).toBe('short')
  })

  it('keeps head and tail and marks the skipped middle with its size', () => {
    const text = 'a'.repeat(100)
    const preview = headTailPreview(text, 10, 5)
    expect(preview.startsWith('aaaaaaaaaa')).toBe(true)
    expect(preview.endsWith('aaaaa')).toBe(true)
    expect(preview.includes('[85 chars]')).toBe(true)
  })

  it('is deterministic for equal bounds', () => {
    expect(headTailPreview('x'.repeat(50), 10, 10)).toBe(headTailPreview('x'.repeat(50), 10, 10))
  })
})

describe('canonicalArguments', () => {
  it('canonicalizes object argument order', () => {
    expect(canonicalArguments({ b: 1, a: 2 })).toBe('{"b":1,"a":2}')
  })

  it('passes raw strings through', () => {
    expect(canonicalArguments('already-json')).toBe('already-json')
  })
})

describe('digestRecent', () => {
  it('keeps only the trailing messages with bounded text', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(500) }] },
      { role: 'user', content: [{ type: 'text', text: 'last' }] },
    ]
    const digest = digestRecent(messages, 2, 100)
    expect(digest.length).toBe(2)
    expect(digest[0]?.role).toBe('assistant')
    expect(digest[0]?.text.length).toBeLessThanOrEqual(100)
    expect(digest[1]?.text).toBe('last')
  })

  it('marks tool payloads structurally', () => {
    const digest = digestRecent([
      { role: 'user', content: [{ type: 'tool-result' }] },
    ], 1, 100)
    expect(digest[0]?.hasToolResult).toBe(true)
    expect(digest[0]?.text).toBe('[tool-result]')
  })
})
