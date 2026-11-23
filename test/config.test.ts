import { describe, expect, it } from 'vitest'
import { Config, resolveEndpoint, resolveSettings, DEFAULTS } from '../src/config.js'

describe('resolveSettings timeoutMs', () => {
  it('defaults to 1500 for the typesafe provider', () => {
    expect(resolveSettings({ provider: 'typesafe' }).timeoutMs).toBe(1500)
    expect(resolveSettings({}).timeoutMs).toBe(DEFAULTS.timeoutMs)
  })

  it('widens to 3000 for openrouter unless explicitly configured', () => {
    expect(resolveSettings({ provider: 'openrouter' }).timeoutMs).toBe(3000)
    expect(resolveSettings(Config({ provider: 'openrouter' })).timeoutMs).toBe(3000)
    expect(resolveSettings({ provider: 'openrouter', timeoutMs: 800 }).timeoutMs).toBe(800)
  })
})

describe('resolveEndpoint', () => {
  it('keeps presets per provider', () => {
    const openrouter = Config({ provider: 'openrouter' })
    expect(resolveEndpoint(openrouter)).toMatchObject({
      endpoint: 'https://openrouter.ai/api/v1/systemone',
      model: 'typesafe/jev-1.14-20261014',
    })
    expect(resolveSettings(openrouter).apiKeyEnv).toBe('OPENROUTER_API_KEY')
    expect(resolveEndpoint({ provider: 'typesafe' })).toMatchObject({
      endpoint: 'https://api.typesafe.ai/v1/systemone',
      model: 'jev-1.14.0',
    })
  })

  it('preserves an explicitly configured legacy endpoint and credential reference', () => {
    const endpoint = 'https://openrouter.ai/api/alpha/decisions'
    const config = Config({ provider: 'openrouter', endpoint, apiKeyEnv: 'MY_DECISION_KEY' })
    expect(resolveEndpoint(config)).toMatchObject({ endpoint, model: '~typesafe/jev-latest' })
    expect(resolveSettings(config).apiKeyEnv).toBe('MY_DECISION_KEY')
  })
})
