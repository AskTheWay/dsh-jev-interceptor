/**
 * 校准快照历史：把每次 /jev-calibrate（或面板「生成建议」）的报告要点
 * 追加到 telemetry 同目录的 calibration-history.jsonl，下次运行时对比
 * 「上次建议了什么 → 是否被采纳 → 一致率桶怎么变」。
 *
 * 写入 fire-and-forget 永不抛（照 telemetry.record 的姿态）；读取失败读为
 * 空——历史对比是增值信息，绝不阻塞报告本身。
 * @module dsh-jev-interceptor/calibration-history
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { translate, type Locale, type MessageKey } from './localization.js'
import type { CalibrationReport, ThresholdKey, ThresholdsInput } from './calibrate.js'

/** 可比对的阈值参数（与 ThresholdsInput 同键）。 */
const THRESHOLD_KEYS: readonly ThresholdKey[] = [
  'guardConfidenceMin',
  'guardDenyConfidence',
  'guardIrreversibleCeiling',
  'guardIrreversibleDenyFloor',
  'guardInjectionAskThreshold',
  'preapproveAutoApproveMin',
  'preapproveIrreversibleMax',
  'preapproveInjectionSuspectMax',
]

/** 一份持久化的校准快照（JSONL 一行）。 */
export interface CalibrationSnapshot {
  /** 快照时间（ISO）。 */
  readonly ts: string
  readonly windowSize: number
  /** 当时生效的阈值（采纳判断的基准）。 */
  readonly thresholds: Readonly<Record<string, number>>
  /** 当时的建议（param → suggested）。 */
  readonly advice: ReadonlyArray<{ readonly param: string; readonly current: number; readonly suggested: number }>
  /** 当时的一致率桶计数。 */
  readonly buckets: Readonly<Record<string, number>>
}

/** 从当前配置提取快照的阈值段。 */
function thresholdsRecord(current: ThresholdsInput): Record<string, number> {
  const out: Record<string, number> = {}
  for (const key of THRESHOLD_KEYS) out[key] = current[key]
  return out
}

/** 从报告与当前配置构造一份快照（含一致率桶计数）。 */
export function snapshotOf(
  report: CalibrationReport,
  current: ThresholdsInput,
  now: string,
  buckets: Readonly<Record<string, number>>,
): CalibrationSnapshot {
  return {
    ts: now,
    windowSize: report.windowSize,
    thresholds: thresholdsRecord(current),
    advice: report.advice.map(a => ({ param: a.param, current: a.current, suggested: a.suggested })),
    buckets: { ...buckets },
  }
}

/**
 * File-backed 快照历史：append-only JSONL + 尾部读取。
 */
export class CalibrationHistory {
  private readonly file: string
  private dirReady: Promise<void> | undefined
  /** 串行写队列（照 telemetry 的写序保证）。 */
  private writeQueue: Promise<void> = Promise.resolve()

  /**
   * @param dir - 与 telemetry.jsonl 同目录。
   */
  constructor(dir: string) {
    this.file = join(dir, 'calibration-history.jsonl')
  }

  /**
   * 追加一份快照。永不抛。
   * @param snapshot - 要持久化的快照（含一致率桶）。
   */
  append(snapshot: CalibrationSnapshot): void {
    const line = `${JSON.stringify(snapshot)}\n`
    this.writeQueue = this.writeQueue
      .then(() => this.ready())
      .then(() => appendFile(this.file, line, 'utf8'))
      .catch(() => {
        // 历史是增值信息，写失败不影响报告。
      })
  }

  /**
   * 读取最近的快照（旧→新）。文件不存在或不可读返回空。
   * @param limit - 最多返回几份（默认 10）。
   */
  async recent(limit = 10): Promise<CalibrationSnapshot[]> {
    await this.ready().catch(() => undefined)
    try {
      const raw = await readFile(this.file, 'utf8')
      const snapshots: CalibrationSnapshot[] = []
      for (const line of raw.split('\n')) {
        if (line.length === 0) continue
        try {
          snapshots.push(JSON.parse(line) as CalibrationSnapshot)
        } catch {
          // 撕裂行读为缺失。
        }
      }
      return snapshots.slice(-limit)
    } catch {
      return []
    }
  }

  private ready(): Promise<void> {
    this.dirReady ??= mkdir(dirname(this.file), { recursive: true }).then(() => undefined, () => undefined)
    return this.dirReady
  }
}

/** 与上次快照的对比结果。 */
export interface CalibrationComparison {
  /** 上次快照时间；无历史时 undefined（跳过对比段）。 */
  readonly previousTs: string | undefined
  /** 上次建议里，本次配置已采纳的（current == 上次 suggested，±0.001 容差）。 */
  readonly adopted: ReadonlyArray<{ readonly param: string; readonly suggested: number; readonly now: number }>
  /** 未采纳的（current 仍等于上次 current）。 */
  readonly ignored: ReadonlyArray<{ readonly param: string; readonly suggested: number; readonly now: number }>
  /** 手动改到建议之外的（既非采纳也非未动，如实列出防止"建议凭空消失"）。 */
  readonly manual: ReadonlyArray<{ readonly param: string; readonly suggested: number; readonly now: number }>
  /** 一致率桶变化（本次 - 上次）；窗口口径不同（--all vs 尾窗）时为空且 incomparable。 */
  readonly bucketsDelta: Readonly<Record<string, number>>
  /** 上次与本次的快照窗口口径不同，bucketsDelta 不可比。 */
  readonly incomparable: boolean
}

