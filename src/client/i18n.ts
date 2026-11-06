import { useSyncExternalStore } from 'react'
import { translate, type Locale, type MessageKey } from '../localization.js'

const STORAGE_KEY = 'dsh-jev-interceptor:locale'
const listeners = new Set<() => void>()

export function detectLocale(saved: string | null, browserLanguage: string): Locale {
  if (saved === 'en' || saved === 'zh') return saved
  return /^zh(?:-|$)/i.test(browserLanguage) ? 'zh' : 'en'
}

function initialLocale(): Locale {
  let saved: string | null = null
  try { saved = localStorage.getItem(STORAGE_KEY) } catch { /* Storage may be unavailable. */ }
  return detectLocale(saved, typeof navigator === 'undefined' ? 'en' : navigator.language)
}

let locale = initialLocale()
export function getLocale(): Locale { return locale }
export function setLocale(next: Locale): void {
  locale = next
  try { localStorage.setItem(STORAGE_KEY, next) } catch { /* Keep switching available without storage. */ }
  for (const notify of listeners) notify()
}
function subscribe(notify: () => void): () => void {
  listeners.add(notify)
  return () => { listeners.delete(notify) }
}
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, () => 'en')
}
export function t(key: MessageKey, values?: Record<string, string | number>): string {
  return translate(locale, key, values)
}
