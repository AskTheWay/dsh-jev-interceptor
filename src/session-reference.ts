/**
 * Jev-scored session-reference retention: takes over the `session-reference`
 * row by subclassing its resolver, so every upstream behavior — @-mention
 * discovery, the remote candidates face, budgets, spill, notices, cancellation
 * — stays inherited and tracks the original plugin. Only the retention policy
 * changes hands: instead of dropping the OLDEST messages until the snapshot
 * fits (FIFO), the plugin scores each droppable message's value for the citing
 * task in one Jev fan-out and drops the LEAST valuable first.
 *
 * Safety posture mirrors the rest of the plugin:
 * - `sessionReferenceEnabled: false` (default) is a pure passthrough: every
 *   render delegates to the inherited upstream renderer, byte for byte;
 * - `mode: shadow` computes scores and records the would-be difference in
 *   telemetry while still rendering the upstream FIFO result;
 * - `mode: enforce` lets the scores order drops and truncation targets;
 * - any scoring failure (no key, cooldown, timeout, parse mismatch, internal
 *   error) leaves no scores, and the render falls back to upstream.
 *
 * The upstream render entry is synchronous, so scores are pre-warmed
 * asynchronously in `prepare` (an extra local surface read) and consumed
 * synchronously from a per-snapshot cache — the sync contract of the render
 * pipeline is never violated.
 * @module dsh-jev-interceptor/session-reference
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionReferenceError, SessionReferenceResolver } from '@deepseek-ai/dsh-session-reference'
import type { Config as BaseConfig, SessionReferenceInput } from '@deepseek-ai/dsh-session-reference'
// Type-only: registers the 'sessionQuery' Context key used by the pre-warm reads.
import type {} from '@deepseek-ai/dsh-session-query'
import type { SessionSurfaceSnapshot } from '@deepseek-ai/dsh-session-query'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import {
  previewAt,
  projectConversation,
  retainScoredSession,
  scoreCandidateIndices,
  type ReferencedSessionData,
  type ReferenceRetentionStats,
} from './retention.js'
import { JevClient } from './jev.js'
import { Telemetry } from './telemetry.js'
import { score as scoreQuestion } from './types.js'

/** One source as the inherited renderer receives it (structural view of the upstream private type). */
interface PreparedSourceLike {
  readonly snapshot: SessionSurfaceSnapshot
  readonly input: { readonly sessionId: string; readonly label: string }
}

/** One rendered source as the inherited pipeline consumes it. */
interface RenderedSourceLike {
  readonly data: ReferencedSessionData
  readonly fullData: ReferencedSessionData
  readonly stats: ReferenceRetentionStats
  readonly capturedFormatVersion: number
}

/**
 * Plugin configuration: the base resolver's fields pass through unchanged,
 * plus the retention-scoring controls and the Jev provider connection (this
 * row owns its own client; defaults align with the interceptor row).
 */
export interface Config extends BaseConfig {
  /** `false` (default) renders exactly like the upstream resolver; `true` arms Jev scoring. */
  sessionReferenceEnabled?: boolean
  /** `shadow` (default) records would-be retention only; `enforce` lets scores order drops. */
  mode?: 'shadow' | 'enforce'
  /** Provider entry point selection, shared vocabulary with the interceptor row. */
  provider?: 'typesafe' | 'openrouter' | 'custom'
  /** Full decisions endpoint URL; required for `custom`. */
  endpoint?: string
  /** Model id; defaults to the provider preset. */
  model?: string
  /** Credential reference resolved per scoring request. */
  apiKeyEnv?: string
  /** Wall-clock budget per scoring request in milliseconds (default 2500; one-shot hook, tolerant). */
  timeoutMs?: number
  /** Cooldown after consecutive provider failures in milliseconds (default 60000). */
  cooldownMs?: number
  /** Consecutive failures that open the cooldown (default 3). */
  failureThreshold?: number
  /** Maximum in-flight Jev requests (default 4). */
  maxConcurrency?: number
  /** Decision input cache capacity (default 512). */
  cacheSize?: number
  /** Telemetry directory (default `<dsh-home>/plugins/dsh-jev-interceptor`). */
  telemetryDir?: string
  /** Maximum messages scored per referenced session (default 40; beyond it, FIFO order applies). */
  maxScored?: number
  /** Per-message preview bound in the scoring state, characters (default 300). */
  previewChars?: number
  /** Citing-message anchor bound in the scoring state, characters (default 500). */
  taskChars?: number
}

