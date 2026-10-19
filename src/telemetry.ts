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
export type DecisionTag = 'guard' | 'preapprove' | 'session-reference' | 'approval-loop' | 'stagnation'

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
  | 'stagnation-alert'

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
  /** 触发决策的工具调用 id；与 tool/call、approval/asked 的 callId 对齐，供明细关联。 */
  readonly callId?: string
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
  /**
   * 决策数值样本（guard/preapprove 的已答调用专属），供校准器全精度重放。
   * 键表固定与 detail token 同名：guard 为 `risk_p`/`irrev`/`task`/`inj`，
   * preapprove 为 `scope`/`reversible`/`inj`，值域 [0,1]。旧记录无此字段，
   * 读侧（calibrate）回退 detail 正则解析。
   */
  readonly scores?: Readonly<Record<string, number>>
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

/** 尾部按块读取的翻倍上限：病态长行也最多读 2MB（recentEntries 的窗口封顶）。 */
const TAIL_CHUNK_MAX_BYTES = 2 * 1024 * 1024

/**
 * File-backed telemetry writer; `/jev-stats` aggregates by re-reading the log.
 */
export class Telemetry {
  private readonly file: string
  private dirReady: Promise<void> | undefined
  /** 串行写队列：并发 appendFile 的完成顺序无保证，链式追加保证日志顺序。 */
  private writeQueue: Promise<void> = Promise.resolve()
  private rotated = false

  /**
   * @param dir - directory for `telemetry.jsonl` (created on first write).
   */
  constructor(dir: string) {
    this.file = join(dir, 'telemetry.jsonl')
  }

  /**
   * Append one record. Never throws: a telemetry failure is swallowed because
   * the decision path already committed. Writes are chained so records land in
   * the log in the order they were recorded.
   * @param entry - the record to persist.
   */
  record(entry: TelemetryEntry): void {
    this.writeQueue = this.writeQueue
      .then(() => this.ready())
      .then(() => appendFile(this.file, `${JSON.stringify(entry)}\n`, 'utf8'))
      .catch(() => {
        // Telemetry is best-effort; nothing downstream depends on it.
      })
  }

  /**
   * Read telemetry records: the whole active log or only its trailing N lines
   * (a torn line reads as absent). Shared read path for `/jev-stats`, the
   * panel API, and the calibrator.
   * @param tailLines - when omitted, read every record; otherwise only the
   *   trailing N lines.
   * @returns parsed records; an unreadable log reads as empty (never throws).
   */
  async entries(tailLines?: number): Promise<TelemetryEntry[]> {
    await this.ready().catch(() => undefined)
    if (tailLines === undefined) return await this.readEntries()
    // readTailEntries 按字节窗口读取，条数可能多于 n；精确截到尾部 n 条。
    const raw = await this.readTailEntries(tailLines)
    return tailLines <= 0 ? [] : raw.slice(-tailLines)
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
    const entries = await this.entries(tailLines)
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
    const entries = await this.entries(tailLines)
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
    lines.push('  详细: /jev-stats --all │ 明细: /jev-log │ 状态: /jev-status')
    lines.push('```')
    return lines.join('\n')
  }

  /**
   * Read the most recent N entries exactly: the byte window starts at
   * N×(1 KB upper bound) and doubles until N entries are covered (whole file
   * or the 2 MB ceiling). IO failures read as empty.
   * @param n - how many recent entries to return.
   * @returns at most N entries, oldest first.
   */
  async recentEntries(n: number): Promise<TelemetryEntry[]> {
    if (n <= 0) return []
    let chunkBytes = n * 1024 + 4096
    for (;;) {
      const { entries, sawWholeFile } = await this.readTailChunk(chunkBytes)
      if (entries.length >= n || sawWholeFile || chunkBytes >= TAIL_CHUNK_MAX_BYTES) {
        return entries.slice(-n)
      }
      chunkBytes = Math.min(chunkBytes * 2, TAIL_CHUNK_MAX_BYTES)
    }
  }

