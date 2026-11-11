/** Sidebar status icon: green for enabled, gray for disabled, yellow for recent fallback. Poll status and statistics every 30 seconds; on failure, omit the indicator quietly. */

import { t, useLocale } from './i18n.js'
import { useEffect, useState } from 'react'

/** Local mirror of the upstream SidebarPanelIconOwnerProps. */
interface PanelIconProps {
  /** Requested square size in pixels. */
  readonly size?: number
  /** Whether this panel is selected. */
  readonly active?: boolean
}

/** Lightweight combined status and statistics for the badge. */
interface IconBadge {
  readonly enabled: boolean
  readonly mode: 'shadow' | 'enforce'
  readonly degraded: number
  readonly calls: number
}

/** The status indicator does not require second-by-second polling. */
const POLL_MS = 30_000

export function JevPanelIcon({ size = 18, active = false }: PanelIconProps): React.JSX.Element {
  useLocale()
  const [badge, setBadge] = useState<IconBadge | null>(null)

  useEffect(() => {
    let cancelled = false
    const pull = async (): Promise<void> => {
      try {
        const [sr, tr] = await Promise.all([
          fetch('/api/jev-interceptor/status', { headers: { 'cache-control': 'no-store' } }),
          fetch('/api/jev-interceptor/stats', { headers: { 'cache-control': 'no-store' } }),
        ])
        if (!sr.ok || !tr.ok) return
        const s = await sr.json() as { enabled: boolean; mode: 'shadow' | 'enforce' }
        const stats = await tr.json()
        let degraded = 0
        let calls = 0
        for (const t of Array.isArray(stats) ? stats as Array<{ degraded?: number; calls?: number }> : []) {
          degraded += t.degraded ?? 0
          calls += t.calls ?? 0
        }
        if (!cancelled) setBadge({ enabled: s.enabled, mode: s.mode, degraded, calls })
      } catch {
        // Quietly omit the indicator when polling fails.
      }
    }
    void pull()
    const timer = setInterval(() => { void pull() }, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  // Official theme tokens keep the indicator distinct from its background ring.
  const dot = badge === null
    ? undefined
    : !badge.enabled ? 'var(--dsw-alias-label-secondary,#8a8a8a)'
      : badge.degraded > 0 ? 'var(--dsw-alias-state-warn-primary,#d97706)'
        : 'var(--dsw-alias-state-success-primary,#16a34a)'
  const title = t('panel.jevDecisions') + (badge === null ? '' : ' · '
    + (badge.enabled
      ? t(badge.mode === 'shadow' ? 'panel.runningShadowMode' : 'panel.runningEnforceMode')
      : t('panel.disabled'))
    + ' · ' + t('panel.totalDecisions') + ': ' + String(badge.calls)
    + (badge.degraded > 0 ? ' · ' + t('panel.fallbacks', { v0: String(badge.degraded) }) : ''))
  const dotSize = Math.max(6, Math.round(size * 0.33))

  return (
    <span title={title} style={{
      position: 'relative',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: size,
      height: size,
    }}>
      <span style={{
        fontSize: Math.round(size * 0.72),
        lineHeight: '1',
        // Desaturate inactive icons so the status indicator remains prominent.
        opacity: badge !== null && !badge.enabled ? 0.45 : active ? 1 : 0.8,
        filter: active ? 'none' : 'grayscale(30%)',
      }}>⚡</span>
      {dot !== undefined && (
        <span style={{
          position: 'absolute',
          top: -1,
          right: -1,
          width: dotSize,
          height: dotSize,
          borderRadius: '50%',
          background: dot,
          boxShadow: '0 0 0 1.5px var(--dsw-alias-bg-base,#000)',
        }} />
      )}
    </span>
  )
}
