/**
 * Image-offload pre-planning: fills the gap dsh's own README admits —
 * "nothing plans an offload before dispatch", so every offload today costs
 * one failed request. This hook watches token pressure on `agent/pre-step`
 * and, when the pressure is high AND there are candidate images, asks Jev to
 * score each image's residual task value in one fan-out. Only
 * high-confidence sacrificial images (score floor + probability ceiling) are
 * offloaded before the request dispatches.
 *
 * Safety posture:
 * - pure composition: one append listener on `agent/pre-step`, no row replaced
 * - `image/offload` events land in the exact upstream format (projection.ts
 *   consumes them unchanged — replay consistency is a projection invariant)
 * - pre-planning is OPT-IN and defaults OFF (irreversible on disk)
 * - degradation on every path: pressure not met / not enough candidates /
 *   Jev unavailable / low confidence → no action, stock behavior unchanged
 * @module dsh-jev-interceptor/image-offload
 */

import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { JevClient } from './jev.js'
import { score, type ScoreAnswer } from './types.js'
import type { Telemetry } from './telemetry.js'
import type { LiveSettings } from './config.js'

/** Resolved configuration for the pre-planner. */
export interface ImageOffloadDeps {
  readonly live: () => LiveSettings
  /** Pressure threshold [0,1] of contextWindow to trigger planning. */
  readonly pressureThreshold: number
  /** Minimum unoffloaded candidate images to bother scoring. */
  readonly minCandidates: number
  /** A message is sacrificial only when its score answer ≤ this AND its probability ≥ the floor. */
  readonly sacrificeScoreMax: number
  readonly sacrificeProbMin: number
  readonly jev: JevClient
  readonly telemetry: Telemetry
}

/** Depth-first traversal of a message's content blocks to find image blocks (upstream image-offload.ts:23-42 mirror). */
function collectImageCandidates(session: Agent['session']): { seq: number; imageIndexes: number[]; context: string }[] {
  const candidates: { seq: number; imageIndexes: number[]; context: string }[] = []
  const events = session.snapshotEvents()
  const nodes = [...session.surface.nodes]
  for (const seq of nodes) {
    const event = events[seq]
    if (event === undefined || event.type !== 'user/message') continue
    // Skip assistant nodes and already-offloaded images (upstream checks block.offloaded).
    const blocks = event.data.content
    const imageIndexes: number[] = []
    let contextText = ''
    for (const [index, block] of blocks.entries()) {
      if (block.type === 'image' && (block as { offloaded?: boolean }).offloaded !== true) {
        imageIndexes.push(index)
      } else if (block.type === 'text' && typeof (block as { text?: string }).text === 'string') {
        contextText += (block as { text: string }).text + '\n'
      }
    }
    if (imageIndexes.length > 0) {
      candidates.push({ seq, imageIndexes, context: contextText.slice(0, 200) })
    }
  }
  return candidates
}

/**
 * Create the `agent/pre-step` image-offload pre-planner.
 * @param deps - resolved configuration and services.
 * @returns the waterfall listener (register with plain append).
 */
export function createImageOffloadListener(
  deps: ImageOffloadDeps,
): (payload: { agent: Agent; messages: unknown[]; turn: number; step: number; signal: AbortSignal }, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision> {
  return async (payload, next) => {
    const live = deps.live()
    if (!live.enabled) return next()
    const agent = payload.agent
    const session = agent.session

    // L1: pressure gate — read the token meter's latest measurement.
    const tokenMeter = (session as unknown as { tokenMeter?: { totalTokens: number; contextWindow: number } }).tokenMeter
    if (tokenMeter === undefined) return next()
    const contextWindow = tokenMeter.contextWindow || 0
    if (contextWindow <= 0) return next()
    const pressure = tokenMeter.totalTokens / contextWindow
    if (pressure < deps.pressureThreshold) return next()

    // L2: candidate gate — need enough unoffloaded images to be worth a Jev call.
    const candidates = collectImageCandidates(session)
    const imageCount = candidates.reduce((sum, c) => sum + c.imageIndexes.length, 0)
    if (imageCount < deps.minCandidates) return next()

    // L3: Jev scoring — one fan-out over all candidate images.
    const questions: Record<string, ReturnType<typeof score>> = {}
    const flatImages: { seq: number; imageIndex: number; context: string; age: number }[] = []
    let flatIndex = 0
    const totalSeq = session.surface.nodes.length
    for (const candidate of candidates) {
      for (const imageIndex of candidate.imageIndexes) {
        questions[`img_${flatIndex}`] = score(
          `Score this image's residual task value for the current task, judging the surrounding text in \`images.${flatIndex}.context\``,
          [
            'sacrificial: superseded by later results, unrelated to the current task, or trivial decoration',
            'moderate: possibly still referenced but not critical',
            'critical: contains error evidence, visual context for an unresolved issue, or unique data',
          ],
        )
        flatImages.push({
          seq: candidate.seq,
          imageIndex,
          context: candidate.context,
          age: totalSeq - candidate.seq,
        })
        flatIndex += 1
      }
    }

    const result = await deps.jev.classify({
      tag: 'guard',
      mode: live.mode,
      sessionId: session.id,
      state: {
        task: 'Free context by offloading sacrificial images before the next model request',
        images: flatImages.map(img => ({ index: flatImages.indexOf(img), context: img.context, age_in_messages: img.age })),
      },
      questions,
      signal: payload.signal,
    })
    if (result === null) return next()

    // L4: selection — only high-confidence sacrificial images get offloaded.
    const toOffload: { seq: number; imageIndexes: number[] }[] = []
    for (const [index, img] of flatImages.entries()) {
      const answer = result.answers[`img_${index}`]
      if (answer === undefined || answer.type !== 'score') continue
      const scoreAnswer = answer as ScoreAnswer
      if (scoreAnswer.score > deps.sacrificeScoreMax) continue
      const sacrificeProb = scoreAnswer.probabilities?.['0'] ?? 0
      if (sacrificeProb < deps.sacrificeProbMin) continue
      // Group by source message seq.
      const existing = toOffload.find(t => t.seq === img.seq)
      if (existing !== undefined) existing.imageIndexes.push(img.imageIndex)
      else toOffload.push({ seq: img.seq, imageIndexes: [img.imageIndex] })
    }

    if (toOffload.length > 0) {
      // L5: land image/offload events in the exact upstream format.
      for (const target of toOffload) {
        ;(session as unknown as { append: (type: string, data: unknown) => void }).append('image/offload', { targets: [target] })
      }
      deps.telemetry.record({
        ts: new Date().toISOString(),
        tag: 'guard',
        mode: live.mode,
        sessionId: session.id,
        action: 'skipped',
        detail: `image-offload: pre-planned ${toOffload.reduce((s, t) => s + t.imageIndexes.length, 0)} images at pressure ${(pressure * 100).toFixed(0)}%`,
        latencyMs: result.latencyMs,
      })
    }

    return next()
  }
}
