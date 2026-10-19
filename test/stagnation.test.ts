import { describe, expect, it } from 'vitest'
import type { PostToolDecision, ToolExecution, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createStagnationListener, shouldProbe, StagnationTracker, summarizeFailure, type AttemptRecord, type StagnationThresholds } from '../src/stagnation.js'
import { decideStagnation } from '../src/matrix.js'
import type { JevClient, ClassifyResult } from '../src/jev.js'
import type { LiveSettings } from '../src/config.js'
import type { TelemetryEntry } from '../src/telemetry.js'

const thresholds: StagnationThresholds = { triggerCount: 4, failureRatioMin: 0.75, cooldownMs: 300_000 }

function attempt(fingerprint: string, at = 0, isError = true): AttemptRecord {
  return { fingerprint, isError, argsPreview: `{cmd:"${fingerprint}"}`, summary: 'exit 1 boom', at }
}

describe('StagnationTracker', () => {
  it('keeps a bounded ring and drops stale entries on record', () => {
    const tracker = new StagnationTracker(3)
    const agent: object = {}
    let now = 0
    let window = tracker.record(agent, 'bash', attempt('a', now), now)
    now = 1; window = tracker.record(agent, 'bash', attempt('b', now), now)
    now = 2; window = tracker.record(agent, 'bash', attempt('c', now), now)
    expect(window.map(a => a.fingerprint)).toEqual(['a', 'b', 'c'])
    // 容量 3：第 4 条挤掉最老的 a。
    now = 3; window = tracker.record(agent, 'bash', attempt('d', now), now)
    expect(window.map(a => a.fingerprint)).toEqual(['b', 'c', 'd'])
    // 10 分钟外的旧条目在下次 record 时过期。
    now = 11 * 60_000; window = tracker.record(agent, 'bash', attempt('e', now), now)
    expect(window.map(a => a.fingerprint)).toEqual(['e'])
  })

  it('clears one tool on success and the whole agent on clearAgent (WeakMap keys independent)', () => {
    const tracker = new StagnationTracker(8)
    const agentA: object = {}
    const agentB: object = {}
    tracker.record(agentA, 'bash', attempt('a'), 0)
    tracker.record(agentA, 'read', attempt('r'), 0)
    tracker.record(agentB, 'bash', attempt('b'), 0)
    tracker.clear(agentA, 'bash')
    expect(tracker.record(agentA, 'bash', attempt('a2'), 1)).toHaveLength(1)
    expect(tracker.record(agentA, 'read', attempt('r2'), 1)).toHaveLength(2)
    tracker.clearAgent(agentB)
    expect(tracker.record(agentB, 'bash', attempt('b2'), 1)).toHaveLength(1)
  })

  it('tracks alert cooldown per (agent, tool)', () => {
    const tracker = new StagnationTracker(8)
    const agent: object = {}
    expect(tracker.lastAlertAt(agent, 'bash')).toBe(0)
    tracker.record(agent, 'bash', attempt('a'), 0)
    tracker.noteAlert(agent, 'bash', 5_000)
    expect(tracker.lastAlertAt(agent, 'bash')).toBe(5_000)
    expect(tracker.lastAlertAt(agent, 'read')).toBe(0)
  })
})

describe('shouldProbe', () => {
  it('needs the trigger count, varied fingerprints, failure ratio, and cooldown elapsed', () => {
    const varied = ['a', 'b', 'c', 'd'].map((f, i) => attempt(f, i))
    expect(shouldProbe(varied.slice(0, 3), thresholds, 0, 1_000)).toBe(false)
    // 精确重复（单一指纹）是 repeat-tool-reminder 的地盘。
    expect(shouldProbe([attempt('a', 0), attempt('a', 1), attempt('a', 2), attempt('a', 3)], thresholds, 0, 1_000)).toBe(false)
    // 失败占比不达标（2/4 = 0.5 < 0.75）。
    const mixed = [attempt('a', 0), { ...attempt('b', 1), isError: false }, { ...attempt('c', 2), isError: false }, attempt('d', 3)]
    expect(shouldProbe(mixed, thresholds, 0, 1_000)).toBe(false)
    // 冷却期内。
    expect(shouldProbe(varied, thresholds, 100_000, 200_000)).toBe(false)
    expect(shouldProbe(varied, thresholds, 0, 400_000)).toBe(true)
  })
})

