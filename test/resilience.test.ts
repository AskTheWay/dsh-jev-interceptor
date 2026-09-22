import { describe, expect, it } from 'vitest'
import { CooldownGate, LruCache, Semaphore } from '../src/resilience.js'

describe('CooldownGate', () => {
  function gate(): { g: CooldownGate; tick: (to: number) => void } {
    let now = 0
    const g = new CooldownGate(3, 10_000, () => now)
    return {
      g,
      tick: (to: number) => {
        now = to
      },
    }
  }

  it('stays closed below the failure threshold', () => {
    const { g } = gate()
    expect(g.onFailure()).toBe(false)
    expect(g.onFailure()).toBe(false)
    expect(g.open()).toBe(false)
  })

  it('opens at the threshold and reports the transition once', () => {
    const { g } = gate()
    g.onFailure()
    g.onFailure()
    expect(g.onFailure()).toBe(true)
    expect(g.open()).toBe(true)
    expect(g.onFailure()).toBe(false) // already open
  })

  it('closes after the cooldown elapses, then resets the streak on success', () => {
    const { g, tick } = gate()
    g.onFailure()
    g.onFailure()
    g.onFailure()
    tick(10_001)
    expect(g.open()).toBe(false)
    g.onSuccess()
    expect(g.onFailure()).toBe(false)
    expect(g.onFailure()).toBe(false)
    expect(g.open()).toBe(false)
  })

  it('one success resets an in-progress streak', () => {
    const { g } = gate()
    g.onFailure()
    g.onFailure()
    g.onSuccess()
    g.onFailure()
    g.onFailure()
    expect(g.open()).toBe(false)
  })
})

describe('Semaphore', () => {
  it('caps concurrent holders and queues the rest in order', async () => {
    const semaphore = new Semaphore(2)
    const order: number[] = []
    expect(await semaphore.acquire(new AbortController().signal)).toBe('acquired')
    expect(await semaphore.acquire(new AbortController().signal)).toBe('acquired')
    const third = semaphore.acquire(new AbortController().signal).then((outcome) => {
      if (outcome === 'acquired') order.push(3)
    })
    const fourth = semaphore.acquire(new AbortController().signal).then((outcome) => {
      if (outcome === 'acquired') order.push(4)
    })
    semaphore.release()
    semaphore.release()
    await Promise.all([third, fourth])
    expect(order).toEqual([3, 4])
  })

  it('resolves queued acquires with aborted when the caller aborts', async () => {
    const semaphore = new Semaphore(1)
    expect(await semaphore.acquire(new AbortController().signal)).toBe('acquired')
    const controller = new AbortController()
    const queued = semaphore.acquire(controller.signal)
    controller.abort()
    expect(await queued).toBe('aborted')
    semaphore.release()
  })

  it('regression: an aborted queuer leaves no dead entry, later acquires still succeed', async () => {
    // The leak this guards against: release() once handed the freed slot to an
    // already-aborted queue entry without decrementing, so after enough leaked
    // entries every later acquire hung forever.
    const semaphore = new Semaphore(2)
    expect(await semaphore.acquire(new AbortController().signal)).toBe('acquired')
    expect(await semaphore.acquire(new AbortController().signal)).toBe('acquired')
    const controller = new AbortController()
    const queued = semaphore.acquire(controller.signal)
    controller.abort()
    expect(await queued).toBe('aborted')
    // A holder releases; the dead entry must be discarded, not handed the slot.
    semaphore.release()
    const fresh = semaphore.acquire(new AbortController().signal, 500)
    expect(await fresh).toBe('acquired')
    semaphore.release()
    semaphore.release()
  })

  it('resolves queued acquires with timeout when the queue bound elapses', async () => {
    const semaphore = new Semaphore(1)
    expect(await semaphore.acquire(new AbortController().signal)).toBe('acquired')
    expect(await semaphore.acquire(new AbortController().signal, 30)).toBe('timeout')
    semaphore.release()
  })
})

describe('LruCache', () => {
  it('evicts the least recently used entry past capacity', () => {
    const cache = new LruCache<string, number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    expect(cache.get('a')).toBe(1) // refresh a
    cache.set('c', 3)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe(1)
    expect(cache.get('c')).toBe(3)
    expect(cache.size).toBe(2)
  })
})
