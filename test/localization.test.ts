import { afterEach, describe, expect, it, vi } from 'vitest'
import en from '../src/locales/en.json' with { type: 'json' }
import zh from '../src/locales/zh.json' with { type: 'json' }
import { translate, type MessageKey } from '../src/localization.js'
import { bindLocale, getLocale, normalizeLocaleId, setLocale, t } from '../src/client/i18n.js'

const placeholders = (text: string): string[] => (text.match(/\{\w+\}/g) ?? []).sort()

afterEach(() => { setLocale('en') })

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

  it('localizes host-generated guard reasons without losing the protocol prefix', () => {
    expect(translate('en', 'msg.guardMediumAsk', { v0: 'risk=medium 0.80' }))
      .toContain('jev-guard: medium-risk call needs human confirmation (risk=medium 0.80)')
    expect(translate('zh', 'msg.guardMediumAsk', { v0: 'risk=medium 0.80' }))
      .toContain('jev-guard: 中风险调用，需人工确认（risk=medium 0.80）')
  })
})

describe('locale selection', () => {
  it('maps GUI language ids onto the shipped catalogs', () => {
    expect(normalizeLocaleId('zh')).toBe('zh')
    expect(normalizeLocaleId('zh-CN')).toBe('zh')
    expect(normalizeLocaleId('en-US')).toBe('en')
    expect(normalizeLocaleId('ru-RU')).toBe('en')
    expect(normalizeLocaleId('ja')).toBe('en')
  })

  it('switches translations without a platform locale service', () => {
    setLocale('zh')
    expect(t('panel.refresh')).toBe('刷新')
    setLocale('en')
    expect(t('panel.refresh')).toBe('Refresh')
    expect(getLocale()).toBe('en')
  })

  it('reads and writes the bound platform locale instead of keeping its own copy', () => {
    let active = 'en'
    let listener: (() => void) | undefined
    const runtime = {
      getLocale: () => ({ active }),
      setLocale: vi.fn((next: string) => {
        active = next
        listener?.()
      }),
      subscribe: (notify: () => void) => {
        listener = notify
        return () => { listener = undefined }
      },
    }
    const dispose = bindLocale(runtime)
    setLocale('zh')
    expect(runtime.setLocale).toHaveBeenCalledWith('zh')
    expect(getLocale()).toBe('zh')
    expect(t('panel.refresh')).toBe('刷新')
    // A switch made elsewhere in the GUI reaches the panel too.
    active = 'en'
    listener?.()
    expect(getLocale()).toBe('en')
    expect(t('panel.refresh')).toBe('Refresh')
    dispose()
    expect(getLocale()).toBe('en')
  })
})
