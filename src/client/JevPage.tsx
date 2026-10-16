/**
 * Jev Interceptor 主面板：配置 + 状态 + 决策统计。
 *
 * 数据来源：宿主半 /api/jev-interceptor/status 和 /api/jev-interceptor/stats，
 * fetch 后渲染。配置变更通过 /api/jev-interceptor/config PUT 持久化。
 */

import { useCallback, useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** 宿主半返回的配置状态。 */
interface JevStatus {
  enabled: boolean
  mode: 'shadow' | 'enforce'
  provider: string
  model: string
  keyConfigured: boolean
  keySource: 'config' | 'credentials' | 'env' | 'none'
  guardEnabled: boolean
  preapproveEnabled: boolean
}

/** 宿主半返回的统计摘要（每 tag 一条）。 */
interface TagSummary {
  tag: string
  calls: number
  degraded: number
  cached: number
  actions: Record<string, number>
  latencyP50?: number
  latencyP95?: number
  costUsd?: number
  inputTokens?: number
  agreementBuckets?: Record<string, number>
}

type JevPageProps = PropsRuntime<'main'>

const SECTION: React.CSSProperties = {
  margin: '16px 0', padding: '12px', border: '1px solid rgba(128,128,128,.35)',
  borderRadius: '8px', background: 'rgba(128,128,128,.06)',
}
const LABEL: React.CSSProperties = { fontSize: '13px', color: 'rgba(128,128,128,.8)', marginBottom: '4px' }
const INPUT: React.CSSProperties = {
  width: '100%', padding: '6px 10px', borderRadius: '4px',
  border: '1px solid rgba(128,128,128,.4)', fontSize: '14px', background: 'transparent',
  color: 'inherit',
}
const BTN: React.CSSProperties = {
  padding: '6px 16px', borderRadius: '6px', border: 'none', cursor: 'pointer',
  fontSize: '14px', fontWeight: 500,
}
const STAT_CARD: React.CSSProperties = {
  flex: '1', minWidth: '100px', padding: '10px 12px', borderRadius: '6px',
  border: '1px solid rgba(128,128,128,.3)', textAlign: 'center',
}
const STAT_LABEL: React.CSSProperties = { fontSize: '11px', color: 'rgba(128,128,128,.7)' }
const STAT_VALUE: React.CSSProperties = { fontSize: '20px', fontWeight: 600, marginTop: '4px' }

const TAG_LABELS: Record<string, string> = {
  guard: '守门人（风险分类）',
  preapprove: '预批（自动审批）',
  'session-reference': '会话保留打分',
  'approval-loop': '审批一致率',
}

const ACTION_LABELS: Record<string, string> = {
  delegate: '放行', ask: '转人工', deny: '拒绝', 'auto-approve': '自动批',
  human: '人工', degraded: '降级', agreement: '一致率',
}

function Bar({ value, total, label }: { value: number; total: number; label: string }): React.JSX.Element {
  const width = total > 0 ? Math.round((value / total) * 100) : 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', margin: '2px 0' }}>
      <span style={{ width: '70px', fontSize: '11px', color: 'rgba(128,128,128,.7)', textAlign: 'right' }}>{label}</span>
      <div style={{ flex: '1', height: '8px', borderRadius: '4px', background: 'rgba(128,128,128,.2)', overflow: 'hidden' }}>
        <div style={{ width: `${width}%`, height: '100%', borderRadius: '4px', background: 'rgba(99,102,241,.7)' }} />
      </div>
      <span style={{ width: '30px', fontSize: '11px', color: 'rgba(128,128,128,.8)' }}>{value}</span>
    </div>
  )
}

