/**
 * Append-only JSONL telemetry and its aggregation for `/jev-stats`. Writes are
 * fire-and-forget with self-contained failure handling: telemetry must never
 * break a decision path. Entries carry the question outcomes, the action that
 * was taken (or would have been taken in shadow mode), latency, token usage,
 * and cost, so the log doubles as threshold-tuning data.
 * @module dsh-jev-interceptor/telemetry
 */

import { appendFile, mkdir, open, readFile, stat, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Where a decision came from. */
export type DecisionTag = 'guard' | 'preapprove' | 'session-reference' | 'approval-loop'

/** What the plugin did (or, in shadow mode, would have done). */
export type DecisionAction =
  | 'delegate'
  | 'ask'
  | 'deny'
  | 'auto-approve'
  | 'human'
  | 'degraded'
  | 'skipped'
  | 'retention-scored'
  | 'retention-fifo'
  | 'agreement'

/** One durable telemetry record. */
export interface TelemetryEntry {
  /** ISO timestamp of the decision. */
  readonly ts: string
  /** Producing hook. */
  readonly tag: DecisionTag
  /** Effective mode when the decision was made. */
  readonly mode: 'shadow' | 'enforce'
  /** Tool name, when the decision is about a tool call. */
  readonly tool?: string
  /** Session id, when reachable from the hook. */
  readonly sessionId?: string
  /** Model version reported by the provider. */
  readonly model?: string
  /** Action taken (or that would have been taken in shadow mode). */
  readonly action: DecisionAction
  /** Human-readable decision detail (risk, confidence, degrade reason...). */
  readonly detail?: string
  /** Wall-clock decision latency in milliseconds. */
  readonly latencyMs?: number
  /** Input tokens billed for the decision. */
  readonly inputTokens?: number
  /** Estimated or reported cost in USD. */
  readonly costUsd?: number
  /** Whether the answers came from the input cache. */
  readonly cached?: boolean
}

/** Aggregate counters for one hook. */
export interface TagStats {
  calls: number
  byAction: Map<DecisionAction, number>
  degraded: number
  cached: number
  totalInputTokens: number
  totalCostUsd: number
  latencies: number[]
  /** Agreement-bucket counts for the approval-loop tag (others stay empty). */
  approvalBuckets: Partial<Record<(typeof APPROVAL_BUCKETS)[number], number>>
}

/** Price used to estimate cost when the provider does not report one (USD per input megatok); Jev published rate. */
const JEV_USD_PER_MTOK = 0.042

/** Rotate the log above this size (bytes). */
const ROTATE_BYTES = 20 * 1024 * 1024

/**
 * File-backed telemetry writer; `/jev-stats` aggregates by re-reading the log.
 */
export class Telemetry {
  private readonly file: string
  private dirReady: Promise<void> | undefined
  private rotated = false

  /**
   * @param dir - directory for `telemetry.jsonl` (created on first write).
   */
  constructor(dir: string) {
    this.file = join(dir, 'telemetry.jsonl')
  }

  /**
   * Append one record. Never throws: a telemetry failure is swallowed because
   * the decision path already committed.
   * @param entry - the record to persist.
   */
  record(entry: TelemetryEntry): void {
    void this.ready()
      .then(() => appendFile(this.file, `${JSON.stringify(entry)}\n`, 'utf8'))
      .catch(() => {
        // Telemetry is best-effort; nothing downstream depends on it.
      })
  }

  /**
   * Structured per-hook aggregates for the panel API (`/api/jev-interceptor/stats`).
   * @param tailLines - trailing N lines to aggregate (default 200).
   * @returns one summary per tag.
   */
  async statsData(tailLines = 200): Promise<Array<{
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
  }>> {
    await this.ready().catch(() => undefined)
    const entries = tailLines === undefined
      ? await this.readEntries()
      : await this.readTailEntries(tailLines)
    const tags = new Map<string, TagStats>()
    for (const entry of entries) {
      const stats = tags.get(entry.tag) ?? emptyStats()
      foldInto(stats, entry)
      tags.set(entry.tag, stats)
    }
    const result: Array<Record<string, unknown>> = []
    for (const [tag, stats] of tags) {
      const sorted = [...stats.latencies].sort((a, b) => a - b)
      const at = (f: number): number => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))] ?? 0
      result.push({
        tag,
        calls: stats.calls,
        degraded: stats.degraded,
        cached: stats.cached,
        actions: Object.fromEntries(stats.byAction),
        ...(sorted.length > 0 ? { latencyP50: at(0.5), latencyP95: at(0.95) } : {}),
        ...(stats.totalCostUsd > 0 ? { costUsd: stats.totalCostUsd } : {}),
        ...(stats.totalInputTokens > 0 ? { inputTokens: stats.totalInputTokens } : {}),
        ...(Object.keys(stats.approvalBuckets).length > 0 ? { agreementBuckets: stats.approvalBuckets } : {}),
      })
    }
    return result as never
  }

  /**
   * Render per-hook aggregates for the `/jev-stats` command as a visual
   * chat-friendly report with bar charts and status indicators.
   * @param tailLines - when provided, aggregate only the trailing N lines
   *   instead of the whole log (avoids reading 20 MB on every command).
   * @returns a human-readable plain-text report with ASCII visualizations.
   */
  async stats(tailLines?: number): Promise<string> {
    await this.ready().catch(() => undefined)
    const entries = tailLines === undefined
      ? await this.readEntries()
      : await this.readTailEntries(tailLines)
    const tags = new Map<string, TagStats>()
    for (const entry of entries) {
      const stats = tags.get(entry.tag) ?? emptyStats()
      foldInto(stats, entry)
      tags.set(entry.tag, stats)
    }
    if (tags.size === 0) {
      return '```\n⚡ dsh-jev-interceptor\n\n  暂无决策记录\n\n  运行 /jev-on 启用插件后再查看\n```'
    }
    const lines: string[] = ['```']
    lines.push('⚡ dsh-jev-interceptor 决策统计')
    lines.push('')
    for (const [tag, stats] of tags) {
      const tagLabel = TAG_LABELS[tag] ?? tag
      lines.push(`📋 ${tagLabel}`)
      lines.push(`   调用 ${stats.calls} 次 │ 降级 ${stats.degraded} │ 缓存 ${stats.cached}`)
      // 动作分布横条图
      const actions = [...stats.byAction.entries()].sort((a, b) => b[1] - a[1])
      if (actions.length > 0) {
        lines.push('')
        for (const [action, n] of actions) {
          const label = ACTION_LABELS[action] ?? action
          const barStr = bar(n, stats.calls)
          lines.push(`   ${padEnd(label, 8)} ${barStr} ${n}`)
        }
      }
      // 延迟
      const latency = percentileLine(stats.latencies)
      if (latency !== undefined) {
        lines.push(`   延迟 ${latency}`)
      }
      // 成本
      if (stats.totalCostUsd > 0) {
        lines.push(`   💰 成本 $${stats.totalCostUsd.toFixed(6)} (${stats.totalInputTokens} tokens)`)
      }
      // 一致率（approval-loop 专属）
      const bucketEntries = Object.entries(stats.approvalBuckets)
      if (bucketEntries.length > 0) {
        lines.push('')
        lines.push('   🤝 一致率')
        for (const [bucket, n] of bucketEntries) {
          const label = BUCKET_LABELS[bucket] ?? bucket
          const icon = bucket === 'would-over-approve' ? (n === 0 ? '✅' : '⚠️') : ''
          const bucketBar = bar(n, stats.calls)
          lines.push(`   ${padEnd(label, 10)} ${bucketBar} ${n} ${icon}`)
        }
      }
      lines.push('')
    }
    lines.push('━'.repeat(44))
    lines.push('  详细: /jev-stats --all │ 状态: /jev-status')
    lines.push('```')
    return lines.join('\n')
  }

  /**
   * Read only the trailing N entries without parsing the whole file: stat the
   * size, read the last chunk, and split. A torn head line from the chunk
   * boundary reads as absent.
   */
  private async readTailEntries(n: number): Promise<TelemetryEntry[]> {
    try {
      const info = await stat(this.file)
      // Assume ~1 KB per line as an upper bound; read at most that many bytes.
      const chunkBytes = Math.min(info.size, n * 1024 + 4096)
      const handle = await open(this.file, 'r')
      try {
        const buffer = Buffer.alloc(chunkBytes)
        const { bytesRead } = await handle.read(buffer, 0, chunkBytes, info.size - chunkBytes)
        const raw = buffer.subarray(0, bytesRead).toString('utf8')
        const lines = raw.split('\n').filter(line => line.length > 0)
        // Drop the first line if it's a torn head (chunk started mid-line).
        if (chunkBytes < info.size && lines.length > 0) lines.shift()
        const entries: TelemetryEntry[] = []
        for (const line of lines) {
          try {
            entries.push(JSON.parse(line) as TelemetryEntry)
          } catch {
            // Torn or malformed line reads as absent.
          }
        }
        return entries
      } finally {
        await handle.close()
      }
    } catch {
      return []
    }
  }

  /**
   * Read every record from the active log; an unreadable log reads as empty.
   */
  private async readEntries(): Promise<TelemetryEntry[]> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const entries: TelemetryEntry[] = []
      for (const line of raw.split('\n')) {
        if (line.length === 0) continue
        try {
          entries.push(JSON.parse(line) as TelemetryEntry)
        } catch {
          // A torn tail line from a crash reads as absent.
        }
      }
      return entries
    } catch {
      return []
    }
  }


  /** One-time directory creation and oversized-log rotation. */
  private ready(): Promise<void> {
    this.dirReady ??= (async () => {
      await mkdir(dirname(this.file), { recursive: true })
      if (this.rotated) return
      this.rotated = true
      try {
        const info = await stat(this.file)
        if (info.size > ROTATE_BYTES) await rename(this.file, `${this.file}.old`)
      } catch {
        // No existing log yet; nothing to rotate.
      }
    })()
    return this.dirReady
  }
}