  /**
   * Read only the trailing chunk without parsing the whole file: stat the
   * size, read the last `chunkBytes` bytes, and split. A torn head line from
   * the chunk boundary reads as absent.
   */
  private async readTailChunk(chunkBytes: number): Promise<{ entries: TelemetryEntry[]; sawWholeFile: boolean }> {
    try {
      const info = await stat(this.file)
      const readBytes = Math.min(chunkBytes, info.size)
      const handle = await open(this.file, 'r')
      try {
        const buffer = Buffer.alloc(readBytes)
        const { bytesRead } = await handle.read(buffer, 0, readBytes, info.size - readBytes)
        const raw = buffer.subarray(0, bytesRead).toString('utf8')
        const lines = raw.split('\n').filter(line => line.length > 0)
        // Drop the first line if it's a torn head (chunk started mid-line).
        if (readBytes < info.size && lines.length > 0) lines.shift()
        const entries: TelemetryEntry[] = []
        for (const line of lines) {
          try {
            entries.push(JSON.parse(line) as TelemetryEntry)
          } catch {
            // Torn or malformed line reads as absent.
          }
        }
        return { entries, sawWholeFile: readBytes >= info.size }
      } finally {
        await handle.close()
      }
    } catch {
      return { entries: [], sawWholeFile: false }
    }
  }

