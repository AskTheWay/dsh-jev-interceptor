/**
 * Append-only JSONL telemetry and its aggregation for `/jev-stats`. Writes are
 * fire-and-forget with self-contained failure handling: telemetry must never
 * break a decision path. Entries carry the question outcomes, the action that
 * was taken (or would have been taken in shadow mode), latency, token usage,
 * and cost, so the log doubles as threshold-tuning data.
 * @module dsh-jev-interceptor/telemetry
 */

import { appendFile, mkdir, readFile, stat, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { LruCache } from './resilience.js'

/** Where a decision came from. */
export type DecisionTag = 'guard' | 'preapprove'

/** What the plugin did (or, in shadow mode, would have done). */
export type DecisionAction =
  | 'delegate'
  | 'ask'
  | 'deny'
  | 'auto-approve'
  | 'human'
  | 'degraded'
  | 'skipped'

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
}

/** Price used to estimate cost when the provider does not report one (USD per input megatok); Jev published rate. */
const JEV_USD_PER_MTOK = 0.042

/** Rotate the log above this size (bytes). */
const ROTATE_BYTES = 20 * 1024 * 1024

/**
 * File-backed telemetry writer plus a small in-memory aggregator.
 */
export class Telemetry {
  private readonly file: string
  private dirReady: Promise<void> | undefined
  private rotated = false
  private readonly aggregate: LruCache<string, TagStats>

  /**
   * @param dir - directory for `telemetry.jsonl` (created on first write).
   */
  constructor(dir: string) {
    this.file = join(dir, 'telemetry.jsonl')
    this.aggregate = new LruCache(16)
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
    this.fold(entry)
  }

  /**
   * Render per-hook aggregates for the `/jev-stats` command.
   * @returns a human-readable plain-text report.
   */
  async stats(): Promise<string> {
    await this.ready().catch(() => undefined)
    const entries = await this.readEntries()
    const tags = new Map<string, TagStats>()
    for (const entry of entries) {
      const stats = tags.get(entry.tag) ?? emptyStats()
      foldInto(stats, entry)
      tags.set(entry.tag, stats)
    }
    if (tags.size === 0) return 'dsh-jev-interceptor: no decisions recorded yet.'
    const lines: string[] = ['dsh-jev-interceptor decisions (from telemetry log):', '']
    for (const [tag, stats] of tags) {
      lines.push(`[${tag}] calls: ${stats.calls}  degraded: ${stats.degraded}  cached: ${stats.cached}`)
      const actions = [...stats.byAction.entries()].map(([action, n]) => `${action}=${n}`).join(' ')
      lines.push(`  actions: ${actions.length > 0 ? actions : 'none'}`)
      lines.push(`  input tokens: ${stats.totalInputTokens}  est. cost: $${stats.totalCostUsd.toFixed(6)}`)
      const latency = percentileLine(stats.latencies)
      if (latency !== undefined) lines.push(`  latency: ${latency}`)
      lines.push('')
    }
    return lines.join('\n')
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

  /** Fold one entry into the in-memory aggregate (also used by stats()). */
  private fold(entry: TelemetryEntry): void {
    const stats = this.aggregate.get(entry.tag) ?? emptyStats()
    foldInto(stats, entry)
    this.aggregate.set(entry.tag, stats)
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
  if (entry.latencyMs !== undefined) stats.latencies.push(entry.latencyMs)
}

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
