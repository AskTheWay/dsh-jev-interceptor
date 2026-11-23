/** Pure presentation helpers; no host imports or changes to decision policy. */
export interface DecisionRecord {
  ts: string
  tag: string
  mode: string
  action: string
  tool?: string
  detail?: string
  sessionId?: string
  callId?: string
  scores?: Readonly<Record<string, number>>
}

export function filterDecisions<T extends DecisionRecord>(
  entries: readonly T[],
  filters: { action: string; mode: string; tag: string; query: string },
): T[] {
  const needle = filters.query.trim().toLowerCase()
  return entries.filter(
    (entry) =>
      (filters.action === 'all' || entry.action === filters.action) &&
      (filters.mode === 'all' || entry.mode === filters.mode) &&
      (filters.tag === 'all' || entry.tag === filters.tag) &&
      (needle.length === 0 ||
        [entry.tool, entry.detail, entry.sessionId, entry.callId].some((value) =>
          value?.toLowerCase().includes(needle),
        )),
  )
}

export interface DayBucket {
  day: string
  total: number
  flagged: number
  degraded: number
}

/** Use UTC days to match the host's impact summary; include inactive days. */
export function decisionDays(entries: readonly DecisionRecord[]): DayBucket[] {
  const buckets = new Map<string, DayBucket>()
  let latest = -Infinity
  for (const entry of entries) {
    const millis = Date.parse(entry.ts)
    if (!Number.isFinite(millis)) continue
    const day = new Date(millis).toISOString().slice(0, 10)
    latest = Math.max(latest, Date.parse(`${day}T00:00:00Z`))
    const bucket = buckets.get(day) ?? { day, total: 0, flagged: 0, degraded: 0 }
    bucket.total += 1
    if (entry.action === 'ask' || entry.action === 'deny' || entry.action === 'marked') bucket.flagged += 1
    if (entry.action === 'degraded') bucket.degraded += 1
    buckets.set(day, bucket)
  }
  if (!Number.isFinite(latest)) return []
  return Array.from({ length: 14 }, (_, index) => {
    const day = new Date(latest - (13 - index) * 86_400_000).toISOString().slice(0, 10)
    return buckets.get(day) ?? { day, total: 0, flagged: 0, degraded: 0 }
  })
}

const SCORE_LABELS: Record<string, string> = {
  risk_p: '风险判断置信度',
  irrev: '不可逆概率',
  task: '任务匹配度',
  inj: '注入嫌疑',
  user: '用户明确要求',
  untrusted: '来自不可信指令',
  scope: '授权范围匹配',
  reversible: '可逆性',
}

/** Preserve zeroes and full-precision scores; older records use detail tokens. */
export function decisionScores(entry: DecisionRecord): Array<{ key: string; label: string; value: number }> {
  const values: Record<string, number> = {}
  for (const key of Object.keys(SCORE_LABELS)) {
    let value = entry.scores?.[key]
    if (value === undefined) {
      const token = key === 'risk_p' ? '(?:risk_p|p)' : key
      const match = entry.detail?.match(new RegExp(`(?:^|\\s)${token}=([0-9]+(?:\\.[0-9]+)?)(?=\\s|$)`))
      if (match !== undefined && match !== null) value = Number(match[1])
    }
    if (value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1) values[key] = value
  }
  return Object.entries(values).map(([key, value]) => ({ key, label: SCORE_LABELS[key]!, value }))
}
