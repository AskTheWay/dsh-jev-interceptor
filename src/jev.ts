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
  /** False when the response omitted its model and this field is the request ID. */
  readonly modelReported?: boolean
  readonly latencyMs: number
  readonly inputTokens: number | undefined
  readonly costUsd: number | undefined
  readonly cached: boolean
}

/** Why one call degraded. */
export type DegradeReason =
  | 'no-key'
  | 'credential-unavailable'
  | 'invalid-connection'
  | 'connection-changed'
  | 'cooldown'
  | 'cost-limit'
  | 'aborted'
  | 'timeout'
  | 'http-error'
  | 'invalid-response'

/** The connection a request uses from credential resolution through response. */
export interface JevConnection {
  readonly endpoint: string
  readonly model: string
  readonly timeoutMs: number
  readonly resolveKey: () => Promise<string | undefined>
}

interface JevClientLimits {
  readonly cooldownMs: number
  readonly failureThreshold: number
  readonly maxConcurrency: number
  readonly cacheSize: number
  /** 每日决策成本限额（USD，本地日界）；缺省 = 不限。getter 形态：与阈值热更新同一模式，改配置即生效。 */
  readonly dailyCostLimitUsd?: () => number
  readonly telemetry: Telemetry
  /** Minimal logger surface (cordis `ctx.logger` satisfies this). */
  readonly logger: { warn: (message: string) => void }
  readonly fetchFn?: typeof fetch
  readonly now?: Now
}

/** Constructor dependencies for a client with a fixed connection. */
export interface JevClientOptions extends JevConnection, JevClientLimits {}

interface ActiveConnection {
  readonly connection: JevConnection
  readonly gate: CooldownGate
  readonly cache: LruCache<string, ClassifyResult>
  reportedModel?: string
}

/** One classify call. */
export interface ClassifyCall {
  /** Hook asking, for telemetry. */
  readonly tag: DecisionTag
  readonly mode: 'shadow' | 'enforce'
  readonly tool?: string
  readonly sessionId?: string
  /** 触发决策的工具调用 id，透传进降级遥测（可答调用由各钩子自行记录）。 */
  readonly callId?: string
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
  | { answers: JevAnswers; model: string; modelReported: boolean; inputTokens: number | undefined; costUsd: number | undefined }

/** 连接测试的最小预算（毫秒）：决策要快速降级，测试是用户主动等待的操作——给足下限。 */
const PING_MIN_BUDGET_MS = 5_000

/** 连接测试结果（错误码由展示层映射为中文）。 */
export interface PingResult {
  readonly ok: boolean
  readonly latencyMs: number
  /** Provider 报告的模型版本（成功时）。 */
  readonly model?: string
  /**
   * `no-key` / `network` / `timeout` / `auth`(401/403) / `not-found`(404) /
   * `rate-limited` (429 reaches the endpoint) / `server` (5xx) / `invalid-response`.
   */
  readonly error?: string
}

/**
 * Bounded Jev caller with cache, cooldown, and concurrency control.
 */
export class JevClient {
  private active: ActiveConnection | undefined
  private readonly cooldownMs: number
  private readonly failureThreshold: number
  private readonly cacheSize: number
  private readonly telemetry: Telemetry
  private readonly logger: JevClientOptions['logger']
  private readonly fetchFn: typeof fetch
  private readonly now: Now
  private readonly semaphore: Semaphore
  private readonly dailyCostLimitUsd: () => number
  /**
   * Degrade-telemetry throttle: a session with no key (or an open cooldown)
   * degrades on EVERY call, which would flood the log with identical rows.
   * A repeated same-reason degrade is recorded at most once per interval
   * and on every reason change.
   */
  private lastDegrade: { reason: string; at: number } | undefined
  /**
   * 当日成本记账（本地日界）：成功计费调用的 costUsd（估算兜底）累加；
   * 重启清零——限额是防失控不是计费。getter 暴露给 status 面板。
   */
  private costToday: { day: string; spent: number } = { day: '', spent: 0 }

