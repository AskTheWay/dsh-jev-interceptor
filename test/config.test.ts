import { describe, expect, it } from 'vitest'
import { resolveEndpoint, resolveSettings, DEFAULTS } from '../src/config.js'

describe('resolveSettings timeoutMs', () => {
  it('defaults to 1500 for the typesafe provider', () => {
    expect(resolveSettings({ provider: 'typesafe' }).timeoutMs).toBe(1500)
    expect(resolveSettings({}).timeoutMs).toBe(DEFAULTS.timeoutMs)
  })

  it('widens to 3000 for openrouter unless explicitly configured', () => {
    expect(resolveSettings({ provider: 'openrouter' }).timeoutMs).toBe(3000)
    expect(resolveSettings({ provider: 'openrouter', timeoutMs: 800 }).timeoutMs).toBe(800)
  })
})

describe('resolveEndpoint', () => {
  it('keeps presets per provider', () => {
    expect(resolveEndpoint({ provider: 'openrouter' }).endpoint).toContain('openrouter.ai')
    expect(resolveEndpoint({ provider: 'typesafe' }).endpoint).toContain('typesafe.ai')
  })
})