export const Config: z<Config> = z.object({
  maxReferences: z.number().step(1).min(1),
  candidateLimit: z.number().step(1).min(1),
  maxReferenceBytes: z.number().step(1).min(1),
  referenceContextFraction: z.number().min(0).max(1),
  sessionReferenceEnabled: z.boolean().default(false),
  mode: z.union(['shadow', 'enforce']).default('shadow'),
  provider: z.union(['typesafe', 'openrouter', 'custom']).default('typesafe'),
  endpoint: z.string(),
  model: z.string(),
  apiKeyEnv: z.string().role('credential-ref').default('TYPESAFE_API_KEY'),
  timeoutMs: z.number().step(1).min(100).default(2500),
  cooldownMs: z.number().step(1).min(1000).default(60_000),
  failureThreshold: z.number().step(1).min(1).default(3),
  maxConcurrency: z.number().step(1).min(1).max(8).default(4),
  cacheSize: z.number().step(1).min(0).default(512),
  telemetryDir: z.string(),
  maxScored: z.number().step(1).min(1).max(80).default(40),
  previewChars: z.number().step(1).min(40).default(300),
  taskChars: z.number().step(1).min(40).default(500),
})

/** The four ordered value levels every scored message is judged against. */
const VALUE_LEVELS = [
  'noise: greetings, boilerplate, or one-off operations already superseded',
  'background: context that helps but is not required',
  'relevant: materially affects understanding the task',
  'critical: key decisions, error evidence, or unresolved threads',
] as const

/** Highest score-cache entries retained (one per referenced session per step). */
const SCORE_CACHE_LIMIT = 16

/**
 * The scored session-reference resolver. Registers under the same Context
 * service name as the upstream resolver (`sessionReferenceResolver`), so the
 * composed surface — including the Web `@` completion — routes here and
 * inherits every upstream behavior.
 */
export default class JevSessionReferenceResolver extends SessionReferenceResolver {
  static inject = ['sessionQuery']
  static Config: z<Config> = Config

  private readonly scoring: {
    readonly mode: 'shadow' | 'enforce'
    readonly jev: JevClient
    readonly telemetry: Telemetry
    readonly maxScored: number
    readonly previewChars: number
    readonly taskChars: number
  } | undefined
  private readonly scoreCache = new Map<string, ReadonlyMap<number, number>>()

  /**
   * @param ctx - plugin context.
   * @param config - validated row configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    if (config.sessionReferenceEnabled === true) {
      const telemetry = new Telemetry(
        config.telemetryDir && config.telemetryDir.length > 0
          ? config.telemetryDir
          : dshHomePath('plugins', 'dsh-jev-interceptor'),
      )
      const { endpoint, model } = resolveProvider(config)
      const ref = credentialRef(config.apiKeyEnv ?? 'TYPESAFE_API_KEY')
      const resolveKey = async (): Promise<string | undefined> => {
        const credentials = ctx.get('credentials')
        if (credentials !== undefined) {
          const hit = await credentials.resolve(ref)
          if (hit !== undefined && hit.value.length > 0) return hit.value
          return undefined
        }
        const ambient = launchEnvironmentOf(ctx).get(ref)
        if (ambient !== undefined && ambient.value.length > 0) return ambient.value
        return undefined
      }
      this.scoring = {
        mode: config.mode ?? 'shadow',
        jev: new JevClient({
          endpoint,
          model,
          timeoutMs: config.timeoutMs ?? 2500,
          cooldownMs: config.cooldownMs ?? 60_000,
          failureThreshold: config.failureThreshold ?? 3,
          maxConcurrency: config.maxConcurrency ?? 4,
          cacheSize: config.cacheSize ?? 512,
          resolveKey,
          telemetry,
          logger: ctx.logger,
        }),
        telemetry,
        maxScored: config.maxScored ?? 40,
        previewChars: config.previewChars ?? 300,
        taskChars: config.taskChars ?? 500,
      }
    }

    // Shadow the inherited (TS-private, synchronous) renderer with the scored
    // one. The inherited implementation stays the fallback for every render
    // without scores, so the default is byte-for-byte upstream behavior.
    const self = this as unknown as {
      renderSources: (sources: readonly PreparedSourceLike[], maxReferenceBytes: number) => RenderedSourceLike[]
    }
    const upstream = self.renderSources.bind(self)
    self.renderSources = (sources, maxReferenceBytes) => this.renderScored(upstream, sources, maxReferenceBytes)
  }

  /**
   * Pre-warm message scores before the inherited preparation renders the
   * snapshot synchronously. Scoring failures are swallowed: no scores means
   * the render keeps the upstream retention.
   * @param agent - agent entering the model step.
   * @param content - already host-normalized readable message content.
   * @param references - structured source sessions in mention order.
   * @param signal - optional cancellation boundary for the active turn.
   * @returns the inherited preparation result.
   */
  override async prepare(
    agent: Agent,
    content: ContentBlock[],
    references: SessionReferenceInput[],
    signal?: AbortSignal,
  ): Promise<{ content: ContentBlock[]; additionalContext?: UserMessage }> {
    try {
      await this.prewarmScores(agent, content, references, signal)
    } catch {
      // Scoring is best-effort; retention falls back to upstream FIFO.
    }
    return super.prepare(agent, content, references, signal)
  }