export function JevPage(_props: JevPageProps): React.JSX.Element {
  const [status, setStatus] = useState<JevStatus | null>(null)
  const [stats, setStats] = useState<TagSummary[]>([])
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  const refresh = useCallback(async () => {
    try {
      const [statusRes, statsRes] = await Promise.all([
        fetch('/api/jev-interceptor/status', { headers: { 'cache-control': 'no-store' } }),
        fetch('/api/jev-interceptor/stats', { headers: { 'cache-control': 'no-store' } }),
      ])
      if (statusRes.ok) setStatus(await statusRes.json() as JevStatus)
      if (statsRes.ok) {
        const raw = await statsRes.json()
        setStats(Array.isArray(raw) ? raw as TagSummary[] : [])
      }
    } catch {
      // Network error; panel degrades to last-known data
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const saveKey = useCallback(async () => {
    if (apiKey.trim().length < 10) { setMessage('Key 长度需大于 10 个字符'); return }
    setSaving(true)
    setMessage('')
    try {
      const res = await fetch('/api/jev-interceptor/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      })
      if (res.ok) { setMessage('✅ 已保存'); setApiKey(''); void refresh() }
      else setMessage(`保存失败: HTTP ${String(res.status)}`)
    } catch { setMessage('保存失败：网络错误') } finally { setSaving(false) }
  }, [apiKey, refresh])

  const toggleMode = useCallback(async () => {
    if (status === null) return
    const next = status.mode === 'shadow' ? 'enforce' : 'shadow'
    try {
      const res = await fetch('/api/jev-interceptor/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: next }),
      })
      if (res.ok) { void refresh() }
    } catch { /* degrade */ }
  }, [status, refresh])

  const toggleEnabled = useCallback(async () => {
    if (status === null) return
    const next = !status.enabled
    try {
      const res = await fetch('/api/jev-interceptor/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      if (res.ok) { void refresh() }
    } catch { /* degrade */ }
  }, [status, refresh])

  return (
    <div style={{ padding: '16px', maxWidth: '640px', margin: '0 auto' }}>
      <h2 style={{ margin: '0 0 16px', fontSize: '18px' }}>⚡ Jev Interceptor</h2>

      {/* 状态卡 */}
      {status !== null && (
        <div style={SECTION}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
            <span style={{ fontSize: '13px', color: status.enabled ? '#22c55e' : '#94a3b8', fontWeight: 600 }}>
              {status.enabled ? '✅ 运行中' : '⏸️ 已停用'}
            </span>
            <span style={{ fontSize: '12px', color: 'rgba(128,128,128,.7)' }}>{status.mode}</span>
            <span style={{ fontSize: '12px', color: status.keyConfigured ? '#22c55e' : '#ef4444' }}>
              {status.keyConfigured ? `Key ✅ (${status.keySource})` : 'Key ❌'}
            </span>
            <button style={{ ...BTN, marginLeft: 'auto', background: 'rgba(99,102,241,.15)', color: '#818cf8' }} onClick={toggleEnabled}>
              {status.enabled ? '停用' : '启用'}
            </button>
            <button style={{ ...BTN, background: status.mode === 'enforce' ? 'rgba(239,68,68,.15)' : 'rgba(99,102,241,.15)', color: status.mode === 'enforce' ? '#f87171' : '#818cf8' }} onClick={toggleMode}>
              {status.mode === 'shadow' ? '切 enforce' : '切 shadow'}
            </button>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <div style={{ ...STAT_CARD }}>
              <div style={STAT_LABEL}>Provider</div>
              <div style={{ ...STAT_VALUE, fontSize: '14px' }}>{status.provider}</div>
            </div>
            <div style={{ ...STAT_CARD }}>
              <div style={STAT_LABEL}>模型</div>
              <div style={{ ...STAT_VALUE, fontSize: '14px' }}>{status.model}</div>
            </div>
            <div style={{ ...STAT_CARD }}>
              <div style={STAT_LABEL}>守门人</div>
              <div style={{ ...STAT_VALUE, fontSize: '14px' }}>{status.guardEnabled ? '✅' : '❌'}</div>
            </div>
            <div style={{ ...STAT_CARD }}>
              <div style={STAT_LABEL}>预批</div>
              <div style={{ ...STAT_VALUE, fontSize: '14px' }}>{status.preapproveEnabled ? '✅' : '❌'}</div>
            </div>
          </div>
        </div>
      )}

      {/* API Key 配置 */}
      <div style={SECTION}>
        <div style={LABEL}>API Key</div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            type="password"
            style={{ ...INPUT, flex: '1' }}
            placeholder={status?.keyConfigured === true ? '已配置（输入新值覆盖）' : 'sk-or-v1-... 或 sk-...'}
            value={apiKey}
            onChange={(e) => { setApiKey(e.target.value) }}
          />
          <button style={{ ...BTN, background: 'rgba(99,102,241,.2)', color: '#818cf8' }} disabled={saving} onClick={saveKey}>
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
        {message !== '' && <div style={{ marginTop: '6px', fontSize: '12px' }}>{message}</div>}
      </div>

      {/* 决策统计 */}
      {stats.length > 0 && (
        <div style={SECTION}>
          <div style={{ ...LABEL, marginBottom: '8px' }}>决策统计（最近 200 条）</div>
          {stats.map((s) => (
            <div key={s.tag} style={{ marginBottom: '12px' }}>
              <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>
                {TAG_LABELS[s.tag] ?? s.tag}
              </div>
              <div style={{ display: 'flex', gap: '6px', marginBottom: '6px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '11px', color: 'rgba(128,128,128,.7)' }}>调用 {s.calls}</span>
                <span style={{ fontSize: '11px', color: 'rgba(128,128,128,.7)' }}>降级 {s.degraded}</span>
                <span style={{ fontSize: '11px', color: 'rgba(128,128,128,.7)' }}>缓存 {s.cached}</span>
                {s.latencyP50 !== undefined && <span style={{ fontSize: '11px', color: 'rgba(128,128,128,.7)' }}>p50 {s.latencyP50}ms</span>}
                {s.costUsd !== undefined && s.costUsd > 0 && <span style={{ fontSize: '11px', color: 'rgba(128,128,128,.7)' }}>${s.costUsd.toFixed(6)}</span>}
              </div>
              {Object.entries(s.actions).map(([action, n]) => (
                <Bar key={action} value={n} total={s.calls} label={ACTION_LABELS[action] ?? action} />
              ))}
              {s.agreementBuckets !== undefined && Object.keys(s.agreementBuckets).length > 0 && (
                <div style={{ marginTop: '6px', padding: '6px', borderRadius: '4px', background: 'rgba(99,102,241,.08)' }}>
                  {Object.entries(s.agreementBuckets).map(([bucket, n]) => (
                    <div key={bucket} style={{ fontSize: '11px', color: 'rgba(128,128,128,.8)' }}>
                      {bucket}: {n}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {status === null && stats.length === 0 && (
        <div style={{ textAlign: 'center', padding: '24px', color: 'rgba(128,128,128,.6)', fontSize: '13px' }}>
          加载中...（如果持续空白，请确认插件已启用）
        </div>
      )}

      <div style={{ textAlign: 'center', fontSize: '11px', color: 'rgba(128,128,128,.4)', marginTop: '12px' }}>
        聊天框命令：/jev-on · /jev-off · /jev-mode · /jev-stats · /jev-status
      </div>
    </div>
  )
}