/**
 * 把当前生效阈值与上一份快照对比。
 * @param current - 当前生效阈值。
 * @param previous - 上一份快照（undefined = 无历史）。
 * @param currentBuckets - 本次的一致率桶计数。
 * @param currentWindowSize - 本次快照的窗口大小（与上次不等时桶变化不可比）。
 */
export function compareWithPrevious(
  current: ThresholdsInput,
  previous: CalibrationSnapshot | undefined,
  currentBuckets: Readonly<Record<string, number>>,
  currentWindowSize?: number,
): CalibrationComparison {
  if (previous === undefined) {
    return { previousTs: undefined, adopted: [], ignored: [], manual: [], bucketsDelta: {}, incomparable: false }
  }
  const adopted: Array<{ param: string; suggested: number; now: number }> = []
  const ignored: Array<{ param: string; suggested: number; now: number }> = []
  const manual: Array<{ param: string; suggested: number; now: number }> = []
  for (const advice of previous.advice) {
    const now = current[advice.param as ThresholdKey]
    if (now === undefined) continue
    if (Math.abs(now - advice.suggested) <= 0.001) {
      adopted.push({ param: advice.param, suggested: advice.suggested, now })
    } else if (Math.abs(now - advice.current) <= 0.001) {
      ignored.push({ param: advice.param, suggested: advice.suggested, now })
    } else {
      manual.push({ param: advice.param, suggested: advice.suggested, now })
    }
  }
  // 窗口口径不同（--all 全量 vs 尾部 2000）时桶是不同分母的累计数，差值无意义。
  const incomparable = currentWindowSize !== undefined && currentWindowSize !== previous.windowSize
  const bucketsDelta: Record<string, number> = {}
  if (!incomparable) {
    const keys = new Set([...Object.keys(previous.buckets), ...Object.keys(currentBuckets)])
    for (const key of keys) {
      const delta = (currentBuckets[key] ?? 0) - (previous.buckets[key] ?? 0)
      if (delta !== 0) bucketsDelta[key] = delta
    }
  }
  return { previousTs: previous.ts, adopted, ignored, manual, bucketsDelta, incomparable }
}

/** 桶名的短标签键（渲染对比段用）。 */
const BUCKET_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  'would-over-approve': 'msg.bucketWouldOverApprove',
  'aligned-approve': 'msg.bucketAlignedApprove',
  'aligned-reject': 'msg.bucketAlignedReject',
  'friction-human-approved': 'msg.bucketFrictionHumanApproved',
  neutral: 'msg.bucketNeutral',
}

/**
 * 快照去抖：与上一份在短时间内（默认 5 分钟）阈值、建议、桶全同则跳过
 * 追加——面板连续点「生成建议」不应堆出成串的重复快照。
 */
export function shouldAppend(previous: CalibrationSnapshot | undefined, next: CalibrationSnapshot, debounceMs = 5 * 60_000): boolean {
  if (previous === undefined) return true
  const gap = Date.parse(next.ts) - Date.parse(previous.ts)
  if (!Number.isFinite(gap) || gap >= debounceMs) return true
  return JSON.stringify(previous.advice) !== JSON.stringify(next.advice)
    || JSON.stringify(previous.thresholds) !== JSON.stringify(next.thresholds)
    || JSON.stringify(previous.buckets) !== JSON.stringify(next.buckets)
}

/**
 * Render the previous-run comparison section (no fence; renderCalibration wraps it).
 * @param comparison - compareWithPrevious output.
 * @param locale - report language (default Chinese for legacy callers).
 * @returns report lines.
 */
export function renderComparisonLines(comparison: CalibrationComparison, locale: Locale = 'zh'): string[] {
  const t = (key: MessageKey, values?: Record<string, string | number>): string => translate(locale, key, values)
  if (comparison.previousTs === undefined) {
    return [t('msg.historyNone')]
  }
  const lines: string[] = []
  lines.push(t('msg.historyTitle', { v0: comparison.previousTs.slice(0, 16).replace('T', ' ') }))
  if (comparison.adopted.length === 0 && comparison.ignored.length === 0 && comparison.manual.length === 0) {
    lines.push(t('msg.historyNoAdvice'))
  }
  for (const item of comparison.adopted) {
    lines.push(t('msg.historyAdopted', { v0: item.param, v1: item.now.toFixed(2) }))
  }
  for (const item of comparison.ignored) {
    lines.push(t('msg.historyIgnored', { v0: item.param, v1: item.suggested.toFixed(2), v2: item.now.toFixed(2) }))
  }
  for (const item of comparison.manual) {
    lines.push(t('msg.historyManual', { v0: item.param, v1: item.suggested.toFixed(2), v2: item.now.toFixed(2) }))
  }
  if (comparison.incomparable) {
    lines.push(t('msg.historyIncomparable'))
  } else {
    const deltaEntries = Object.entries(comparison.bucketsDelta)
    if (deltaEntries.length > 0) {
      const parts = deltaEntries.map(([bucket, delta]) => {
        const key = BUCKET_LABEL_KEYS[bucket]
        const bucketLabel = key === undefined ? bucket : t(key)
        return `${bucketLabel} ${delta > 0 ? `+${String(delta)}` : String(delta)}`
      })
      lines.push(t('msg.historyBuckets', { v0: parts.join(' · ') }))
    }
  }
  return lines
}