/** Fresh aggregate bucket. */
function emptyStats(): TagStats {
  return {
    calls: 0,
    byAction: new Map(),
    degraded: 0,
    cached: 0,
    totalInputTokens: 0,
    totalCostUsd: 0,
    latencies: [],
    approvalBuckets: {},
  }
}

/** Fold one entry into a bucket. */
function foldInto(stats: TagStats, entry: TelemetryEntry): void {
  stats.calls += 1
  const count = stats.byAction.get(entry.action) ?? 0
  stats.byAction.set(entry.action, count + 1)
  if (entry.action === 'degraded') stats.degraded += 1
  if (entry.cached === true) stats.cached += 1
  if (entry.inputTokens !== undefined) stats.totalInputTokens += entry.inputTokens
  if (entry.costUsd !== undefined) stats.totalCostUsd += entry.costUsd
  // Cache hits carry latency 0 by construction; mixing them into percentiles
  // drags p50 toward zero and hides the real provider latency distribution.
  if (entry.latencyMs !== undefined && entry.cached !== true) stats.latencies.push(entry.latencyMs)
  // Approval-loop buckets ride in `detail`; surface them as first-class
  // counters so /jev-stats can print a summary line.
  if (entry.tag === 'approval-loop') {
    for (const bucket of APPROVAL_BUCKETS) {
      if (entry.detail?.includes(bucket) === true) {
        stats.approvalBuckets[bucket] = (stats.approvalBuckets[bucket] ?? 0) + 1
      }
    }
  }
}

