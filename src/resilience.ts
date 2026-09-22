/**
 * Resilience primitives shared by every Jev call site: a consecutive-failure
 * cooldown gate (timeouts count as failures — a hung provider must not add
 * latency to every call forever), a counting semaphore that caps in-flight
 * requests (Jev rate-limits around 8 concurrent requests), and an LRU cache
 * keyed on decision inputs. All pure with an injectable clock.
 * @module dsh-jev-interceptor/resilience
 */

/** Clock source; injectable for tests. */
export type Now = () => number

/**
 * Cooldown gate over consecutive provider failures. After
 * {@link CooldownGate.constructor threshold} consecutive failures the gate
 * opens for {@link CooldownGate.constructor cooldownMs}; while open, callers
 * degrade immediately without touching the provider. One success closes the
 * gate and resets the streak.
 */
export class CooldownGate {
  private readonly threshold: number
  private readonly cooldownMs: number
  private readonly now: Now
  private consecutiveFailures = 0
  private openUntil = 0

  /**
   * @param threshold - consecutive failures that open the gate.
   * @param cooldownMs - how long the gate stays open.
   * @param now - clock source (defaults to `Date.now`).
   */
  constructor(threshold: number, cooldownMs: number, now: Now = Date.now) {
    this.threshold = threshold
    this.cooldownMs = cooldownMs
    this.now = now
  }

  /** Record one successful call; closes the gate and resets the streak. */
  onSuccess(): void {
    this.consecutiveFailures = 0
    this.openUntil = 0
  }

  /**
   * Record one failed call (network error, timeout, HTTP failure, exhausted
   * retries). Returns whether this failure opened the gate.
   * @returns `true` when the gate transitioned closed→open.
   */
  onFailure(): boolean {
    this.consecutiveFailures += 1
    if (this.consecutiveFailures < this.threshold) return false
    const alreadyOpen = this.now() < this.openUntil
    this.openUntil = this.now() + this.cooldownMs
    return !alreadyOpen
  }

  /** Whether callers should degrade without calling the provider right now. */
  open(): boolean {
    return this.now() < this.openUntil
  }

  /** Milliseconds until the gate closes (0 when already closed). */
  remainingMs(): number {
    const left = this.openUntil - this.now()
    return left > 0 ? left : 0
  }
}

/**
 * FIFO counting semaphore. Acquire resolves with a failure outcome when the
 * caller's signal aborts or the optional queue timeout elapses while waiting;
 * a failed waiter marks its queue entry settled so {@link Semaphore.release}
 * can discard the dead entry instead of handing it a slot it will never use —
 * the counter and queue therefore stay balanced across cancellations.
 */
export class Semaphore {
  private readonly max: number
  private inFlight = 0
  private readonly queue: Array<QueueEntry> = []

  /**
   * @param max - maximum concurrent holders.
   */
  constructor(max: number) {
    this.max = max
  }

  /**
   * Enter the semaphore.
   * @param signal - caller cancellation observed while waiting in queue.
   * @param timeoutMs - optional wall-clock bound on queueing; a queuer that
   *   exceeds it resolves `timeout` instead of hanging behind a stall.
   * @returns `acquired` (pair with {@link Semaphore.release}), or the failure
   *   mode that ended the wait.
   */
  acquire(signal: AbortSignal, timeoutMs?: number): Promise<AcquireOutcome> {
    if (this.inFlight < this.max) {
      this.inFlight += 1
      return Promise.resolve<AcquireOutcome>('acquired')
    }
    const entry: QueueEntry = { settled: false, dispose: () => {}, finish: () => {} }
    const settled = new Promise<AcquireOutcome>((resolve) => {
      const finish = (outcome: AcquireOutcome): void => {
        if (entry.settled) return
        entry.settled = true
        entry.dispose()
        resolve(outcome)
      }
      entry.finish = finish
      const onAbort = (): void => finish('aborted')
      signal.addEventListener('abort', onAbort, { once: true })
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => finish('timeout'), timeoutMs)
      entry.dispose = () => {
        signal.removeEventListener('abort', onAbort)
        if (timer !== undefined) clearTimeout(timer)
      }
    })
    // A release() between promise construction and push cannot exist: release
    // only runs from a holder, and this caller is by construction a queuer.
    this.queue.push(entry)
    return settled
  }

  /** Release a slot acquired by a successful {@link Semaphore.acquire}. */
  release(): void {
    // Skip settled (aborted/timed-out) waiters: they never held a slot, so
    // discarding them keeps the counter balanced. The first live waiter
    // inherits the freed slot without an inFlight dip.
    for (;;) {
      const entry = this.queue.shift()
      if (entry === undefined) {
        this.inFlight -= 1
        return
      }
      if (entry.settled) continue
      entry.finish('acquired')
      return
    }
  }
}

/** Outcome of one semaphore acquisition attempt. */
export type AcquireOutcome = 'acquired' | 'aborted' | 'timeout'

/** One queued acquisition attempt. */
interface QueueEntry {
  /** Whether this entry already resolved (acquired, aborted, or timed out). */
  settled: boolean
  /** Detaches the abort listener and queue timer. */
  dispose: () => void
  /** Resolves the wait exactly once; no-op after the first resolution. */
  finish: (outcome: AcquireOutcome) => void
}

/**
 * Map-based LRU cache. `get` refreshes recency; `set` evicts the least
 * recently used entry beyond capacity.
 */
export class LruCache<K, V> {
  private readonly capacity: number
  private readonly entries: Map<K, V> = new Map()

  /**
   * @param capacity - maximum retained entries.
   */
  constructor(capacity: number) {
    this.capacity = capacity
  }

  /** Look up one key, refreshing its recency. */
  get(key: K): V | undefined {
    const hit = this.entries.get(key)
    if (hit === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, hit)
    return hit
  }

  /** Insert or replace one key, evicting past capacity. */
  set(key: K, value: V): void {
    if (this.capacity <= 0) return
    this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
  }

  /** Number of retained entries. */
  get size(): number {
    return this.entries.size
  }
}
