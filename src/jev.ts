/**
 * The Jev decision client: one bounded, cached, cooldown-gated, concurrency-
 * limited call path shared by every hook. Degradation is a first-class
 * outcome — `classify` returns `null` and the caller falls back to stock dsh
 * behavior, so the plugin never widens permissions or blocks a step because
 * the provider is down. Telemetry for degraded calls is written here; the
 * hooks record the final action entries for answered calls.
 *
 * Failure accounting: timeouts, network errors, and HTTP failures all count
 * toward the cooldown gate; a caller-side abort (the tool call was cancelled)
 * does not. One retry is attempted for 429/529/5xx inside the remaining budget.
 * @module dsh-jev-interceptor/jev
 */

import { createHash } from 'node:crypto'
import type { JevAnswers, JevQuestion } from './types.js'
import { parseAnswers } from './types.js'
import { CooldownGate, LruCache, Semaphore, type Now } from './resilience.js'
import { estimateCostUsd, type DecisionTag, type Telemetry } from './telemetry.js'

/** One successful decision. */
export interface ClassifyResult {
  readonly answers: JevAnswers
  /** Model version reported by the provider (pin-aware logging). */
  readonly model: string
  readonly latencyMs: number
  readonly inputTokens: number | undefined
  readonly costUsd: number | undefined
  readonly cached: boolean
}

/** Why one call degraded. */
export type DegradeReason =
  | 'no-key'
  | 'cooldown'
  | 'aborted'
  | 'timeout'
  | 'http-error'
  | 'invalid-response'

/** Constructor dependencies; everything ambient is injected for tests. */
export interface JevClientOptions {
  readonly endpoint: string
  readonly model: string
  readonly timeoutMs: number
  readonly cooldownMs: number
  readonly failureThreshold: number
  readonly maxConcurrency: number
  readonly cacheSize: number
  /** Resolves the API key per call; `undefined` degrades without counting a failure. */
  readonly resolveKey: () => Promise<string | undefined>
  readonly telemetry: Telemetry
  /** Minimal logger surface (cordis `ctx.logger` satisfies this). */
  readonly logger: { warn: (message: string) => void }
  readonly fetchFn?: typeof fetch
  readonly now?: Now
}

/** One classify call. */
export interface ClassifyCall {
  /** Hook asking, for telemetry. */
  readonly tag: DecisionTag
  readonly mode: 'shadow' | 'enforce'
  readonly tool?: string
  readonly sessionId?: string
  readonly state: string | Readonly<Record<string, unknown>>
  readonly questions: Readonly<Record<string, JevQuestion>>
  readonly signal?: AbortSignal
}

/** Terminal failure of one request, or the parsed success payload. */
type RequestOutcome =
  | 'caller-aborted'
  | 'timeout'
  | 'retryable'
  | 'http-error'
  | 'invalid-response'
  | { answers: JevAnswers; model: string; inputTokens: number | undefined; costUsd: number | undefined }

/**
 * Bounded Jev caller with cache, cooldown, and concurrency control.
 */
export class JevClient {
  private readonly endpoint: string
  private readonly model: string
  private readonly timeoutMs: number
  private readonly cooldownMs: number
  private readonly resolveKey: JevClientOptions['resolveKey']
  private readonly telemetry: Telemetry
  private readonly logger: JevClientOptions['logger']
  private readonly fetchFn: typeof fetch
  private readonly now: Now
  private readonly gate: CooldownGate
  private readonly semaphore: Semaphore
  private readonly cache: LruCache<string, ClassifyResult>

  /**
   * @param options - endpoints, budgets, key resolution, telemetry, logger.
   */
  constructor(options: JevClientOptions) {
    this.endpoint = options.endpoint
    this.model = options.model
    this.timeoutMs = options.timeoutMs
    this.cooldownMs = options.cooldownMs
    this.resolveKey = options.resolveKey
    this.telemetry = options.telemetry
    this.logger = options.logger
    this.fetchFn = options.fetchFn ?? fetch
    this.now = options.now ?? Date.now
    this.gate = new CooldownGate(options.failureThreshold, options.cooldownMs, this.now)
    this.semaphore = new Semaphore(options.maxConcurrency)
    this.cache = new LruCache(options.cacheSize)
  }

