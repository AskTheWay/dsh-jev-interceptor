/**
 * Host-side language resolution for text this plugin generates outside the
 * browser: approval reasons, plugin notices, command output, and reports.
 *
 * The web GUI persists the user's language in the Host settings document as
 * `locale.preference` (the same preference the platform language selector
 * writes), so the host can read it without asking the browser. An explicit
 * plugin `locale` config wins over that preference, which makes headless and
 * non-web compositions configurable; `auto` (the default) follows the GUI.
 *
 * Reads are cached briefly: the guard asks for a reason on every escalated
 * tool call, and the settings document walk is not free.
 * @module dsh-jev-interceptor/host-locale
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Locale } from './localization.js'

/** Plugin-level language choice: follow the GUI, or pin one language. */
export type LocaleSetting = 'auto' | Locale

/** Settings namespace owned by the platform locale plugin (entry id `locale`). */
export const LOCALE_SETTINGS_NAMESPACE = 'locale'

/** Field carrying the explicit selection inside that namespace. */
export const LOCALE_PREFERENCE_FIELD = 'preference'

/** The language the plugin falls back to when neither source names one. */
export const FALLBACK_LOCALE: Locale = 'en'

/** How long a host preference read is reused, milliseconds. */
const DEFAULT_CACHE_MS = 2000

/**
 * Map one language tag onto a shipped catalog.
 * @param value - raw tag from settings or config (e.g. `zh-CN`).
 * @returns the matching locale, or `undefined` when unsupported.
 */
export function normalizeLocale(value: unknown): Locale | undefined {
  if (typeof value !== 'string') return undefined
  const tag = value.trim().toLowerCase()
  if (tag === 'zh' || tag.startsWith('zh-')) return 'zh'
  if (tag === 'en' || tag.startsWith('en-')) return 'en'
  return undefined
}

/**
 * Narrow an arbitrary config value to a supported plugin language choice.
 * @param value - raw config value.
 * @returns the supported setting, or `undefined` for anything else.
 */
export function normalizeLocaleSetting(value: unknown): LocaleSetting | undefined {
  if (value === 'auto') return 'auto'
  return normalizeLocale(value)
}

/** Resolver inputs; every ambient read is injected for tests. */
export interface LocaleResolverOptions {
  /** Explicit plugin setting; `auto` or absence defers to the host. */
  readonly configured: () => LocaleSetting | undefined
  /** Reads the GUI's persisted `locale.preference` (unvalidated). */
  readonly hostPreference: () => unknown
  /** Last resort when neither source is usable (default English). */
  readonly fallback?: Locale
  /** Host read reuse window in milliseconds (default 2000; 0 disables). */
  readonly cacheMs?: number
  readonly now?: () => number
}

/**
 * Build the per-message locale resolver.
 * @param options - configured setting, host reader, and clock.
 * @returns a function returning the language every generated text uses.
 */
export function createLocaleResolver(options: LocaleResolverOptions): () => Locale {
  const fallback = options.fallback ?? FALLBACK_LOCALE
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS
  const now = options.now ?? Date.now
  let cachedAt = Number.NEGATIVE_INFINITY
  let cached: Locale | undefined
  let initialized = false

  const readHost = (): Locale | undefined => {
    const at = now()
    if (!initialized || cacheMs <= 0 || at < cachedAt || at - cachedAt >= cacheMs) {
      cached = normalizeLocale(options.hostPreference())
      cachedAt = at
      initialized = true
    }
    return cached
  }

  return () => {
    const configured = normalizeLocaleSetting(options.configured())
    if (configured !== undefined && configured !== 'auto') return configured
    return readHost() ?? fallback
  }
}

/** Structured subset of the settings service this module consumes. */
interface SettingsDescribe {
  describe?: (options?: { redactSecrets?: boolean }) => readonly {
    ns?: string
    value?: unknown
  }[]
}

/**
 * Read the GUI language preference from the Host settings document.
 * @param ctx - plugin context; the settings service is resolved lazily.
 * @returns the raw `locale.preference` value, or `undefined` when unreadable.
 */
export function hostLocalePreference(ctx: Context): () => unknown {
  return () => {
    try {
      const settings = ctx.get('settings') as SettingsDescribe | undefined
      if (settings === undefined || typeof settings.describe !== 'function') return undefined
      const descriptor = settings.describe({ redactSecrets: true })
        .find(candidate => candidate.ns === LOCALE_SETTINGS_NAMESPACE)
      const value = descriptor?.value
      if (typeof value !== 'object' || value === null) return undefined
      return (value as Record<string, unknown>)[LOCALE_PREFERENCE_FIELD]
    } catch {
      // An unreadable settings document must never break a tool call: fall back.
      return undefined
    }
  }
}