  /** Score the droppable messages of every referenced session once per step. */
  private async prewarmScores(
    agent: Agent,
    content: ContentBlock[],
    references: readonly SessionReferenceInput[],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (this.scoring === undefined) return
    if (signal?.aborted === true) return
    const task = content
      .flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
      .join('\n')
      .slice(0, this.scoring.taskChars)
    const seen = new Set<string>()
    for (const reference of references) {
      if (typeof reference.sessionId !== 'string') continue
      if (reference.sessionId === agent.id || seen.has(reference.sessionId)) continue
      seen.add(reference.sessionId)
      const snapshot = await this.ctx.sessionQuery.readSurface(reference.sessionId)
      await this.scoreSnapshot(reference.sessionId, reference.label ?? reference.sessionId, task, snapshot, signal)
    }
  }

  /** One Jev fan-out over the droppable messages of one referenced session. */
  private async scoreSnapshot(
    sessionId: string,
    label: string,
    task: string,
    snapshot: SessionSurfaceSnapshot,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const scoring = this.scoring
    if (scoring === undefined) return
    const projected = projectConversation(snapshot)
    const indices = scoreCandidateIndices(projected, scoring.maxScored)
    if (indices.length === 0) return
    const questions: Record<string, ReturnType<typeof scoreQuestion>> = {}
    for (const index of indices) {
      questions[`msg_${index}`] = scoreQuestion(
        `Score this message's value for the task in \`task\`, judging the preview in \`messages.${index}\``,
        [...VALUE_LEVELS],
      )
    }
    const result = await scoring.jev.classify({
      tag: 'session-reference',
      mode: scoring.mode,
      sessionId,
      state: {
        task,
        referenced_session: label,
        messages: indices.map(index => ({
          index,
          role: projected[index]?.role ?? 'user',
          preview: previewAt(projected, index, scoring.previewChars),
        })),
      },
      questions,
      ...(signal === undefined ? {} : { signal }),
    })
    if (result === null) return
    const scores = new Map<number, number>()
    for (const index of indices) {
      const answer = result.answers[`msg_${index}`]
      if (answer === undefined || answer.type !== 'score') continue
      // Four levels land in [0, 3]; normalize into the [0, 1] keep-score space.
      scores.set(index, Math.min(1, Math.max(0, answer.score / (VALUE_LEVELS.length - 1))))
    }
    if (scores.size === 0) return
    if (this.scoreCache.size >= SCORE_CACHE_LIMIT) {
      const oldest = this.scoreCache.keys().next()
      if (oldest.done !== true) this.scoreCache.delete(oldest.value)
    }
    this.scoreCache.set(cacheKey(sessionId, snapshot), scores)
  }

