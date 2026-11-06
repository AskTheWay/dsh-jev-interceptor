import { afterEach, describe, expect, it, vi } from 'vitest'
import en from '../src/locales/en.json' with { type: 'json' }
import zh from '../src/locales/zh.json' with { type: 'json' }
import { translate, type MessageKey } from '../src/localization.js'
import { detectLocale, getLocale, setLocale, t } from '../src/client/i18n.js'

const placeholders = (text: string): string[] => (text.match(/\{\w+\}/g) ?? []).sort()

afterEach(() => { vi.unstubAllGlobals(); setLocale('en') })

describe('localization catalogs', () => {
  it('has matching, nonempty messages and placeholders in both languages', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en) as MessageKey[]) {
      expect(en[key].trim(), key).not.toBe('')
      expect(zh[key].trim(), key).not.toBe('')
      expect(placeholders(zh[key]), key).toEqual(placeholders(en[key]))
      expect(en[key], key).not.toMatch(/\p{Script=Han}/u)
    }
  })

  it('falls back to the key for an unknown message', () => {
    expect(translate('en', 'missing.message' as MessageKey)).toBe('missing.message')
  })

  it('interpolates values literally, including replacement characters', () => {
    expect(translate('en', 'panel.saveFailed', { v0: '$& {v1}' })).toBe('Save failed: $& {v1}')
    expect(translate('zh', 'panel.saveFailed', { v0: 'HTTP 401' })).toBe('保存失败：HTTP 401')
  })
})

describe('locale selection', () => {
  it('prioritizes saved preferences and falls back to English for unsupported languages', () => {
    expect(detectLocale('en', 'zh-CN')).toBe('en')
    expect(detectLocale('zh', 'en-US')).toBe('zh')
    expect(detectLocale(null, 'zh-TW')).toBe('zh')
    expect(detectLocale(null, 'ru-RU')).toBe('en')
    expect(detectLocale('invalid', 'en-US')).toBe('en')
  })

  it('switches translations and persists the language', () => {
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { setItem })
    setLocale('zh')
    expect(t('panel.refresh')).toBe('刷新')
    expect(setItem).toHaveBeenCalledWith('dsh-jev-interceptor:locale', 'zh')
    setLocale('en')
    expect(t('panel.refresh')).toBe('Refresh')
    expect(getLocale()).toBe('en')
  })

  it('keeps switching available when browser storage is blocked', () => {
    vi.stubGlobal('localStorage', { setItem: () => { throw new Error('blocked') } })
    expect(() => { setLocale('zh') }).not.toThrow()
    expect(t('panel.refresh')).toBe('刷新')
  })
})