  /**
   * @param options - endpoints, budgets, key resolution, telemetry, logger.
   */
  constructor(options: JevClientOptions | (JevClientLimits & { readonly connection: JevConnection | undefined })) {
    this.cooldownMs = options.cooldownMs
    this.failureThreshold = options.failureThreshold
    this.cacheSize = options.cacheSize
    this.telemetry = options.telemetry
    this.logger = options.logger
    this.fetchFn = options.fetchFn ?? fetch
    this.now = options.now ?? Date.now
    this.semaphore = new Semaphore(options.maxConcurrency)
    this.dailyCostLimitUsd = options.dailyCostLimitUsd ?? ((): number => 0)
    this.setConnection('connection' in options ? options.connection : options)
  }

  /** Discard old cached answers and cooldown, while retaining shared spend and concurrency. */
  setConnection(connection: JevConnection | undefined): void {
    this.lastDegrade = undefined
    this.active = connection === undefined ? undefined : {
      connection,
      gate: new CooldownGate(this.failureThreshold, this.cooldownMs, this.now),
      cache: new LruCache(this.cacheSize),
    }
  }

  /** Most recent version identified by the current provider with its active credentials. */
  reportedModel(): string | undefined {
    return this.active?.reportedModel
  }

  /** 当日已花（USD，本地日界；进程内记账，重启清零）。 */
  costTodayUsd(): number {
    this.rollCostDay()
    return this.costToday.spent
  }

  /** 本地日界的 YYYY-MM-DD（现在注入时钟下取本地时区）。 */
  private localDay(): string {
    const date = new Date(this.now())
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }

  /** 跨天重置记账。 */
  private rollCostDay(): void {
    const day = this.localDay()
    if (this.costToday.day !== day) this.costToday = { day, spent: 0 }
  }

  /**
   * Ask Jev one batch of typed questions over one state.
   * @param call - hook context, state, questions, and cancellation.
   * @returns the decision, or `null` when the call degraded (never throws).
   */
  async classify(call: ClassifyCall): Promise<ClassifyResult | null> {
    const started = this.now()
    const active = this.active
    const degrade = (reason: DegradeReason): null => {
      const previous = this.lastDegrade
      const DEGRADE_REPEAT_MS = 60_000
      if (previous !== undefined && previous.reason === reason
        && this.now() - previous.at < DEGRADE_REPEAT_MS) return null
      this.lastDegrade = { reason, at: this.now() }
      this.telemetry.record({
        ts: new Date().toISOString(),
        tag: call.tag,
        mode: call.mode,
        ...(call.tool === undefined ? {} : { tool: call.tool }),
        ...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }),
        ...(call.callId === undefined ? {} : { callId: call.callId }),
        ...(active === undefined ? {} : { requestModel: active.connection.model }),
        action: 'degraded',
        detail: reason,
        ...(reason === 'no-key' || reason === 'cooldown' || reason === 'cost-limit' ? {} : { latencyMs: this.now() - started }),
      })
      return null
    }

    if (active === undefined) return degrade('invalid-connection')
    const { connection, cache, gate } = active
    let key: string | undefined
    try { key = await connection.resolveKey() } catch { return degrade('credential-unavailable') }
    if (active !== this.active) return degrade('connection-changed')
    if (key === undefined || key.length === 0) return degrade('no-key')
    if (gate.open()) return degrade('cooldown')
    // 每日成本限额：超限即降级（fail-closed），次日自动恢复。
    this.rollCostDay()
    if (this.dailyCostLimitUsd() > 0 && this.costToday.spent >= this.dailyCostLimitUsd()) {
      return degrade('cost-limit')
    }

    const cacheKey = createHash('sha256')
      .update(JSON.stringify([key, call.state, call.questions]))
      .digest('hex')
    const hit = cache.get(cacheKey)
    if (hit !== undefined) {
      // A hit reuses the ANSWERS only: usage and latency belong to the
      // original billable call, so recording them again would multiply the
      // reported token count and cost by every reuse.
      return {
        answers: hit.answers,
        model: hit.model,
        modelReported: hit.modelReported,
        latencyMs: 0,
        inputTokens: undefined,
        costUsd: undefined,
        cached: true,
      }
    }

