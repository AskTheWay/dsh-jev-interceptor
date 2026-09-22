import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PreToolDecision, ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createGuardListener, PendingAsks, type GuardDeps } from '../src/guard.js'
import type { JevClient, ClassifyResult } from '../src/jev.js'
import { Telemetry } from '../src/telemetry.js'
import type { GuardThresholds } from '../src/matrix.js'

function fakeExec(overrides: Partial<ToolExecution> = {}): ToolExecution {
  const callId = 'call-1' as ToolCallId
  return {
    callId,
    rootCallId: callId,
    name: 'bash',
    arguments: { command: 'npm test' },
    signal: new AbortController().signal,
    token: Symbol() as ToolExecutionToken,
    agent: {
      session: {
        id: 'session-1',
        header: { cwd: '/work/project' },
        deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'run the tests' }] }],
      },
    } as unknown as ToolExecution['agent'],
    ...overrides,
  } as ToolExecution
}

function fakeResult(overrides: Partial<ClassifyResult> = {}): ClassifyResult {
  return {
    answers: {
      risk: { type: 'choice', choice: 'low', probabilities: { low: 0.9 }, confidence: 0.9 },
      irreversible: { type: 'noul', noul: 0.05 },
      matches_task: { type: 'noul', noul: 0.9 },
      injection_suspect: { type: 'noul', noul: 0.01 },
    },
    model: 'jev-1.13.0',
    latencyMs: 120,
    inputTokens: 400,
    costUsd: 0.0000168,
    cached: false,
    ...overrides,
  }
}

async function makeDeps(overrides: Partial<GuardDeps> & { classify?: () => Promise<ClassifyResult | null> } = {}): Promise<GuardDeps> {
  const { classify, ...rest } = overrides
  const stub = { classify: classify ?? (async () => fakeResult()) } as unknown as JevClient
  return {
    mode: 'enforce',
    readOnlyTools: new Set(['read', 'grep']),
    excludeTools: new Set(),
    thresholds: {
      confidenceMin: 0.6,
      denyConfidence: 0.85,
      irreversibleCeiling: 0.2,
      irreversibleDenyFloor: 0.5,
      injectionAskThreshold: 0.8,
    } satisfies GuardThresholds,
    recentMessages: 6,
    recentMessageChars: 300,
    argsHeadChars: 2048,
    argsTailChars: 512,
    jev: stub,
    telemetry: new Telemetry(await mkdtemp(join(tmpdir(), 'dsh-jev-guard-'))),
    pendingAsks: new PendingAsks(),
    permissionPresets: () => undefined,
    ...rest,
  }
}

const nextAllow = async (): Promise<PreToolDecision> => ({ kind: 'allow' })

describe('createGuardListener', () => {
  it('delegates read-only tools without spending a Jev call', async () => {
    let calls = 0
    const listener = createGuardListener(await makeDeps({ classify: async () => { calls += 1; return fakeResult() } }))
    const decision = await listener(fakeExec({ name: 'read' }), nextAllow)
    expect(decision).toEqual({ kind: 'allow' })
    expect(calls).toBe(0)
  })

  it('delegates the outer run_code transport', async () => {
    let calls = 0
    const listener = createGuardListener(await makeDeps({ classify: async () => { calls += 1; return fakeResult() } }))
    await listener(fakeExec({ name: 'run_code' }), nextAllow)
    expect(calls).toBe(0)
  })

  it('yields to auto-review when the Auto preset is active', async () => {
    let calls = 0
    const listener = createGuardListener(await makeDeps({
      classify: async () => { calls += 1; return fakeResult() },
      permissionPresets: () => ({ current: () => 'auto' }),
    }))
    await listener(fakeExec(), nextAllow)
    expect(calls).toBe(0)
  })

  it('delegates when the provider degrades', async () => {
    const listener = createGuardListener(await makeDeps({ classify: async () => null }))
    expect(await listener(fakeExec(), nextAllow)).toEqual({ kind: 'allow' })
  })

  it('delegates when classification throws', async () => {
    const listener = createGuardListener(await makeDeps({ classify: async () => {
      throw new Error('provider exploded')
    } }))
    expect(await listener(fakeExec(), nextAllow)).toEqual({ kind: 'allow' })
  })

  it('denies a confident high-risk irreversible call', async () => {
    const listener = createGuardListener(await makeDeps({
      classify: async () => fakeResult({
        answers: {
          risk: { type: 'choice', choice: 'high', probabilities: { high: 0.9 }, confidence: 0.9 },
          irreversible: { type: 'noul', noul: 0.8 },
          matches_task: { type: 'noul', noul: 0.5 },
          injection_suspect: { type: 'noul', noul: 0.01 },
        },
      }),
    }))
    const decision = await listener(fakeExec(), nextAllow)
    expect(decision.kind).toBe('deny')
    if (decision.kind === 'deny') {
      expect(decision.reason.startsWith('jev-guard:')).toBe(true)
      expect(decision.info?.code).toBe('JEV_GUARD_DENY')
    }
  })

  it('asks on medium risk and stashes the preview for the pre-approver', async () => {
    const deps = await makeDeps({
      classify: async () => fakeResult({
        answers: {
          risk: { type: 'choice', choice: 'medium', probabilities: { medium: 0.8 }, confidence: 0.8 },
          irreversible: { type: 'noul', noul: 0.1 },
          matches_task: { type: 'noul', noul: 0.9 },
          injection_suspect: { type: 'noul', noul: 0.01 },
        },
      }),
    })
    const listener = createGuardListener(deps)
    const decision = await listener(fakeExec(), nextAllow)
    expect(decision.kind).toBe('ask')
    expect(deps.pendingAsks.take('session-1', 'call-1' as ToolCallId, 'bash')?.argsPreview).toContain('npm test')
  })

  it('never enforces in shadow mode', async () => {
    const listener = createGuardListener(await makeDeps({
      mode: 'shadow',
      classify: async () => fakeResult({
        answers: {
          risk: { type: 'choice', choice: 'high', probabilities: { high: 0.95 }, confidence: 0.95 },
          irreversible: { type: 'noul', noul: 0.9 },
          matches_task: { type: 'noul', noul: 0.5 },
          injection_suspect: { type: 'noul', noul: 0.01 },
        },
      }),
    }))
    expect(await listener(fakeExec(), nextAllow)).toEqual({ kind: 'allow' })
  })
})
