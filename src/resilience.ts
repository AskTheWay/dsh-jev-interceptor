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
 * FIFO counting semaphore. Acquire resolves `false` when the caller's signal
 * aborts while queued, so a cancelled tool call never waits on the limiter.
 */
export class Semaphore {
  private readonly max: number
  private inFlight = 0
  private readonly queue: Array<() => void> = []

  /**
   * @param max - maximum concurrent holders.
   */
  constructor(max: number) {
    this.max = max
  }

  /**
   * Enter the semaphore.
   * @param signal - caller cancellation observed while waiting in queue.
   * @returns `true` when a slot was acquired (pair with {@link Semaphore.release}),
   *   `false` when the signal aborted first.
   */
  acquire(signal: AbortSignal): Promise<boolean> {
    if (this.inFlight < this.max) {
      this.inFlight += 1
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      const settle = (acquired: boolean): void => {
        signal.removeEventListener('abort', onAbort)
        resolve(acquired)
      }
      const onAbort = (): void => settle(false)
      signal.addEventListener('abort', onAbort, { once: true })
      this.queue.push(() => settle(true))
    })
  }

  /** Release a slot acquired by a successful {@link Semaphore.acquire}. */
  release(): void {
    const next = this.queue.shift()
    if (next === undefined) {
      this.inFlight -= 1
      return
    }
    // The queued waiter inherits the slot without an inFlight dip.
    next()
  }
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