  /**
   * Ask Jev one batch of typed questions over one state.
   * @param call - hook context, state, questions, and cancellation.
   * @returns the decision, or `null` when the call degraded (never throws).
   */
  async classify(call: ClassifyCall): Promise<ClassifyResult | null> {
    const started = this.now()
    const degrade = (reason: DegradeReason): null => {
      this.telemetry.record({
        ts: new Date().toISOString(),
        tag: call.tag,
        mode: call.mode,
        ...(call.tool === undefined ? {} : { tool: call.tool }),
        ...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }),
        action: 'degraded',
        detail: reason,
        ...(reason === 'no-key' || reason === 'cooldown' ? {} : { latencyMs: this.now() - started }),
      })
      return null
    }

    const key = await this.resolveKey()
    if (key === undefined || key.length === 0) return degrade('no-key')
    if (this.gate.open()) return degrade('cooldown')

    const cacheKey = createHash('sha256')
      .update(JSON.stringify([this.model, call.state, call.questions]))
      .digest('hex')
    const hit = this.cache.get(cacheKey)
    if (hit !== undefined) return { ...hit, cached: true }

    if (call.signal?.aborted) return degrade('aborted')
    const acquired = await this.semaphore.acquire(call.signal ?? new AbortController().signal)
    if (!acquired) return degrade('aborted')
    try {
      const outcome = await this.request(call, key, started)
      if (typeof outcome === 'string') {
        if (outcome === 'caller-aborted') return degrade('aborted')
        if (outcome === 'timeout') this.countFailure('timeout')
        else this.countFailure(outcome)
        return degrade(outcome === 'retryable' ? 'http-error' : outcome)
      }
      this.gate.onSuccess()
      const result: ClassifyResult = {
        ...outcome,
        latencyMs: this.now() - started,
        cached: false,
      }
      this.cache.set(cacheKey, result)
      return result
    } finally {
      this.semaphore.release()
    }
  }

  /** One or two HTTP attempts inside the wall-clock budget. */
  private async request(call: ClassifyCall, key: string, started: number): Promise<RequestOutcome> {
    let attempt = 0
    // At most two attempts; the second only for retryable statuses with budget left.
    for (;;) {
      attempt += 1
      const budget = this.timeoutMs - (this.now() - started)
      if (budget <= 0) return call.signal?.aborted ? 'caller-aborted' : 'timeout'
      const timer = AbortSignal.timeout(budget)
      const signal = call.signal === undefined ? timer : AbortSignal.any([call.signal, timer])
      let response: Response
      try {
        response = await this.fetchFn(this.endpoint, {
          method: 'POST',
          headers: {
            'authorization': `Bearer ${key}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: this.model,
            state: call.state,
            questions: call.questions,
          }),
          signal,
        })
      } catch (error) {
        if (call.signal?.aborted) return 'caller-aborted'
        if (timer.aborted || error instanceof Error && error.name === 'AbortError') return 'timeout'
        return 'http-error'
      }
      if (response.status === 429 || response.status === 529 || response.status >= 500) {
        if (attempt < 2 && this.timeoutMs - (this.now() - started) > 400) {
          await sleep(400, call.signal)
          continue
        }
        return 'retryable'
      }
      if (!response.ok) return 'http-error'
      try {
        const body: unknown = await response.json()
        if (typeof body !== 'object' || body === null) return 'invalid-response'
        const record = body as Record<string, unknown>
        const answers = parseAnswers(record['answers'])
        const usage = typeof record['usage'] === 'object' && record['usage'] !== null
          ? record['usage'] as Record<string, unknown>
          : {}
        const inputTokens = typeof usage['input_tokens'] === 'number' ? usage['input_tokens'] : undefined
        const reportedCost = typeof usage['cost'] === 'number' ? usage['cost'] : undefined
        return {
          answers,
          model: typeof record['model'] === 'string' ? record['model'] : this.model,
          inputTokens,
          costUsd: reportedCost ?? estimateCostUsd(inputTokens),
        }
      } catch {
        // parseAnswers throws on malformed bodies; a parse failure is a protocol failure.
        if (call.signal?.aborted) return 'caller-aborted'
        return 'invalid-response'
      }
    }
  }

  /** Count one provider failure and warn exactly when the gate opens. */
  private countFailure(kind: string): void {
    if (this.gate.onFailure()) {
      this.logger.warn(
        `dsh-jev-interceptor: provider failing (${kind}); entering cooldown for ${this.cooldownMs}ms — decisions degrade to stock behavior`,
      )
    }
  }
}

/** Cancellable bounded sleep. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