    if (call.signal?.aborted) return degrade('aborted')
    const acquired = await this.semaphore.acquire(
      call.signal ?? new AbortController().signal,
      connection.timeoutMs - (this.now() - started),
    )
    if (acquired !== 'acquired') return degrade(acquired === 'aborted' ? 'aborted' : 'timeout')
    try {
      if (active !== this.active) return degrade('connection-changed')
      if (gate.open()) return degrade('cooldown')
      // 排队者获得槽位后复查限额：压缩并发 TOCTOU 窗口（首批在途期间排队
      // 的调用不再照单放行）。finally 保证槽位释放。
      this.rollCostDay()
      if (this.dailyCostLimitUsd() > 0 && this.costToday.spent >= this.dailyCostLimitUsd()) {
        return degrade('cost-limit')
      }
      const outcome = await this.request(call, key, started, active)
      if (typeof outcome === 'string') {
        if (active !== this.active) return degrade('connection-changed')
        if (outcome === 'caller-aborted') return degrade('aborted')
        this.countFailure(gate, outcome)
        return degrade(outcome === 'retryable' ? 'http-error' : outcome)
      }
      // 计费调用记入当日成本：provider 上报值优先、token 估算兜底；
      // 连 usage 都不报的 provider（自建代理）按请求体规模粗估（~4 字符/token），
      // 保证限额对无 usage 响应也能生效。
      this.rollCostDay()
      this.costToday.spent += outcome.costUsd
        ?? estimateCostUsd(outcome.inputTokens)
        ?? estimateCostUsd(Math.max(500, Math.ceil(JSON.stringify([call.state, call.questions]).length / 4)))
        ?? 0
      if (active !== this.active) return degrade('connection-changed')
      gate.onSuccess()
      if (outcome.modelReported && active.reportedModel !== outcome.model) {
        // Alias drift invalidates cached results from the previously observed version.
        cache.clear()
        active.reportedModel = outcome.model
      }
      const result: ClassifyResult = {
        ...outcome,
        latencyMs: this.now() - started,
        cached: false,
      }
      cache.set(cacheKey, result)
      return result
    } finally {
      this.semaphore.release()
    }
  }

  /**
   * 连接测试：发一次最小真实请求验证 key、端点与模型。
   *
   * 刻意绕过缓存（测试就该真打）、冷却门（用户主动测试要立刻的答案）与
   * 遥测（测试不是决策）；预算独立放宽（max(决策预算, 5s)）——决策要快速
   * 降级，测试是用户主动等待的操作，OpenRouter 代理常态 2-3s 用决策预算会
   * 假超时。独立于 request() 实现——需要精确的 HTTP 状态码区分「key 无效」
   * 与「端点不存在」，那是排障最关键的一刀。
   * @param options - `apiKeyOverride`：用未保存的草稿 key 测试；`signal`：取消。
   */
  async ping(options: { apiKeyOverride?: string; signal?: AbortSignal } = {}): Promise<PingResult> {
    const started = this.now()
    const active = this.active
    if (active === undefined) return { ok: false, latencyMs: 0, error: 'invalid-connection' }
    const { connection } = active
    let key: string | undefined
    try { key = options.apiKeyOverride ?? await connection.resolveKey() } catch {
      return { ok: false, latencyMs: this.now() - started, error: 'credential-unavailable' }
    }
    if (active !== this.active) return { ok: false, latencyMs: this.now() - started, error: 'connection-changed' }
    if (key === undefined || key.length === 0) return { ok: false, latencyMs: 0, error: 'no-key' }
    const timer = AbortSignal.timeout(Math.max(connection.timeoutMs, PING_MIN_BUDGET_MS))
    const signal = options.signal === undefined ? timer : AbortSignal.any([options.signal, timer])
    let response: Response
    try {
      response = await this.fetchFn(connection.endpoint, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: connection.model,
          state: { ping: 'connection-test' },
          questions: {
            ping: {
              type: 'noul',
              instructions: 'This is an API connectivity test. Reply with the probability that the input is an automated test message.',
              criteria: {
                true: 'It is an automated connectivity test',
                false: 'It is not a test',
              },
            },
          },
        }),
        signal,
      })
    } catch (error) {
      const latencyMs = this.now() - started
      if (options.signal?.aborted) return { ok: false, latencyMs, error: 'aborted' }
      return { ok: false, latencyMs, error: timer.aborted || (error instanceof Error && error.name === 'AbortError') ? 'timeout' : 'network' }
    }
    const latencyMs = this.now() - started
    if (active !== this.active) return { ok: false, latencyMs, error: 'connection-changed' }
    if (response.status === 401 || response.status === 403) return { ok: false, latencyMs, error: 'auth' }
    if (response.status === 404) return { ok: false, latencyMs, error: 'not-found' }
    // Keep the reachability result and report throttling separately from a parsed answer.
    if (response.status === 429) return { ok: true, latencyMs, error: 'rate-limited' }
    if (response.status >= 500) return { ok: false, latencyMs, error: 'server' }
    if (!response.ok) return { ok: false, latencyMs, error: `http-${String(response.status)}` }
    try {
      const body: unknown = await response.json()
      if (typeof body !== 'object' || body === null) return { ok: false, latencyMs, error: 'invalid-response' }
      const answers = parseAnswers((body as Record<string, unknown>)['answers'])
      if (active !== this.active) return { ok: false, latencyMs: this.now() - started, error: 'connection-changed' }
      if (answers['ping']?.type !== 'noul') return { ok: false, latencyMs, error: 'invalid-response' }
      const model = (body as Record<string, unknown>)['model']
      const reportedModel = typeof model === 'string' && model.trim() ? model : undefined
      if (reportedModel !== undefined && options.apiKeyOverride === undefined && active.reportedModel !== reportedModel) {
        active.cache.clear()
        active.reportedModel = reportedModel
      }
      return { ok: true, latencyMs: this.now() - started, model: reportedModel ?? connection.model }
    } catch {
      return { ok: false, latencyMs, error: 'invalid-response' }
    }
  }

  /** One or two HTTP attempts inside the wall-clock budget. */
  private async request(call: ClassifyCall, key: string, started: number, active: ActiveConnection): Promise<RequestOutcome> {
    const { connection } = active
    let attempt = 0
    // At most two attempts; the second only for retryable statuses with budget left.
    for (;;) {
      attempt += 1
      const budget = connection.timeoutMs - (this.now() - started)
      if (budget <= 0) return call.signal?.aborted ? 'caller-aborted' : 'timeout'
      const timer = AbortSignal.timeout(budget)
      const signal = call.signal === undefined ? timer : AbortSignal.any([call.signal, timer])
      let response: Response
      try {
        response = await this.fetchFn(connection.endpoint, {
          method: 'POST',
          headers: {
            'authorization': `Bearer ${key}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: connection.model,
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
        if (attempt < 2 && active === this.active && connection.timeoutMs - (this.now() - started) > 400) {
          await sleep(400, call.signal)
          if (active !== this.active) return 'retryable'
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
        for (const [id, question] of Object.entries(call.questions)) {
          const answer = Object.hasOwn(answers, id) ? answers[id] : undefined
          if (answer?.type !== question.type) return 'invalid-response'
          if (question.type === 'choice' && answer.type === 'choice' && !Object.hasOwn(question.criteria, answer.choice)) {
            return 'invalid-response'
          }
        }
        const usage = typeof record['usage'] === 'object' && record['usage'] !== null
          ? record['usage'] as Record<string, unknown>
          : {}
        const inputTokens = typeof usage['input_tokens'] === 'number' ? usage['input_tokens'] : undefined
        const reportedCost = typeof usage['cost'] === 'number' ? usage['cost'] : undefined
        const reportedModel = typeof record['model'] === 'string' && record['model'].trim() ? record['model'] : undefined
        return {
          answers,
          model: reportedModel ?? connection.model,
          modelReported: reportedModel !== undefined,
          inputTokens,
          costUsd: reportedCost ?? estimateCostUsd(inputTokens),
        }
      } catch {
        // parseAnswers throws on malformed bodies; a parse failure is a
        // protocol failure unless the timer or caller ended the call first.
        if (call.signal?.aborted) return 'caller-aborted'
        if (timer.aborted) return 'timeout'
        return 'invalid-response'
      }
    }
  }

  /** Count one provider failure and warn exactly when the gate opens. */
  private countFailure(gate: CooldownGate, kind: string): void {
    if (gate.onFailure()) {
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