/** Every agreement bucket the approval loop can report. */
const APPROVAL_BUCKETS = [
  'would-over-approve',
  'aligned-approve',
  'aligned-reject',
  'friction-human-approved',
  'neutral',
] as const

/** p50/p95 line for a latency sample; `undefined` without samples. */
function percentileLine(latencies: readonly number[]): string | undefined {
  if (latencies.length === 0) return undefined
  const sorted = [...latencies].sort((left, right) => left - right)
  const at = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]
  return `p50 ${at(0.5)}ms  p95 ${at(0.95)}ms  max ${sorted[sorted.length - 1]}ms`
}

/**
 * Estimate cost in USD for one decision when the provider did not report it.
 * @param inputTokens - billed input tokens.
 * @returns estimated cost at Jev's published input rate (output is free).
 */
export function estimateCostUsd(inputTokens: number | undefined): number | undefined {
  if (inputTokens === undefined) return undefined
  return (inputTokens / 1_000_000) * JEV_USD_PER_MTOK
}

// ── ASCII 可视化辅助 ─────────────────────────────────────────────────────

/** Tag 中文标签 */
const TAG_LABELS: Readonly<Record<string, string>> = {
  guard: '守门人（风险分类）',
  preapprove: '预批（自动审批）',
  'session-reference': '会话保留打分',
  'approval-loop': '审批一致率',
}

/** Action 中文标签 */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  delegate: '放行',
  ask: '转人工',
  deny: '拒绝',
  'auto-approve': '自动批',
  human: '人工',
  degraded: '降级',
  skipped: '跳过',
  'retention-scored': '打分保留',
  'retention-fifo': 'FIFO保留',
  agreement: '一致率',
}

/** Agreement bucket 中文标签 */
const BUCKET_LABELS: Readonly<Record<string, string>> = {
  'would-over-approve': '误批风险',
  'aligned-approve': '一致批',
  'aligned-reject': '一致拒',
  'friction-human-approved': '多余人工',
  neutral: '中性',
}

/**
 * Render a proportional bar for a count within a total.
 * @param n - the count to visualize.
 * @param total - the maximum for proportion.
 * @param width - character width of the bar (default 20).
 * @returns a string like `████████░░░░░░░░░░░░`.
 */
function bar(n: number, total: number, width = 20): string {
  if (total <= 0 || n <= 0) return '░'.repeat(width)
  const filled = Math.max(1, Math.round((n / total) * width))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/**
 * Pad a string to a fixed display width, accounting for CJK double-width
 * characters (each CJK char occupies two monospace columns).
 * @param text - the string to pad.
 * @param targetWidth - the desired display width.
 * @returns the padded string.
 */
function padEnd(text: string, targetWidth: number): string {
  let displayWidth = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code !== undefined && code >= 0x2e80 && code <= 0x9fff) displayWidth += 2
    else displayWidth += 1
  }
  const padding = Math.max(0, targetWidth - displayWidth)
  return text + ' '.repeat(padding)
}
