/**
 * Byte-bounded rendering of one referenced session's conversation, forked
 * from `@deepseek-ai/dsh-session-reference/src/projection.ts` with one change:
 * the retention policy. The upstream algorithm drops whole messages FIFO
 * (oldest first) and then truncates the longest survivor; this fork orders
 * both decisions by Jev value scores when they are available and falls back to
 * the exact upstream policy when they are not.
 *
 * Everything else is preserved by construction: the projection rules, the
 * exact rendered JSON and byte accounting, checkpoint and newest-message drop
 * protection, the truncation notice format, and the budget-exhausted
 * `undefined` result. The upstream file is the review template for any drift.
 * @module dsh-jev-interceptor/retention
 */

import type { SessionSurfaceSnapshot } from '@deepseek-ai/dsh-session-query'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import type { OptionalSessionSeq, SessionId } from '@deepseek-ai/dsh-session'

/**
 * Whether a persisted message source identifies a compaction checkpoint,
 * mirrored from `@deepseek-ai/dsh-compaction` (`isCompactCheckpointSource`):
 * a stable public marker (source kind `plugin`, plugin `compact`) kept local
 * so this pure module carries no runtime dependency on the compaction package.
 */
function isCompactCheckpointSource(source: { kind: string; plugin?: string }): boolean {
  return source.kind === 'plugin' && source.plugin === 'compact'
}

/** Session sequence brand, mirrored from `@deepseek-ai/dsh-session` (identity at runtime). */
function toSessionSeq(value: number): OptionalSessionSeq {
  return value as OptionalSessionSeq
}

/** One projected conversation item; `originalText` is pre-truncation, `checkpoint` marks drop protection. */
interface ProjectedItem {
  role: 'user' | 'assistant'
  text: string
  checkpoint: boolean
  originalText: string
  omittedBytes: number
}

/** Snapshot data serialized inside the untrusted prompt (upstream shape). */
export interface ReferencedSessionData {
  sessionId: SessionId
  label: string
  cwd: string | null
  capturedThroughSeq: OptionalSessionSeq
  conversation: { role: 'user' | 'assistant'; text: string }[]
}

/** Retention facts stored beside the durable context (upstream shape). */
export interface ReferenceRetentionStats {
  compacted: boolean
  originalMessages: number
  retainedMessages: number
  omittedMessages: number
  omittedBytes: number
  truncated: boolean
}

/** One scored retention outcome. */
export interface RetainedSession {
  data: ReferencedSessionData
  fullData: ReferencedSessionData
  stats: ReferenceRetentionStats
}

/**
 * Serialize JSON while preventing source data from spelling an XML-like
 * opening tag (byte-for-byte upstream behavior: parse result unchanged, no
 * literal `<` in the payload).
 */
function stringifyTagSafeJson(value: unknown): string {
  const serialized: unknown = JSON.stringify(value)
  if (typeof serialized !== 'string') throw new TypeError('session-reference data is not JSON-serializable')
  return serialized.replaceAll('<', '\\u003c')
}

/** Join the text blocks of one message content (upstream projection rule). */
function textContent(content: readonly { type: string; text?: string }[]): string {
  return content.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n')
}

/**
 * Project current user/assistant conversation while excluding tools,
 * reasoning, and injected context — the upstream projection, unchanged.
 * @param snapshot - current-surface source observation.
 * @returns projected items in log order.
 */
export function projectConversation(snapshot: SessionSurfaceSnapshot): ProjectedItem[] {
  const conversation: ProjectedItem[] = []
  for (const event of snapshot.events) {
    if (event.type === 'user/message') {
      const checkpoint = isCompactCheckpointSource(event.data.source)
      if (!checkpoint && event.data.source.kind !== 'user') continue
      const text = textContent(event.data.content)
      if (text !== '') conversation.push({ role: 'user', text, checkpoint, originalText: text, omittedBytes: 0 })
      continue
    }
    if (event.type === 'assistant/message') {
      const text = textContent(event.data.message.content)
      if (text !== '') conversation.push({ role: 'assistant', text, checkpoint: false, originalText: text, omittedBytes: 0 })
    }
  }
  return conversation
}

/** Indices that whole-message drops may ever consider (upstream protection set). */
function droppableIndices(retained: readonly ProjectedItem[]): number[] {
  const newest = retained.length - 1
  const indices: number[] = []
  for (const [index, item] of retained.entries()) {
    if (!item.checkpoint && index !== newest) indices.push(index)
  }
  return indices
}

/**
 * Fit one projected snapshot into an exact rendered JSON-object byte cap.
 * @param snapshot - current-surface source observation.
 * @param label - host-provided display label serialized with the source.
 * @param maxBytes - maximum UTF-8 bytes for the serialized data object.
 * @param scores - value score per ORIGINAL projection index in `[0, 1]`
 *   (higher = keep); `null` selects the exact upstream FIFO policy.
 * @returns full projected data, retained preview and stats, or `undefined`
 *   when fixed data cannot fit.
 */
