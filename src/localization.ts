import en from './locales/en.json' with { type: 'json' }
import zh from './locales/zh.json' with { type: 'json' }

export type Locale = 'en' | 'zh'
export type MessageKey = keyof typeof en

/** UI copy uses a neutral, concise register; product names and identifiers stay intact. */
export function translate(locale: Locale, key: MessageKey, values: Record<string, string | number> = {}): string {
  const catalog: Partial<Record<MessageKey, string>> = locale === 'zh' ? zh : en
  const message = catalog[key] ?? en[key] ?? key
  return message.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : placeholder)
}
