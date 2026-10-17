/**
 * Jev Interceptor 主面板：配置 + 状态 + 决策统计。
 *
 * 左对齐、适度宽度（600px 上限）、不居中不铺满。
 * Provider 点击立即切换本地状态（不等 refresh），Base URL 即时可见。
 */

import { useCallback, useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

interface JevStatus {
  enabled: boolean
  mode: 'shadow' | 'enforce'
  provider: string
  model: string
  keyConfigured: boolean
  keySource: string
  guardEnabled: boolean
  preapproveEnabled: boolean
}

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

const S = {
  wrap: { maxWidth: '600px', padding: '20px 24px' },
  title: { margin: '0 0 14px', fontSize: '17px', fontWeight: 600 },
  card: { margin: '0 0 12px', padding: '12px 14px', border: '1px solid rgba(128,128,128,.2)', borderRadius: '8px', background: 'rgba(128,128,128,.03)' },
  label: { fontSize: '12px', color: 'rgba(128,128,128,.65)', marginBottom: '6px' },
  row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  input: { flex: 1, minWidth: '180px', padding: '7px 10px', borderRadius: '6px', border: '1px solid rgba(128,128,128,.3)', fontSize: '13px', background: 'transparent', color: 'inherit', outline: 'none' },
  btn: { padding: '7px 14px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '12px', fontWeight: 500 },
  statCard: { padding: '8px', borderRadius: '6px', border: '1px solid rgba(128,128,128,.15)', textAlign: 'center' },
  statLabel: { fontSize: '10px', color: 'rgba(128,128,128,.55)' },
  statValue: { fontSize: '14px', fontWeight: 600, marginTop: '2px' },
  barRow: { display: 'flex', alignItems: 'center', gap: '5px', margin: '2px 0' },
  barLabel: { width: '52px', fontSize: '10px', color: 'rgba(128,128,128,.65)', textAlign: 'right' },
  barTrack: { flex: 1, height: '5px', borderRadius: '3px', background: 'rgba(128,128,128,.12)', overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: '3px', background: 'rgba(99,102,241,.55)' },
  barValue: { width: '26px', fontSize: '10px', color: 'rgba(128,128,128,.75)' },
  msg: { padding: '6px 10px', borderRadius: '6px', fontSize: '12px', margin: '6px 0' },
}

const MODE_LABELS: Record<string, string> = {
  shadow: '观察（只记录）',
  enforce: '执行（做决策）',
}

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

const PROVIDERS = [
  { id: 'typesafe', label: 'TypeSafe' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'custom', label: '自定义' },
]

async function apiPut(patch: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/jev-interceptor/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (res.ok) return { ok: true }
    return { ok: false, error: `HTTP ${String(res.status)}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function JevPage(_props: JevPageProps): React.JSX.Element {
  const [status, setStatus] = useState<JevStatus | null>(null)
  const [stats, setStats] = useState<TagSummary[]>([])
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [loadErr, setLoadErr] = useState('')
  // 本地选中的 provider（立即响应点击，不等 refresh）
  const [selProvider, setSelProvider] = useState('')

  const refresh = useCallback(async () => {
    try {
      setLoadErr('')
      const [sr, tr] = await Promise.all([
        fetch('/api/jev-interceptor/status', { headers: { 'cache-control': 'no-store' } }),
        fetch('/api/jev-interceptor/stats', { headers: { 'cache-control': 'no-store' } }),
      ])
      if (sr.ok) {
        const s = await sr.json() as JevStatus
        setStatus(s)
        if (selProvider === '') setSelProvider(s.provider)
      } else if (sr.status !== 404) {
        setLoadErr(sr.status === 401 ? '需要登录' : `加载失败 ${String(sr.status)}`)
      }
      if (tr.ok) {
        const raw = await tr.json()
        setStats(Array.isArray(raw) ? raw as TagSummary[] : [])
      }
    } catch { /* degrade */ }
  }, [selProvider])

  useEffect(() => { void refresh() }, [refresh])

  const doAction = useCallback(async (id: string, patch: Record<string, unknown>) => {
    setBusy(id)
    setMsg(null)
    const r = await apiPut(patch)
    setBusy('')
    if (r.ok) { setMsg({ ok: true, text: '已更新' }); void refresh() }
    else setMsg({ ok: false, text: r.error ?? '失败' })
  }, [refresh])

  const saveKey = useCallback(async () => {
    if (apiKey.trim().length < 10) { setMsg({ ok: false, text: 'Key 太短' }); return }
    await doAction('key', { apiKey: apiKey.trim() })
    setApiKey('')
  }, [apiKey, doAction])

  const provider = selProvider || status?.provider || 'typesafe'
  const isCustom = provider === 'custom'

  return (
    <div style={S.wrap}>
      <h2 style={S.title}>⚡ Jev Interceptor</h2>

      {loadErr !== '' && <div style={{ ...S.msg, background: 'rgba(239,68,68,.08)', color: '#f87171' }}>{loadErr}</div>}
      {msg !== null && <div style={{ ...S.msg, background: msg.ok ? 'rgba(34,197,94,.08)' : 'rgba(239,68,68,.08)', color: msg.ok ? '#4ade80' : '#f87171' }}>{msg.ok ? '✓ ' : ''}{msg.text}</div>}

      {/* 连接配置 */}
      <div style={S.card}>
        <div style={S.label}>Provider</div>
        <div style={S.row}>
          {PROVIDERS.map(p => (
            <button key={p.id}
              style={{
                ...S.btn,
                background: provider === p.id ? 'rgba(99,102,241,.15)' : 'transparent',
                color: provider === p.id ? '#818cf8' : 'rgba(128,128,128,.6)',
                border: provider === p.id ? '1px solid rgba(99,102,241,.3)' : '1px solid rgba(128,128,128,.2)',
              }}
              disabled={busy !== ''}
              onClick={() => { setSelProvider(p.id); void doAction(`p:${p.id}`, { provider: p.id }) }}
            >{busy === `p:${p.id}` ? '···' : p.label}</button>
          ))}
        </div>

        {isCustom && (
          <div style={{ marginTop: '10px' }}>
            <div style={S.label}>Base URL</div>
            <input style={S.input} placeholder="https://your-proxy.example.com/v1/systemone"
              onKeyDown={e => {
                if (e.key !== 'Enter') return
                const v = e.currentTarget.value.trim()
                if (v.length > 0) void doAction('url', { endpoint: v })
              }}
            />
          </div>
        )}

        <div style={{ ...S.label, marginTop: isCustom ? '10px' : '10px' }}>API Key{status?.keyConfigured === true ? '（已配置）' : ''}</div>
        <div style={S.row}>
          <input type="password" style={S.input}
            placeholder={status?.keyConfigured === true ? '输入新值覆盖' : '粘贴你的 key'}
            value={apiKey} onChange={e => { setApiKey(e.target.value) }}
          />
          <button style={{ ...S.btn, background: 'rgba(99,102,241,.15)', color: '#818cf8' }}
            disabled={busy !== '' || apiKey.trim().length < 10}
            onClick={() => { void saveKey() }}
          >{busy === 'key' ? '···' : '保存'}</button>
        </div>
      </div>

      {/* 运行状态 */}
      {status !== null && (
        <div style={S.card}>
          <div style={S.row}>
            <span style={{ padding: '3px 10px', borderRadius: '10px', fontSize: '11px', fontWeight: 500, background: status.enabled ? 'rgba(34,197,94,.12)' : 'rgba(128,128,128,.08)', color: status.enabled ? '#4ade80' : 'rgba(128,128,128,.5)' }}>
              {status.enabled ? '● 运行中' : '○ 已停用'}
            </span>
            <span style={{ fontSize: '12px', color: 'rgba(128,128,128,.6)' }}>
              {MODE_LABELS[status.mode] ?? status.mode}
            </span>
            <div style={{ flex: 1 }} />
            <button style={{ ...S.btn, background: status.enabled ? 'rgba(239,68,68,.08)' : 'rgba(34,197,94,.1)', color: status.enabled ? '#f87171' : '#4ade80' }}
              disabled={busy !== ''}
              onClick={() => { void doAction('en', { enabled: !status.enabled }) }}
            >{busy === 'en' ? '···' : status.enabled ? '停用' : '启用'}</button>
            <button style={{ ...S.btn, background: 'rgba(128,128,128,.06)', color: 'rgba(128,128,128,.7)' }}
              disabled={busy !== ''}
              onClick={() => { void doAction('md', { mode: status.mode === 'shadow' ? 'enforce' : 'shadow' }) }}
            >{busy === 'md' ? '···' : status.mode === 'shadow' ? '切执行' : '切观察'}</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))', gap: '6px', marginTop: '10px' }}>
            <div style={S.statCard}><div style={S.statLabel}>Provider</div><div style={S.statValue}>{status.provider}</div></div>
            <div style={S.statCard}><div style={S.statLabel}>模型</div><div style={{ ...S.statValue, fontSize: '11px' }}>{status.model}</div></div>
            <div style={S.statCard}><div style={S.statLabel}>守门人</div><div style={S.statValue}>{status.guardEnabled ? '✓' : '—'}</div></div>
            <div style={S.statCard}><div style={S.statLabel}>预批</div><div style={S.statValue}>{status.preapproveEnabled ? '✓' : '—'}</div></div>
          </div>
        </div>
      )}

      {/* 统计 */}
      {stats.length > 0 && (
        <div style={S.card}>
          <div style={{ ...S.label, marginBottom: '8px' }}>决策统计</div>
          {stats.map(s => (
            <div key={s.tag} style={{ marginBottom: '10px' }}>
              <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '3px' }}>
                {TAG_LABELS[s.tag] ?? s.tag}
                <span style={{ fontWeight: 400, color: 'rgba(128,128,128,.5)', marginLeft: '6px', fontSize: '10px' }}>
                  {s.calls} 次{s.latencyP50 !== undefined ? ` · p50 ${s.latencyP50}ms` : ''}
                </span>
              </div>
              {Object.entries(s.actions).map(([a, n]) => (
                <div key={a} style={S.barRow}>
                  <span style={S.barLabel}>{ACTION_LABELS[a] ?? a}</span>
                  <div style={S.barTrack}><div style={{ ...S.barFill, width: `${s.calls > 0 ? Math.round((n / s.calls) * 100) : 0}%` }} /></div>
                  <span style={S.barValue}>{n}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {status === null && stats.length === 0 && loadErr === '' && (
        <div style={{ ...S.card, textAlign: 'center', color: 'rgba(128,128,128,.4)', fontSize: '12px', padding: '20px' }}>
          保存 Key 后运行 /jev-on 启用
        </div>
      )}
    </div>
  )
}
