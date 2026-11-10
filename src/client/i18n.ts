/**
 * Browser-side translations for the Jev panel.
 *
 * The selected language is the GUI's own preference, owned by the platform
 * `locale` service: this module binds to that service when the plugin mounts,
 * reads the active language from it, and switches it through
 * `ctx.locale.setLocale`. The Host persists that preference as
 * `locale.preference`, which is exactly what the plugin's Host half reads for
 * approval reasons, notices, and command output — so the panel and every
 * generated message always agree.
 *
 * Without a bound service (unit tests, non-browser runs) the module keeps a
 * process-local language so the pure helpers stay usable.
 */

import { useSyncExternalStore } from 'react'
import { translate, type Locale, type MessageKey } from '../localization.js'

/**
 * Structural seat of the platform locale service; the real `Context.locale`
 * satisfies it. Declared locally so this module carries no runtime dependency
 * on the client-locale package.
 */
export interface LocaleRuntimeSeat {
  getLocale(): { readonly active: string }
  setLocale(id: string): void
  subscribe(listener: () => void): () => void
}

const listeners = new Set<() => void>()
let seat: LocaleRuntimeSeat | undefined
let standalone: Locale = 'en'

/**
 * Map a language id onto a shipped catalog.
 * @param id - active GUI language id (e.g. `zh-CN`, `en`, or a pack id).
 * @returns `zh` for Chinese ids, English for everything else (the catalog fallback).
 */
export function normalizeLocaleId(id: string): Locale {
  return /^zh(?:-|$)/i.test(id) ? 'zh' : 'en'
}

/**
 * Attach the platform locale service; every switch it publishes re-renders the panel.
 * @param runtime - the client `locale` service from the Cordis context.
 * @returns disposer restoring the standalone mode.
 */
export function bindLocale(runtime: LocaleRuntimeSeat): () => void {
  seat = runtime
  const unsubscribe = runtime.subscribe(() => {
    for (const notify of listeners) notify()
  })
  // The platform may resolve the Host preference after this binding mounts.
  for (const notify of listeners) notify()
  return () => {
    unsubscribe()
    if (seat === runtime) seat = undefined
  }
}

/** Current panel language: the GUI's active language, or the standalone fallback. */
export function getLocale(): Locale {
  return seat === undefined ? standalone : normalizeLocaleId(seat.getLocale().active)
}

/** Switch the GUI language; the platform persists it and notifies every subscriber. */
export function setLocale(next: Locale): void {
  if (seat !== undefined) {
    seat.setLocale(next)
    return
  }
  standalone = next
  for (const notify of listeners) notify()
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify)
  return () => { listeners.delete(notify) }
}

/** Re-render on language switches (the platform publishes them). */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, () => 'en')
}

/** Translate one panel message in the current language. */
export function t(key: MessageKey, values?: Record<string, string | number>): string {
  return translate(getLocale(), key, values)
}