  /**
   * Read only the trailing N entries (approximate: the byte window may yield
   * more than N; callers wanting exact counts use {@link recentEntries}).
   */
  private async readTailEntries(n: number): Promise<TelemetryEntry[]> {
    const { entries } = await this.readTailChunk(n * 1024 + 4096)
    return entries
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
  stagnation: '停滞检测（换参循环）',
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
  'stagnation-alert': '停滞提醒',
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

// ── /jev-log 决策明细 ────────────────────────────────────────────────────

/** /jev-log 默认展示条数。 */
export const LOG_DEFAULT_N = 20
/** /jev-log 与 /log 路由的条数上限。 */
export const LOG_MAX_N = 500
/** 面板「最近决策」默认拉取条数。 */
export const LOG_PANEL_N = 50

/** /jev-log 解析后的输入。 */
export interface LogArgs {
  /** 展示条数，已夹取到 [1, LOG_MAX_N]。 */
  n: number
  /** 输出形态：table 聊天表格；json/csv 原始数据导出。 */
  format: 'table' | 'json' | 'csv'
}

/**
 * 解析 /jev-log 的 rawInput（`[n] [--json] [--csv]`）。
 * n 缺省 20、非数字忽略、越界夹取；--json 与 --csv 同给按 --json。
 * @param raw - 命令名之后的原始输入。
 */
export function parseLogArgs(raw: string): LogArgs {
  const tokens = raw.trim().split(/\s+/).filter(token => token.length > 0)
  let n: number | undefined
  let format: LogArgs['format'] = 'table'
  for (const token of tokens) {
    if (token === '--json') format = 'json'
    else if (token === '--csv') {
      if (format !== 'json') format = 'csv'
    } else {
      const parsed = Number.parseInt(token, 10)
      if (Number.isFinite(parsed)) n = parsed
    }
  }
  return { n: Math.min(LOG_MAX_N, Math.max(1, n ?? LOG_DEFAULT_N)), format }
}

/**
 * 把 limit 查询参数（字符串或数字）夹取到 [1, LOG_MAX_N]；非法回退 fallback。
 * @param value - 原始查询参数值。
 * @param fallback - 非法时的回退值。
 */
export function clampLogLimit(value: string | number | null | undefined, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(LOG_MAX_N, Math.max(1, parsed))
}

/**
 * 明细表 detail 摘要：压平换行为空格并截断到 maxChars 加省略号。
 * @param detail - 原始 detail（只含枚举与数值 token，无敏感数据）。
 * @param maxChars - 截断上限（默认 48）。
 */
export function detailPreview(detail: string | undefined, maxChars = 48): string {
  if (detail === undefined) return '—'
  const flat = detail.replaceAll(/\s+/g, ' ').trim()
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars)}…`
}

/** 明细表短标签（比 TAG_LABELS 更紧凑，含全部 tag）。 */
const LOG_TAG_LABELS: Readonly<Record<string, string>> = {
  guard: '守门',
  preapprove: '预批',
  'session-reference': '保留',
  'approval-loop': '一致率',
  stagnation: '停滞',
}

/** 明细表模式短标签。 */
const LOG_MODE_LABELS: Readonly<Record<string, string>> = {
  shadow: '观察',
  enforce: '执行',
}

/** 明细表动作短标签（复用 ACTION_LABELS 的键，取两字形态）。 */
const LOG_ACTION_LABELS: Readonly<Record<string, string>> = {
  delegate: '放行',
  ask: '转人工',
  deny: '拒绝',
  'auto-approve': '自动批',
  human: '人工',
  degraded: '降级',
  skipped: '跳过',
  'retention-scored': '打分',
  'retention-fifo': 'FIFO',
  agreement: '一致',
  'stagnation-alert': '提醒',
}

/**
 * 渲染最近决策明细表（新→旧）：时间(UTC)│挂点│工具│模式│动作│延迟│理由。
 * @param entries - 明细记录（旧→新，内部反转展示）。
 * @param fullPath - 当前日志文件全量路径（页脚展示，可选）。
 * @returns 自带 ``` 包裹的中文表格。
 */
export function renderLogTable(entries: readonly TelemetryEntry[], fullPath?: string): string {
  const lines: string[] = ['```']
  lines.push(`⚡ dsh-jev-interceptor 决策明细（最近 ${String(entries.length)} 条）`)
  lines.push('')
  for (const entry of [...entries].reverse()) {
    const time = entry.ts.slice(11, 19)
    const tag = LOG_TAG_LABELS[entry.tag] ?? entry.tag
    const mode = LOG_MODE_LABELS[entry.mode] ?? entry.mode
    const action = LOG_ACTION_LABELS[entry.action] ?? entry.action
    const latency = entry.latencyMs === undefined ? '—' : `${String(entry.latencyMs)}ms`
    lines.push(
      `${time} ${padEnd(tag, 6)} ${padEnd(entry.tool ?? '—', 10)} ${mode} ${padEnd(action, 6)}`
      + ` ${padEnd(latency, 6)} ${detailPreview(entry.detail)}${entry.cached === true ? ' ⚡' : ''}`,
    )
  }
  lines.push('')
  lines.push('━'.repeat(44))
  lines.push('  导出: /jev-log <n> --json | --csv')
  if (fullPath !== undefined) lines.push(`  全量: ${fullPath}`)
  lines.push('```')
  return lines.join('\n')
}

/** CSV 导出列（表头即这些键名）。 */
export const LOG_CSV_COLUMNS = [
  'ts', 'tag', 'mode', 'tool', 'callId', 'action', 'detail', 'latencyMs', 'cached', 'inputTokens', 'costUsd',
] as const

/** RFC 4180 转义：含逗号/引号的字段引号包裹、内部引号翻倍、换行压平为空格。 */
function csvCell(value: string): string {
  const flat = value.replaceAll(/\s+/g, ' ')
  if (/[",]/.test(flat)) return `"${flat.replaceAll('"', '""')}"`
  return flat
}

/**
 * 导出为 CSV：表头行 + 每条一行（detail 只含枚举与数值 token，无敏感数据）。
 * @param entries - 要导出的记录。
 */
export function toLogCsv(entries: readonly TelemetryEntry[]): string {
  const rows = [LOG_CSV_COLUMNS.join(',')]
  for (const entry of entries) {
    const cells = LOG_CSV_COLUMNS.map(column => {
      const value = (entry as unknown as Record<string, unknown>)[column]
      return csvCell(value === undefined || value === null ? '' : String(value))
    })
    rows.push(cells.join(','))
  }
  return rows.join('\n')
}

/**
 * 导出为紧凑 JSON 数组（jq 可直接消费）。
 * @param entries - 要导出的记录。
 */
export function toLogJson(entries: readonly TelemetryEntry[]): string {
  return JSON.stringify(entries)
}
