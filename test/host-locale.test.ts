import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  createLocaleResolver,
  hostLocalePreference,
  normalizeLocale,
  normalizeLocaleSetting,
  type LocaleSetting,
} from '../src/host-locale.js'

function fakeContext(settings: unknown): Context {
  return { get: () => settings } as unknown as Context
}

describe('normalizeLocale', () => {
  it('accepts language tags and rejects everything else', () => {
    expect(normalizeLocale('zh')).toBe('zh')
    expect(normalizeLocale('zh-CN')).toBe('zh')
    expect(normalizeLocale('en-US')).toBe('en')
    expect(normalizeLocale('ja')).toBeUndefined()
    expect(normalizeLocale(42)).toBeUndefined()
    expect(normalizeLocale(null)).toBeUndefined()
  })

  it('keeps the auto setting distinct from a pinned language', () => {
    expect(normalizeLocaleSetting('auto')).toBe('auto')
    expect(normalizeLocaleSetting('zh')).toBe('zh')
    expect(normalizeLocaleSetting('ru')).toBeUndefined()
  })
})

describe('hostLocalePreference', () => {
  it('reads locale.preference from the Host settings document', () => {
    const read = hostLocalePreference(fakeContext({
      describe: () => [
        { ns: 'jev-interceptor', value: { enabled: true } },
        { ns: 'locale', value: { preference: 'zh-CN' } },
      ],
    }))
    expect(read()).toBe('zh-CN')
  })

  it('stays quiet when the settings service is absent, malformed, or throws', () => {
    expect(hostLocalePreference(fakeContext(undefined))()).toBeUndefined()
    expect(hostLocalePreference(fakeContext({}))()).toBeUndefined()
    expect(hostLocalePreference(fakeContext({ describe: () => 'nope' }))()).toBeUndefined()
    expect(hostLocalePreference(fakeContext({
      describe: () => { throw new Error('settings down') },
    }))()).toBeUndefined()
  })
})

describe('createLocaleResolver', () => {
  const resolver = (configured: LocaleSetting | undefined, host: unknown, now?: () => number) =>
    createLocaleResolver({
      configured: () => configured,
      hostPreference: () => host,
      ...(now === undefined ? {} : { now }),
    })

  it('lets an explicit plugin setting win over the GUI preference', () => {
    expect(resolver('en', 'zh')()).toBe('en')
    expect(resolver('zh', 'en')()).toBe('zh')
  })

  it('follows the GUI preference under auto and falls back to English', () => {
    expect(resolver('auto', 'zh-TW')()).toBe('zh')
    expect(resolver(undefined, 'en')()).toBe('en')
    expect(resolver('auto', 'ja')()).toBe('en')
    expect(resolver('auto', undefined)()).toBe('en')
  })

  it('caches the Host read and refreshes it after the cache window', () => {
    let time = 0
    const hostPreference = vi.fn(() => 'zh')
    const resolve = createLocaleResolver({
      configured: () => 'auto',
      hostPreference,
      cacheMs: 1000,
      now: () => time,
    })
    expect(resolve()).toBe('zh')
    expect(resolve()).toBe('zh')
    expect(hostPreference).toHaveBeenCalledTimes(1)
    time = 1000
    hostPreference.mockReturnValue('en')
    expect(resolve()).toBe('en')
    expect(hostPreference).toHaveBeenCalledTimes(2)
  })

  it('does not cache when the window is zero', () => {
    const hostPreference = vi.fn(() => 'zh')
    const resolve = createLocaleResolver({
      configured: () => 'auto',
      hostPreference,
      cacheMs: 0,
    })
    resolve()
    resolve()
    expect(hostPreference).toHaveBeenCalledTimes(2)
  })
})
