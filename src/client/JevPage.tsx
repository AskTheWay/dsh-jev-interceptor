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
  stagnationEnabled: boolean
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

/** 校准报告（本地镜像宿主 CalibrationReport，面板不 import 宿主类型）。 */
interface Calibration {
  windowSize: number
  counts: { guard: number; preapprove: number; approvalLoop: number }
  modeSplit: { shadow: number; enforce: number }
  advice: Array<{ param: string; current: number; suggested: number; basis: string; samples: number; note: string }>
  insufficient: Array<{ param: string; reason: string }>
  observations: Array<{ param: string; reason: string }>
}

/** 决策明细行（本地镜像 TelemetryEntry 子集）。 */
interface LogEntry {
  ts: string
  tag: string
  mode: string
  tool?: string
  action: string
  detail?: string
  latencyMs?: number
  cached?: boolean
}

/** 明细表动作徽章配色（6 位 hex——运行时拼接 '1f' 透明度尾巴）。 */
const ACTION_COLORS: Record<string, string> = {
  deny: '#f87171',
  ask: '#fbbf24',
  'auto-approve': '#4ade80',
  degraded: '#808080',
  'stagnation-alert': '#fbbf24',
}

type JevPageProps = PropsRuntime<'main'>

const S = {
  // height+overflowY+borderBox 三件套是 main 面板的标准滚动契约（照
  // auto-memory 面板先例）：内容超出视口时面板自身滚动，而不是被裁剪。
  wrap: { maxWidth: '600px', height: '100%', overflowY: 'auto', boxSizing: 'border-box', padding: '20px 24px' },
  title: { margin: '0 0 14px', fontSize: '17px', fontWeight: 600 },
  card: { margin: '0 0 12px', padding: '12px 14px', border: '1px solid rgba(128,128,128,.2)', borderRadius: '8px', background: 'rgba(128,128,128,.03)' },
  // 文字用白色系（深色主题）：灰字在深底上对比不足，层级靠透明度表达。
  label: { fontSize: '12px', color: 'rgba(255,255,255,.85)', marginBottom: '6px' },
  row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  input: { flex: 1, minWidth: '180px', padding: '7px 10px', borderRadius: '6px', border: '1px solid rgba(128,128,128,.3)', fontSize: '13px', background: 'transparent', color: 'inherit', outline: 'none' },
  btn: { padding: '7px 14px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '12px', fontWeight: 500 },
  statCard: { padding: '8px', borderRadius: '6px', border: '1px solid rgba(128,128,128,.15)', textAlign: 'center' },
  statLabel: { fontSize: '10px', color: 'rgba(255,255,255,.75)' },
  statValue: { fontSize: '14px', fontWeight: 600, marginTop: '2px' },
  barRow: { display: 'flex', alignItems: 'center', gap: '5px', margin: '2px 0' },
  barLabel: { width: '52px', fontSize: '10px', color: 'rgba(255,255,255,.8)', textAlign: 'right' },
  barTrack: { flex: 1, height: '5px', borderRadius: '3px', background: 'rgba(128,128,128,.12)', overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: '3px', background: 'rgba(99,102,241,.55)' },
  barValue: { width: '26px', fontSize: '10px', color: 'rgba(255,255,255,.9)' },
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
  stagnation: '停滞检测',
}

const ACTION_LABELS: Record<string, string> = {
  delegate: '放行', ask: '转人工', deny: '拒绝', 'auto-approve': '自动批',
  human: '人工', degraded: '降级', agreement: '一致率',
  skipped: '跳过', 'retention-scored': '打分保留', 'retention-fifo': 'FIFO保留',
  'stagnation-alert': '停滞提醒',
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
  // 校准报告（点「生成建议」拉取，纯只读）
  const [calib, setCalib] = useState<Calibration | null>(null)
  // 最近决策明细（随 refresh 拉取，只读）
  const [log, setLog] = useState<LogEntry[]>([])

  const refresh = useCallback(async () => {
    try {
      setLoadErr('')
      const [sr, tr, lr] = await Promise.all([
        fetch('/api/jev-interceptor/status', { headers: { 'cache-control': 'no-store' } }),
        fetch('/api/jev-interceptor/stats', { headers: { 'cache-control': 'no-store' } }),
        fetch('/api/jev-interceptor/log?limit=50', { headers: { 'cache-control': 'no-store' } }),
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
      if (lr.ok) {
        const raw = await lr.json()
        setLog(Array.isArray(raw) ? (raw as LogEntry[]).slice().reverse() : [])
      }
    } catch { /* degrade */ }
  }, [selProvider])

  useEffect(() => { void refresh() }, [refresh])

  // 乐观更新：先改 UI 再发请求，失败回退
  const optimistic = useCallback(async (id: string, patch: Record<string, unknown>, revert: JevStatus | null) => {
    setBusy(id)
    setMsg(null)
    // 立即更新本地 status
    if (status !== null) {
      setStatus({
        ...status,
        ...(typeof patch['enabled'] === 'boolean' ? { enabled: patch['enabled'] } : {}),
        ...(patch['mode'] === 'shadow' || patch['mode'] === 'enforce' ? { mode: patch['mode'] } : {}),
        ...(typeof patch['provider'] === 'string' ? { provider: patch['provider'] } : {}),
      })
    }
    const r = await apiPut(patch)
    setBusy('')
    if (r.ok) {
      setMsg({ ok: true, text: '已更新' })
      void refresh()
    } else {
      // 失败：回退（selProvider 一并回滚——否则本地高亮会压过服务器真值）。
      if (revert !== null) {
        setStatus(revert)
        setSelProvider(revert.provider)
      } else {
        setSelProvider('')
      }
      setMsg({ ok: false, text: r.error ?? '失败' })
    }
  }, [status, refresh])

  const saveKey = useCallback(async () => {
    if (apiKey.trim().length < 10) { setMsg({ ok: false, text: 'Key 太短' }); return }
    setBusy('key')
    setMsg(null)
    const r = await apiPut({ apiKey: apiKey.trim() })
    setBusy('')
    if (r.ok) {
      setMsg({ ok: true, text: 'Key 已保存' })
      setApiKey('')
      // 立即标记为已配置
      if (status !== null) setStatus({ ...status, keyConfigured: true })
      void refresh()
    } else {
      setMsg({ ok: false, text: r.error ?? '失败' })
    }
  }, [apiKey, status, refresh])

  const provider = selProvider || status?.provider || 'typesafe'
  const isCustom = provider === 'custom'

  // 拉取校准报告（纯只读展示，失败走 msg 通道）
  const runCalibrate = useCallback(async () => {
    setBusy('calib')
    setMsg(null)
    try {
      const res = await fetch('/api/jev-interceptor/calibration', { headers: { 'cache-control': 'no-store' } })
      if (res.ok) {
        setCalib(await res.json() as Calibration)
        setMsg({ ok: true, text: '校准报告已生成' })
      } else {
        setMsg({ ok: false, text: `校准失败 ${String(res.status)}` })
      }
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    }
    setBusy('')
  }, [])

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
                color: provider === p.id ? '#818cf8' : 'rgba(255,255,255,.75)',
                border: provider === p.id ? '1px solid rgba(99,102,241,.3)' : '1px solid rgba(128,128,128,.2)',
              }}
              disabled={busy !== ''}
              onClick={() => { setSelProvider(p.id); void optimistic(`p:${p.id}`, { provider: p.id }, status) }}
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
                if (v.length > 0) void optimistic('url', { endpoint: v }, status)
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
            <span style={{ fontSize: '12px', color: 'rgba(255,255,255,.8)' }}>
              {MODE_LABELS[status.mode] ?? status.mode}
            </span>
            <div style={{ flex: 1 }} />
            <button style={{ ...S.btn, background: status.enabled ? 'rgba(239,68,68,.08)' : 'rgba(34,197,94,.1)', color: status.enabled ? '#f87171' : '#4ade80' }}
              disabled={busy !== ''}
              onClick={() => { void optimistic('en', { enabled: !status.enabled }, status) }}
            >{busy === 'en' ? '···' : status.enabled ? '停用' : '启用'}</button>
            <button style={{ ...S.btn, background: 'rgba(128,128,128,.06)', color: 'rgba(255,255,255,.85)' }}
              disabled={busy !== ''}
              onClick={() => { void optimistic('md', { mode: status.mode === 'shadow' ? 'enforce' : 'shadow' }, status) }}
            >{busy === 'md' ? '···' : status.mode === 'shadow' ? '切执行' : '切观察'}</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))', gap: '6px', marginTop: '10px' }}>
            <div style={S.statCard}><div style={S.statLabel}>Provider</div><div style={S.statValue}>{status.provider}</div></div>
            <div style={S.statCard}><div style={S.statLabel}>模型</div><div style={{ ...S.statValue, fontSize: '11px' }}>{status.model}</div></div>
            <div style={S.statCard}><div style={S.statLabel}>守门人</div><div style={S.statValue}>{status.guardEnabled ? '✓' : '—'}</div></div>
            <div style={S.statCard}><div style={S.statLabel}>预批</div><div style={S.statValue}>{status.preapproveEnabled ? '✓' : '—'}</div></div>
            <div style={S.statCard}><div style={S.statLabel}>停滞</div><div style={S.statValue}>{status.stagnationEnabled ? '✓' : '—'}</div></div>
          </div>
        </div>
      )}

      {/* 校准建议（只读，点按钮生成） */}
      <div style={S.card}>
        <div style={{ ...S.label, marginBottom: '8px', display: 'flex', alignItems: 'center' }}>
          <span style={{ flex: 1 }}>阈值校准建议</span>
          <button style={{ ...S.btn, background: 'rgba(99,102,241,.15)', color: '#818cf8' }}
            disabled={busy !== ''}
            onClick={() => { void runCalibrate() }}
          >{busy === 'calib' ? '···' : '生成建议'}</button>
        </div>
        {calib === null && (
          <div style={{ fontSize: '11px', color: 'rgba(255,255,255,.6)' }}>
            分析影子遥测的决策分布与一致率，给出阈值调整方向（不自动应用）
          </div>
        )}
        {calib !== null && (
          <div style={{ fontSize: '11px' }}>
            <div style={{ color: 'rgba(255,255,255,.75)', marginBottom: '6px' }}>
              窗口 {calib.windowSize} 条 · guard {calib.counts.guard} / 预批 {calib.counts.preapprove} / 一致率 {calib.counts.approvalLoop}
              {' '}· shadow {calib.modeSplit.shadow} / enforce {calib.modeSplit.enforce}
            </div>
            {calib.advice.length > 0 && calib.advice.map(a => (
              <div key={a.param} style={{ marginBottom: '6px' }}>
                <div style={{ fontWeight: 600 }}>
                  {a.param}：<span style={{ color: '#818cf8' }}>{a.current.toFixed(2)} → {a.suggested.toFixed(2)}</span>
                </div>
                <div style={{ color: 'rgba(255,255,255,.8)' }}>{a.basis}</div>
              </div>
            ))}
            {calib.insufficient.length > 0 && (
              <div style={{ color: 'rgba(255,255,255,.7)', marginBottom: '4px' }}>
                📊 样本不足：{calib.insufficient.map(n => n.reason).join('；')}
              </div>
            )}
            {calib.observations.length > 0 && (
              <div style={{ color: 'rgba(255,255,255,.7)' }}>
                🔍 {calib.observations.map(n => n.reason).join('；')}
              </div>
            )}
            <div style={{ color: 'rgba(255,255,255,.6)', marginTop: '6px' }}>
              本报告不自动应用，请人工复制到配置
            </div>
          </div>
        )}
      </div>

      {/* 统计 */}
      {stats.length > 0 && (
        <div style={S.card}>
          <div style={{ ...S.label, marginBottom: '8px' }}>决策统计</div>
          {stats.map(s => (
            <div key={s.tag} style={{ marginBottom: '10px' }}>
              <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '3px' }}>
                {TAG_LABELS[s.tag] ?? s.tag}
                <span style={{ fontWeight: 400, color: 'rgba(255,255,255,.7)', marginLeft: '6px', fontSize: '10px' }}>
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

      {/* 最近决策明细（只读） */}
      {log.length > 0 && (
        <div style={S.card}>
          <div style={{ ...S.label, marginBottom: '8px' }}>最近决策（{String(log.length)} 条，新→旧）</div>
          {log.slice(0, 50).map((e, i) => (
            <div key={`${e.ts}-${String(i)}`} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', padding: '3px 0', borderBottom: '1px solid rgba(128,128,128,.06)' }}>
              <span style={{ color: 'rgba(255,255,255,.65)', fontFamily: 'monospace' }}>{e.ts.slice(11, 19)}</span>
              <span style={{ color: 'rgba(255,255,255,.85)', minWidth: '32px' }}>{TAG_LABELS[e.tag]?.replace(/（.*）/, '') ?? e.tag}</span>
              <span style={{ fontFamily: 'monospace', color: 'rgba(255,255,255,.9)', minWidth: '60px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.tool ?? '—'}</span>
              <span style={{
                padding: '1px 6px', borderRadius: '8px', fontSize: '10px', whiteSpace: 'nowrap',
                background: ACTION_COLORS[e.action] !== undefined ? `${ACTION_COLORS[e.action]}1f` : 'rgba(99,102,241,.12)',
                color: ACTION_COLORS[e.action] ?? '#818cf8',
              }}>{ACTION_LABELS[e.action] ?? e.action}{e.mode === 'shadow' ? '·观' : ''}</span>
              {e.latencyMs !== undefined && <span style={{ color: 'rgba(255,255,255,.65)', minWidth: '36px' }}>{e.cached === true ? '⚡' : ''}{String(e.latencyMs)}ms</span>}
              <span title={e.detail ?? ''} style={{ flex: 1, color: 'rgba(255,255,255,.7)', fontFamily: 'monospace', fontSize: '10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.detail ?? '—'}</span>
            </div>
          ))}
        </div>
      )}

      {status === null && stats.length === 0 && loadErr === '' && (
        <div style={{ ...S.card, textAlign: 'center', color: 'rgba(255,255,255,.6)', fontSize: '12px', padding: '20px' }}>
          保存 Key 后运行 /jev-on 启用
        </div>
      )}
    </div>
  )
}
