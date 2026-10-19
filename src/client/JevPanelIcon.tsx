/**
 * Jev 侧栏面板图标：动态状态徽章。
 *
 * 侧栏架构没有自由内容区（中段归 ui-workspace 的会话列表），完整明细与
 * 校准报告住在主面板；这个图标位是侧栏唯一由插件渲染的常驻位——把它
 * 做成活的状态灯：⚡ + 状态点（绿=运行 / 灰=停用 / 黄=最近有降级），
 * 悬停 title 带轻量摘要。数据自取（status + stats），30s 轮询；拉取失败
 * 静默退化为无状态点（UI 版 fail-closed，绝不闪红干扰）。
 */

import { useEffect, useState } from 'react'

/** 侧栏图标 owner props 的本地镜像（上游 SidebarPanelIconOwnerProps）。 */
interface PanelIconProps {
  /** 请求的方形边长像素。 */
  readonly size?: number
  /** 该面板当前是否被选中。 */
  readonly active?: boolean
}

/** 徽章数据（status + stats 的轻量合并）。 */
interface IconBadge {
  readonly enabled: boolean
  readonly mode: 'shadow' | 'enforce'
  readonly degraded: number
  readonly calls: number
}

/** 轮询间隔：状态灯不需要秒级新鲜度。 */
const POLL_MS = 30_000

export function JevPanelIcon({ size = 18, active = false }: PanelIconProps): React.JSX.Element {
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
        // 静默：徽章退化为无状态点。
      }
    }
    void pull()
    const timer = setInterval(() => { void pull() }, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const dot = badge === null
    ? undefined
    : !badge.enabled ? '#808080'
      : badge.degraded > 0 ? '#fbbf24'
        : '#4ade80'
  const title = badge === null ? 'Jev 决策'
    : 'Jev 决策 · '
      + (badge.enabled
        ? (badge.mode === 'shadow' ? '运行中（观察）' : '运行中（执行）')
        : '已停用')
      + ` · 统计窗口 ${String(badge.calls)} 次决策`
      + (badge.degraded > 0 ? ` · ${String(badge.degraded)} 次降级` : '')
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
        // 停用或未选中时整体降饱和，让状态点成为唯一强信号。
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
          boxShadow: '0 0 0 1.5px rgba(0,0,0,.35)',
        }} />
      )}
    </span>
  )
}