describe('decideStagnation', () => {
  it('alerts only when both nouls clear the confidence gate', () => {
    const yes = { noProgress: { type: 'noul' as const, noul: 0.9 }, similarFailure: { type: 'noul' as const, noul: 0.9 } }
    expect(decideStagnation(yes, 0.85)).toBe('alert')
    const oneSided = { noProgress: { type: 'noul' as const, noul: 0.9 }, similarFailure: { type: 'noul' as const, noul: 0.7 } }
    expect(decideStagnation(oneSided, 0.85)).toBe('skip')
  })
})

// ── listener 全链路 ─────────────────────────────────────────────────────

function fakeExec(args: Record<string, unknown>): ToolExecution {
  const callId = 'call-1' as ToolCallId
  return {
    callId,
    rootCallId: callId,
    name: 'bash',
    arguments: args,
    signal: new AbortController().signal,
    token: Symbol() as ToolExecutionToken,
    agent: { session: { id: 'session-1', header: { cwd: '/w' } } } as unknown as Agent,
  } as ToolExecution
}

function failure(message = 'boom: exit 1'): ToolExecutionResult {
  return { isError: true, error: { message }, content: [] } as ToolExecutionResult
}

function success(): ToolExecutionResult {
  return { isError: false, value: 'ok', content: [{ type: 'text', text: 'ok' }] } as unknown as ToolExecutionResult
}

function jevAnswer(noProgress = 0.92, similar = 0.9): ClassifyResult {
  return {
    answers: {
      no_progress: { type: 'noul', noul: noProgress },
      similar_failure: { type: 'noul', noul: similar },
    },
    model: 'jev-1.13.0',
    latencyMs: 40,
    inputTokens: 200,
    costUsd: 0.00001,
    cached: false,
  }
}

interface Harness {
  listener: ReturnType<typeof createStagnationListener>['onPostExecute']
  tracker: StagnationTracker
  entries: TelemetryEntry[]
  /** getter：计数器在 jev 闭包里递增，值拷贝会是 0 的快照。 */
  readonly classifyCalls: number
}

function harness(options: {
  mode?: 'shadow' | 'enforce'
  classify?: () => Promise<ClassifyResult | null>
  recordThrows?: boolean
} = {}): Harness {
  const tracker = new StagnationTracker(8)
  const entries: TelemetryEntry[] = []
  const telemetry = {
    record: (entry: TelemetryEntry): void => {
      if (options.recordThrows === true) throw new Error('telemetry down')
      entries.push(entry)
    },
  }
  const state = { classifyCalls: 0 }
  const jev = {
    classify: async (): Promise<ClassifyResult | null> => {
      state.classifyCalls += 1
      return options.classify ? await options.classify() : jevAnswer()
    },
  } as unknown as JevClient
  const live: LiveSettings = { enabled: true, mode: options.mode ?? 'enforce' }
  const { onPostExecute } = createStagnationListener({
    live: () => ({ ...live }),
    tracker,
    thresholds,
    confidenceMin: 0.85,
    argsPreviewChars: 160,
    jev,
    telemetry: telemetry as never,
    now: (() => { let t = 0; return () => (t += 1) })(),
  })
  return {
    listener: onPostExecute,
    tracker,
    entries,
    get classifyCalls(): number { return state.classifyCalls },
  }
}

const nextAccept = async (): Promise<PostToolDecision> => ({ kind: 'accept' })