  /** Render with scores where available; delegate to the inherited renderer otherwise. */
  private renderScored(
    upstream: (sources: readonly PreparedSourceLike[], maxReferenceBytes: number) => RenderedSourceLike[],
    sources: readonly PreparedSourceLike[],
    maxReferenceBytes: number,
  ): RenderedSourceLike[] {
    if (this.scoring === undefined) return upstream(sources, maxReferenceBytes)
    const rendered: RenderedSourceLike[] = []
    for (const source of sources) {
      const scores = this.scoreCache.get(cacheKey(source.input.sessionId, source.snapshot))
      if (scores === undefined) {
        rendered.push(...upstream([source], maxReferenceBytes))
        continue
      }
      // The scored selection (drop policy driven by value scores).
      const scored = retainScoredSession(source.snapshot, source.input.label, maxReferenceBytes, scores)
      if (scored === undefined) {
        // Scoring cannot resize past what FIFO could; upstream raises the same error.
        rendered.push(...upstream([source], maxReferenceBytes))
        continue
      }
      if (this.scoring.mode === 'enforce') {
        this.recordComparison(source, scored, maxReferenceBytes, scores)
        rendered.push({ ...scored, capturedFormatVersion: source.snapshot.session.version })
        continue
      }
      // Shadow: the real render stays the upstream bytes; the scored selection
      // is only the recorded counterfactual.
      const upstreamRendered = upstream([source], maxReferenceBytes)
      this.recordComparison(source, scored, maxReferenceBytes, scores)
      rendered.push(...upstreamRendered)
    }
    return rendered
  }

  /** Record the would-be difference between scored and FIFO retention. */
  private recordComparison(
    source: PreparedSourceLike,
    scored: { data: ReferencedSessionData; stats: ReferenceRetentionStats },
    maxReferenceBytes: number,
    scores: ReadonlyMap<number, number>,
  ): void {
    if (this.scoring === undefined) return
    const fifo = retainScoredSession(source.snapshot, source.input.label, maxReferenceBytes, null)
    if (fifo === undefined) return
    const keptScored = new Set(scored.data.conversation.map(item => `${item.role}\0${item.text}`))
    const keptFifo = new Set(fifo.data.conversation.map(item => `${item.role}\0${item.text}`))
    let overlapDropped = 0
    let scoredOnlyDropped = 0
    let fifoOnlyDropped = 0
    for (const item of projectConversation(source.snapshot)) {
      const key = `${item.role}\0${item.text}`
      const inScored = keptScored.has(key)
      const inFifo = keptFifo.has(key)
      if (!inScored && !inFifo) overlapDropped += 1
      else if (!inScored) scoredOnlyDropped += 1
      else if (!inFifo) fifoOnlyDropped += 1
    }
    void scores
    this.scoring.telemetry.record({
      ts: new Date().toISOString(),
      tag: 'session-reference',
      mode: this.scoring.mode,
      sessionId: source.input.sessionId,
      action: this.scoring.mode === 'enforce' ? 'retention-scored' : 'retention-fifo',
      detail: `messages=${scored.stats.originalMessages} kept(scored)=${scored.stats.retainedMessages}`
        + ` kept(fifo)=${fifo.stats.retainedMessages} dropped(both)=${overlapDropped}`
        + ` dropped(scored-only)=${scoredOnlyDropped} dropped(fifo-only)=${fifoOnlyDropped}`,
    })
  }
}

/** Cache key for one referenced session observation. */
function cacheKey(sessionId: string, snapshot: SessionSurfaceSnapshot): string {
  return `${sessionId}\0${snapshot.capturedThroughSeq ?? 'null'}`
}

/** Resolve endpoint and model for the configured provider (shared vocabulary with the interceptor). */
function resolveProvider(config: Config): { endpoint: string; model: string } {
  if (config.provider === 'openrouter') {
    return {
      endpoint: config.endpoint ?? 'https://openrouter.ai/api/alpha/decisions',
      model: config.model ?? '~typesafe/jev-latest',
    }
  }
  if (config.provider === 'custom') {
    if (config.endpoint === undefined || config.model === undefined) {
      throw new SessionReferenceError(
        'jev-session-reference: provider "custom" requires endpoint and model',
        'SESSION_REFERENCE_INVALID_CONFIG',
      )
    }
    return { endpoint: config.endpoint, model: config.model }
  }
  return {
    endpoint: config.endpoint ?? 'https://api.typesafe.ai/v1/systemone',
    model: config.model ?? 'jev-latest',
  }
}
