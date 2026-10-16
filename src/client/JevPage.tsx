/**
 * Jev Interceptor 主面板：配置 + 状态 + 决策统计。
 *
 * 布局跟随 dsh 原生面板风格（全宽、左对齐），不居中。
 * 所有按钮带加载/错误反馈。
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
  page: { padding: '20px 24px' as const },
  title: { margin: '0 0 16px', fontSize: '18px', fontWeight: 600 as const },
  card: { margin: '0 0 16px', padding: '14px 16px', border: '1px solid rgba(128,128,128,.25)', borderRadius: '8px', background: 'rgba(128,128,128,.04)' },
  label: { fontSize: '12px', color: 'rgba(128,128,128,.7)', marginBottom: '6px' },
  row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' as const },
  input: { flex: 1, minWidth: '200px', padding: '8px 12px', borderRadius: '6px', border: '1px solid rgba(128,128,128,.35)', fontSize: '14px', background: 'transparent', color: 'inherit', outline: 'none' },
  btn: { padding: '8px 18px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '13px', fontWeight: 500 } as React.CSSProperties,
  statCard: { padding: '10px', borderRadius: '6px', border: '1px solid rgba(128,128,128,.2)', textAlign: 'center' as const },
  statLabel: { fontSize: '10px', color: 'rgba(128,128,128,.6)' },
  statValue: { fontSize: '18px', fontWeight: 600, marginTop: '2px' },
  barRow: { display: 'flex', alignItems: 'center', gap: '6px', margin: '3px 0' },
  barLabel: { width: '60px', fontSize: '11px', color: 'rgba(128,128,128,.7)', textAlign: 'right' as const },
  barTrack: { flex: 1, height: '6px', borderRadius: '3px', background: 'rgba(128,128,128,.15)', overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: '3px', background: 'rgba(99,102,241,.6)' },
  barValue: { width: '28px', fontSize: '11px', color: 'rgba(128,128,128,.8)' },
  error: { padding: '8px 12px', borderRadius: '6px', background: 'rgba(239,68,68,.1)', color: '#f87171', fontSize: '12px', margin: '8px 0' },
  success: { padding: '8px 12px', borderRadius: '6px', background: 'rgba(34,197,94,.1)', color: '#4ade80', fontSize: '12px', margin: '8px 0' },
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
    const body = await res.text().catch(() => '')
    return { ok: false, error: `HTTP ${String(res.status)}${body.length > 0 ? `: ${body}` : ''}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function JevPage(_props: JevPageProps): React.JSX.Element {
  const [status, setStatus] = useState<JevStatus | null>(null)
  const [stats, setStats] = useState<TagSummary[]>([])
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [loadError, setLoadError] = useState('')

  const refresh = useCallback(async () => {
    try {
      setLoadError('')
      const [sr, tr] = await Promise.all([
        fetch('/api/jev-interceptor/status', { headers: { 'cache-control': 'no-store' } }),
        fetch('/api/jev-interceptor/stats', { headers: { 'cache-control': 'no-store' } }),
      ])
      if (sr.ok) setStatus(await sr.json() as JevStatus)
      else if (sr.status === 401) setLoadError('需要登录（刷新页面）')
      else setLoadError(`状态加载失败: HTTP ${String(sr.status)}`)
      if (tr.ok) {
        const raw = await tr.json()
        setStats(Array.isArray(raw) ? raw as TagSummary[] : [])
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const doAction = useCallback(async (label: string, patch: Record<string, unknown>) => {
    setBusy(label)
    setMsg(null)
    const r = await apiPut(patch)
    setBusy('')
    if (r.ok) { setMsg({ kind: 'ok', text: '✅ 已更新' }); void refresh() }
    else setMsg({ kind: 'err', text: r.error ?? '更新失败' })
  }, [refresh])

  const saveKey = useCallback(async () => {
    if (apiKey.trim().length < 10) { setMsg({ kind: 'err', text: 'Key 长度需大于 10 个字符' }); return }
    await doAction('saveKey', { apiKey: apiKey.trim() })
    setApiKey('')
  }, [apiKey, doAction])

  return (
    <div style={S.page}>
      <h2 style={S.title}>⚡ Jev Interceptor</h2>

      {loadError !== '' && <div style={S.error}>{loadError}</div>}
      {msg !== null && <div style={msg.kind === 'ok' ? S.success : S.error}>{msg.text}</div>}

      {/* Provider */}
      <div style={S.card}>
        <div style={S.label}>Provider</div>
        <div style={S.row}>
          {PROVIDERS.map(p => (
            <button
              key={p.id}
              style={{
                ...S.btn,
                background: status?.provider === p.id ? 'rgba(99,102,241,.2)' : 'rgba(128,128,128,.08)',
                color: status?.provider === p.id ? '#818cf8' : 'rgba(128,128,128,.7)',
                border: status?.provider === p.id ? '1px solid rgba(99,102,241,.4)' : '1px solid transparent',
              }}
              disabled={busy !== ''}
              onClick={() => { void doAction(`provider:${p.id}`, { provider: p.id }) }}
            >
              {busy === `provider:${p.id}` ? '···' : p.label}
            </button>
          ))}
        </div>
        {status?.provider === 'custom' && (
          <>
            <div style={{ ...S.label, marginTop: '10px' }}>Base URL（回车保存）</div>
            <input
              style={S.input}
              placeholder="https://your-proxy.example.com/v1/systemone"
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                const val = e.currentTarget.value.trim()
                if (val.length > 0) void doAction('endpoint', { endpoint: val })
              }}
            />
          </>
        )}
      </div>

      {/* API Key */}
      <div style={S.card}>
        <div style={S.label}>API Key {status?.keyConfigured === true ? '· 已配置' : '· 未配置'}</div>
        <div style={S.row}>
          <input
            type="password"
            style={S.input}
            placeholder={status?.keyConfigured === true ? '已配置（输入新值覆盖）' : 'sk-or-v1-... 或 sk-...'}
            value={apiKey}
            onChange={(e) => { setApiKey(e.target.value) }}
          />
          <button
            style={{ ...S.btn, background: 'rgba(99,102,241,.2)', color: '#818cf8' }}
            disabled={busy !== '' || apiKey.trim().length < 10}
            onClick={() => { void saveKey() }}
          >
            {busy === 'saveKey' ? '保存中···' : '保存'}
          </button>
        </div>
      </div>

      {/* 状态 */}
      {status !== null && (
        <div style={S.card}>
          <div style={S.row}>
            <span style={{ padding: '4px 12px', borderRadius: '12px', fontSize: '12px', fontWeight: 500, background: status.enabled ? 'rgba(34,197,94,.15)' : 'rgba(128,128,128,.1)', color: status.enabled ? '#4ade80' : 'rgba(128,128,128,.6)' }}>
              {status.enabled ? '运行中' : '已停用'}
            </span>
            <span style={{ padding: '4px 12px', borderRadius: '12px', fontSize: '12px', fontWeight: 500, background: status.mode === 'enforce' ? 'rgba(239,68,68,.12)' : 'rgba(99,102,241,.12)', color: status.mode === 'enforce' ? '#f87171' : '#818cf8' }}>
              {status.mode}
            </span>
            <div style={{ flex: 1 }} />
            <button
              style={{ ...S.btn, background: status.enabled ? 'rgba(239,68,68,.12)' : 'rgba(99,102,241,.2)', color: status.enabled ? '#f87171' : '#818cf8' }}
              disabled={busy !== ''}
              onClick={() => { void doAction('enabled', { enabled: !status.enabled }) }}
            >
              {busy === 'enabled' ? '···' : status.enabled ? '停用' : '启用'}
            </button>
            <button
              style={{ ...S.btn, background: status.mode === 'shadow' ? 'rgba(239,68,68,.12)' : 'rgba(128,128,128,.08)', color: status.mode === 'shadow' ? '#f87171' : 'rgba(128,128,128,.7)' }}
              disabled={busy !== ''}
              onClick={() => { void doAction('mode', { mode: status.mode === 'shadow' ? 'enforce' : 'shadow' }) }}
            >
              {busy === 'mode' ? '···' : status.mode === 'shadow' ? '切 enforce' : '切 shadow'}
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: '8px', marginTop: '12px' }}>
            <div style={S.statCard}><div style={S.statLabel}>Provider</div><div style={{ ...S.statValue, fontSize: '13px' }}>{status.provider}</div></div>
            <div style={S.statCard}><div style={S.statLabel}>模型</div><div style={{ ...S.statValue, fontSize: '13px' }}>{status.model}</div></div>
            <div style={S.statCard}><div style={S.statLabel}>守门人</div><div style={{ ...S.statValue, fontSize: '13px' }}>{status.guardEnabled ? '✅' : '❌'}</div></div>
            <div style={S.statCard}><div style={S.statLabel}>预批</div><div style={{ ...S.statValue, fontSize: '13px' }}>{status.preapproveEnabled ? '✅' : '❌'}</div></div>
          </div>
        </div>
      )}

      {/* 统计 */}
      {stats.length > 0 && (
        <div style={S.card}>
          <div style={{ ...S.label, marginBottom: '10px' }}>决策统计（最近 200 条）</div>
          {stats.map(s => (
            <div key={s.tag} style={{ marginBottom: '14px' }}>
              <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>
                {TAG_LABELS[s.tag] ?? s.tag}
                <span style={{ fontWeight: 400, color: 'rgba(128,128,128,.6)', marginLeft: '8px', fontSize: '11px' }}>
                  {s.calls} 次{s.latencyP50 !== undefined ? ` · p50 ${s.latencyP50}ms` : ''}{s.costUsd !== undefined && s.costUsd > 0 ? ` · $${s.costUsd.toFixed(6)}` : ''}
                </span>
              </div>
              {Object.entries(s.actions).map(([action, n]) => (
                <div key={action} style={S.barRow}>
                  <span style={S.barLabel}>{ACTION_LABELS[action] ?? action}</span>
                  <div style={S.barTrack}>
                    <div style={{ ...S.barFill, width: `${s.calls > 0 ? Math.round((n / s.calls) * 100) : 0}%` }} />
                  </div>
                  <span style={S.barValue}>{n}</span>
                </div>
              ))}
              {s.agreementBuckets !== undefined && Object.keys(s.agreementBuckets).length > 0 && (
                <div style={{ marginTop: '6px', padding: '6px 10px', borderRadius: '4px', background: 'rgba(99,102,241,.06)' }}>
                  {Object.entries(s.agreementBuckets).map(([bucket, n]) => (
                    <div key={bucket} style={{ fontSize: '11px', color: 'rgba(128,128,128,.7)' }}>{bucket}: {n}</div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {status === null && stats.length === 0 && loadError === '' && (
        <div style={S.card}>
          <div style={{ textAlign: 'center', padding: '16px', color: 'rgba(128,128,128,.5)', fontSize: '13px' }}>
            暂无数据——保存 API Key 后运行 /jev-on 启用插件
          </div>
        </div>
      )}

      <div style={{ textAlign: 'center', fontSize: '10px', color: 'rgba(128,128,128,.3)' }}>
        聊天框命令：/jev-on · /jev-off · /jev-mode · /jev-stats · /jev-status
      </div>
    </div>
  )
}