describe('createStagnationListener.onPostExecute', () => {
  it('injects a reminder as additionalContexts on a confirmed stagnation (enforce)', async () => {
    const h = harness()
    const exec = fakeExec({ command: 'npm test' })
    // 4 次换参失败填满窗口。
    for (let i = 0; i < 3; i++) {
      await h.listener({ ...exec, arguments: { command: `try ${String(i)}` } }, failure(), nextAccept)
    }
    const decision = await h.listener(exec, failure(), nextAccept)
    expect(decision.kind).toBe('accept')
    expect(decision.additionalContexts).toHaveLength(1)
    const reminder = decision.additionalContexts?.[0]
    expect(reminder?.source).toMatchObject({ form: 'notice' })
    expect((reminder?.content[0] as { text?: string }).text).toContain('死循环')
    expect(h.entries.at(-1)).toMatchObject({ tag: 'stagnation', action: 'stagnation-alert', tool: 'bash' })
  })

  it('preserves a downstream block verdict and prepends the reminder', async () => {
    const h = harness()
    const exec = fakeExec({ command: 'x' })
    for (let i = 0; i < 3; i++) {
      await h.listener({ ...exec, arguments: { command: `try ${String(i)}` } }, failure(), nextAccept)
    }
    const blockFeedback = [{ type: 'text' as const, text: 'blocked by policy' }]
    const decision = await h.listener(exec, failure(), async () => ({ kind: 'block', feedback: blockFeedback }))
    expect(decision.kind).toBe('block')
    if (decision.kind === 'block') {
      expect(decision.feedback).toEqual(blockFeedback)
      expect(decision.additionalContexts).toHaveLength(1)
    }
  })

  it('never injects in shadow mode, but still records the would-be alert', async () => {
    const h = harness({ mode: 'shadow' })
    const exec = fakeExec({ command: 'x' })
    for (let i = 0; i < 4; i++) {
      await h.listener({ ...exec, arguments: { command: `try ${String(i)}` } }, failure(), nextAccept)
    }
    const decision = await h.listener(exec, failure(), nextAccept)
    expect(decision.additionalContexts).toBeUndefined()
    expect(h.entries.some(e => e.action === 'stagnation-alert')).toBe(true)
  })

  it('degrades silently when Jev returns null and never rethrows classify failures', async () => {
    for (const classify of [async () => null, async () => { throw new Error('provider exploded') }]) {
      const h = harness({ classify })
      const exec = fakeExec({ command: 'x' })
      for (let i = 0; i < 4; i++) {
        const decision = await h.listener({ ...exec, arguments: { command: `try ${String(i)}` } }, failure(), nextAccept)
        expect(decision.additionalContexts).toBeUndefined()
      }
    }
  })

  it('skips (no injection) when one noul is below the confidence gate', async () => {
    const h = harness({ classify: async () => jevAnswer(0.95, 0.6) })
    const exec = fakeExec({ command: 'x' })
    for (let i = 0; i < 4; i++) {
      await h.listener({ ...exec, arguments: { command: `try ${String(i)}` } }, failure(), nextAccept)
    }
    const decision = await h.listener(exec, failure(), nextAccept)
    expect(decision.additionalContexts).toBeUndefined()
    expect(h.entries.some(e => e.action === 'skipped' && e.tag === 'stagnation')).toBe(true)
  })

  it('passes successful calls through and clears the window', async () => {
    const h = harness()
    const exec = fakeExec({ command: 'x' })
    for (let i = 0; i < 3; i++) {
      await h.listener({ ...exec, arguments: { command: `try ${String(i)}` } }, failure(), nextAccept)
    }
    await h.listener(exec, success(), nextAccept)
    expect(h.tracker.record({}, 'bash', attempt('z'), 999)).toHaveLength(1)
    expect(h.classifyCalls).toBe(0)
  })

  it('delegates everything while disabled or without an agent, spending no Jev calls', async () => {
    // harness 的 live 每次返回快照副本；直接构造 disabled 变体。
    const entries: TelemetryEntry[] = []
    const tracker = new StagnationTracker(8)
    const jev = { classify: async () => { throw new Error('must not be called') } } as unknown as JevClient
    const { onPostExecute } = createStagnationListener({
      live: () => ({ enabled: false, mode: 'enforce' }),
      tracker,
      thresholds,
      confidenceMin: 0.85,
      argsPreviewChars: 160,
      jev,
      telemetry: { record: (e: TelemetryEntry): void => { entries.push(e) } } as never,
    })
    expect(await onPostExecute(fakeExec({ command: 'x' }), failure(), nextAccept)).toEqual({ kind: 'accept' })
    const noAgent = { ...fakeExec({ command: 'x' }), agent: undefined } as unknown as ToolExecution
    expect(await onPostExecute(noAgent, failure(), nextAccept)).toEqual({ kind: 'accept' })
  })

  it('contains observation-phase failures: stock downstream, next() exactly once', async () => {
    // live() 本身抛异常（真正驱动观察段 catch）：决策必须原样透传且 next 恰好一次。
    const tracker = new StagnationTracker(8)
    const entries: TelemetryEntry[] = []
    const { onPostExecute } = createStagnationListener({
      live: () => { throw new Error('settings exploded') },
      tracker,
      thresholds,
      confidenceMin: 0.85,
      argsPreviewChars: 160,
      jev: { classify: async () => { throw new Error('must not be called') } } as unknown as JevClient,
      telemetry: { record: (e: TelemetryEntry): void => { entries.push(e) } } as never,
    })
    let nextCalls = 0
    const decision = await onPostExecute(fakeExec({ command: 'x' }), failure(), async () => {
      nextCalls += 1
      return { kind: 'accept' as const }
    })
    expect(decision).toEqual({ kind: 'accept' })
    expect(nextCalls).toBe(1)
  })

  it('propagates next() rejections untouched (never double-calls next, never converts to accept)', async () => {
    // 回归：早退路径的 next() 一旦被 try 吞掉，会在排空的 waterfall 上二次
    // 调用并直落 base accept——吞掉下游 fail-closed 异常。
    const h = harness()
    const exec = fakeExec({ command: 'x' })
    let nextCalls = 0
    const rejectOnce = async (): Promise<PostToolDecision> => {
      nextCalls += 1
      throw new Error('downstream listener exploded')
    }
    // 成功调用路径（观察段早退）。
    await expect(h.listener(exec, success(), rejectOnce)).rejects.toThrow('downstream listener exploded')
    expect(nextCalls).toBe(1)
    // 窗口不满足路径（shouldProbe false 早退）。
    await expect(h.listener(exec, failure(), rejectOnce)).rejects.toThrow('downstream listener exploded')
    expect(nextCalls).toBe(2)
    // probe 路径：窗口满后 next() 仍恰好一次、拒绝原样上抛。
    for (let i = 0; i < 3; i++) {
      await h.listener({ ...exec, arguments: { command: `try ${String(i)}` } }, failure(), nextAccept)
    }
    await expect(h.listener(exec, failure(), rejectOnce)).rejects.toThrow('downstream listener exploded')
    expect(nextCalls).toBe(3)
  })

  it('respects the alert cooldown: one alert per window', async () => {
    const h = harness()
    const exec = fakeExec({ command: 'x' })
    for (let i = 0; i < 4; i++) {
      await h.listener({ ...exec, arguments: { command: `try ${String(i)}` } }, failure(), nextAccept)
    }
    // 第 5、6 次失败在冷却期内：不再发 Jev 判断。
    expect(await h.listener(exec, failure(), nextAccept)).toEqual({ kind: 'accept' })
    expect(h.classifyCalls).toBe(1)
  })
})

describe('summarizeFailure', () => {
  it('flattens whitespace and truncates with an ellipsis', () => {
    expect(summarizeFailure('line1\n  line2\t\tline3', 50)).toBe('line1 line2 line3')
    const long = 'x'.repeat(300)
    expect(summarizeFailure(long, 100)).toHaveLength(101)
    expect(summarizeFailure(long, 100).endsWith('…')).toBe(true)
  })
})