export function retainScoredSession(
  snapshot: SessionSurfaceSnapshot,
  label: string,
  maxBytes: number,
  scores: ReadonlyMap<number, number> | null,
): RetainedSession | undefined {
  const original = projectConversation(snapshot)
  const retained = original.map(item => ({ ...item }))
  let omittedMessages = 0
  let droppedOmittedBytes = 0
  const data = (): ReferencedSessionData => ({
    sessionId: snapshot.session.id,
    label,
    cwd: snapshot.session.cwd ?? null,
    capturedThroughSeq: snapshot.capturedThroughSeq === null
      ? null
      : toSessionSeq(snapshot.capturedThroughSeq),
    conversation: retained.map(({ role, text }) => ({ role, text })),
  })
  const fullData = data()
  const size = (): number => Buffer.byteLength(stringifyTagSafeJson(data()), 'utf8')

  // Phase 1 — drop whole messages until the preview fits. Upstream drops the
  // first droppable (FIFO); scored mode drops the LOWEST-SCORED droppable,
  // oldest first on ties (so unscored items degrade back to FIFO order).
  while (size() > maxBytes) {
    const droppable = droppableIndices(retained)
    if (droppable.length === 0) break
    let dropIndex = droppable[0]
    if (scores !== null) {
      let bestScore = Number.POSITIVE_INFINITY
      for (const index of droppable) {
        const score = scores.get(index)
        // Unsourced indices score as neutral; the oldest-first tiebreak keeps
        // behavior FIFO-equivalent among them.
        const value = score === undefined ? 0.5 : score
        if (value < bestScore) {
          bestScore = value
          dropIndex = index
        }
      }
    }
    const removed = retained.splice(dropIndex, 1)[0]
    if (removed === undefined) throw new Error('session-reference retention selected a missing message')
    omittedMessages += 1
    droppedOmittedBytes += Buffer.byteLength(removed.originalText, 'utf8')
  }

  // Phase 2 — truncate survivors until the preview fits. Upstream shortens the
  // longest survivor; scored mode shortens the survivor with the highest
  // wasted bytes (length × droppability), cutting padding before substance.
  while (size() > maxBytes) {
    let targetIndex = -1
    let targetBytes = 0
    let longestIndex = -1
    let longestBytes = 0
    for (const [index, item] of retained.entries()) {
      const bytes = Buffer.byteLength(item.text, 'utf8')
      if (bytes > longestBytes) {
        longestBytes = bytes
        longestIndex = index
      }
      if (scores !== null) {
        const score = scores.get(index)
        const dropability = score === undefined ? 0.5 : 1 - score
        const wasted = bytes * dropability
        if (wasted > targetBytes) {
          targetBytes = wasted
          targetIndex = index
        }
      }
    }
    if (scores === null) targetIndex = longestIndex
    else if (targetIndex < 0) targetIndex = longestIndex
    if (targetIndex < 0 || longestBytes === 0) return undefined
    const overflow = size() - maxBytes
    const target = Math.max(0, Buffer.byteLength(retained[targetIndex]?.text ?? '', 'utf8') - overflow)
    const item = retained[targetIndex]
    if (item === undefined) throw new Error('session-reference retention selected a missing truncation target')
    const shortened = truncateWithNotice(item.originalText, target)
    if (shortened.text === retained[targetIndex]?.text) return undefined
    retained[targetIndex] = { ...item, text: shortened.text, omittedBytes: shortened.omittedBytes }
  }

  const compacted = original.some(item => item.checkpoint)
  const retainedOmittedBytes = retained.reduce((sum, item) => sum + item.omittedBytes, 0)
  const omittedBytes = retainedOmittedBytes + droppedOmittedBytes
  return {
    data: data(),
    fullData,
    stats: {
      compacted,
      originalMessages: original.length,
      retainedMessages: retained.length,
      omittedMessages,
      omittedBytes,
      truncated: omittedMessages > 0 || omittedBytes > 0,
    },
  }
}

/** Head+tail truncation with an omission notice (upstream binary search, unchanged). */
function truncateWithNotice(text: string, maxOutputBytes: number): { text: string; omittedBytes: number } {
  if (Buffer.byteLength(text, 'utf8') <= maxOutputBytes) return { text, omittedBytes: 0 }
  let low = 0
  let high = maxOutputBytes
  let best = { text: '', omittedBytes: Buffer.byteLength(text, 'utf8') }
  while (low <= high) {
    const retainedBytes = Math.floor((low + high) / 2)
    const headBytes = Math.ceil(retainedBytes / 2)
    const tailBytes = Math.floor(retainedBytes / 2)
    const retainer = new TextRetainer({ kind: 'headTail', headBytes, tailBytes })
    retainer.push(text)
    const result = retainer.finish()
    if (result.omittedBytes.kind !== 'exact') {
      throw new Error('session-reference retention did not report exact omitted bytes')
    }
    const omitted = result.omittedBytes.count
    const candidate = `${result.text}\n[… omitted ${omitted} UTF-8 bytes …]`
    if (Buffer.byteLength(candidate, 'utf8') <= maxOutputBytes) {
      best = { text: candidate, omittedBytes: omitted }
      low = retainedBytes + 1
    } else {
      high = retainedBytes - 1
    }
  }
  return best
}

/**
 * Select the original-projection indices worth scoring: the droppable set
 * (non-checkpoint, non-newest) ordered oldest-first, capped so one Jev fan-out
 * stays small. Indices beyond the cap degrade to FIFO order in the drop loop.
 * @param projected - the projected conversation.
 * @param cap - maximum indices to return.
 * @returns original indices to score, oldest first.
 */
export function scoreCandidateIndices(projected: readonly ProjectedItem[], cap: number): number[] {
  const newest = projected.length - 1
  const indices: number[] = []
  for (const [index, item] of projected.entries()) {
    if (!item.checkpoint && index !== newest) indices.push(index)
    if (indices.length >= cap) break
  }
  return indices
}

/**
 * Build a bounded preview of one projected item for the scoring request.
 * @param projected - the projected conversation.
 * @param index - original index to preview.
 * @param maxChars - character bound.
 * @returns the head-bounded preview text.
 */
export function previewAt(projected: readonly ProjectedItem[], index: number, maxChars: number): string {
  const item = projected[index]
  if (item === undefined) return ''
  return item.text.slice(0, maxChars)
}

/** The projected item shape this module works with, for external builders. */
export type { ProjectedItem }
