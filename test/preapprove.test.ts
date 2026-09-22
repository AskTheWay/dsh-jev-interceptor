import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import { createPreapproveListener, type PreapproveDeps } from '../src/preapprove.js'
import { PendingAsks } from '../src/guard.js'
import type { ClassifyResult, JevClient } from '../src/jev.js'
import { Telemetry } from '../src/telemetry.js'
import type { PreapproveThresholds } from '../src/matrix.js'

function fakeRequest(overrides: Partial<ApprovalRequestEvent> = {}): ApprovalRequestEvent {
  return {
    agent: {
      session: {
        id: 'session-1',
        header: { cwd: '/work/project' },
        deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'run the tests' }] }],
      },
    } as unknown as ApprovalRequestEvent['agent'],
    toolName: 'bash',
    callId: 'call-1' as ToolCallId,
    reason: 'hook: needs approval',
    ...overrides,
  } as ApprovalRequestEvent
}

function approveResult(overrides: Partial<ClassifyResult> = {}): ClassifyResult {
  return {
    answers: {
      within_granted_scope: { type: 'noul', noul: 0.95 },
      reversible: { type: 'noul', noul: 0.95 },
      injection_suspect: { type: 'noul', noul: 0.01 },
    },
    model: 'jev-1.13.0',
    latencyMs: 110,
    inputTokens: 350,
    costUsd: 0.0000147,
    cached: false,
    ...overrides,
  }
}

async function makeDeps(overrides: Partial<PreapproveDeps> & { classify?: () => Promise<ClassifyResult | null> } = {}): Promise<PreapproveDeps & { readonly calls: number }> {
  const { classify, ...rest } = overrides
  const counter = { calls: 0 }
  const stub = {
    classify: classify ?? (async () => {
      counter.calls += 1
      return approveResult()
    }),
  } as unknown as JevClient
  return {
    mode: 'enforce',
    allowlist: new Set(['bash']),
    thresholds: {
      autoApproveMin: 0.85,
      irreversibleMax: 0.15,
      injectionSuspectMax: 0.5,
    } satisfies PreapproveThresholds,
    recentMessages: 3,
    recentMessageChars: 300,
    jev: stub,
    telemetry: new Telemetry(await mkdtemp(join(tmpdir(), 'dsh-jev-pre-'))),
    pendingAsks: new PendingAsks(),
    ...rest,
    // A getter, so the closure counter is read live instead of copied at return.
    get calls() { return counter.calls },
  }
}

const nextHuman = async (): Promise<'unavailable'> => 'unavailable'

describe('createPreapproveListener', () => {
  it('auto-approves a guard-escalated, in-scope, reversible, clean call', async () => {
    const deps = await makeDeps()
    deps.pendingAsks.set('session-1', 'call-1', { tool: 'bash', argsPreview: '{"command":"npm test"}' })
    const listener = createPreapproveListener(deps)
    expect(await listener(fakeRequest(), nextHuman)).toBe('allowed-once')
    expect(deps.calls).toBe(1)
  })

  it('delegates its own guard escalation straight to the human', async () => {
    const deps = await makeDeps()
    deps.pendingAsks.set('session-1', 'call-1', { tool: 'bash', argsPreview: '{}' })
    const listener = createPreapproveListener(deps)
    expect(await listener(fakeRequest({ reason: 'jev-guard: medium risk (p=0.80)' }), nextHuman)).toBe('unavailable')
    expect(deps.calls).toBe(0)
  })

  it('delegates tools outside the allowlist', async () => {
    const deps = await makeDeps()
    deps.pendingAsks.set('session-1', 'call-1', { tool: 'bash', argsPreview: '{}' })
    const listener = createPreapproveListener(deps)
    expect(await listener(fakeRequest({ toolName: 'write' }), nextHuman)).toBe('unavailable')
    expect(deps.calls).toBe(0)
  })

  it('delegates when the request carries no callId (no argument evidence)', async () => {
    const deps = await makeDeps()
    const listener = createPreapproveListener(deps)
    const request = fakeRequest()
    delete (request as { callId?: ToolCallId }).callId
    expect(await listener(request, nextHuman)).toBe('unavailable')
    expect(deps.calls).toBe(0)
  })

  it('delegates when no captured arguments exist — a grant is never judged on the ask reason alone', async () => {
    // Covers hook asks and sandbox escalations: the guard delegated (no entry),
    // so the only evidence would be the model-written justification.
    const deps = await makeDeps()
    const listener = createPreapproveListener(deps)
    expect(await listener(fakeRequest({ reason: 'escalate sandbox to danger-full-access: cleanup build artifacts' }), nextHuman)).toBe('unavailable')
    expect(deps.calls).toBe(0)
  })

  it('delegates when the pending entry belongs to another tool (cross-entry mismatch)', async () => {
    const deps = await makeDeps()
    deps.pendingAsks.set('session-1', 'call-1', { tool: 'grep', argsPreview: '{}' })
    const listener = createPreapproveListener(deps)
    expect(await listener(fakeRequest({ toolName: 'bash' }), nextHuman)).toBe('unavailable')
    expect(deps.calls).toBe(0)
  })

  it('delegates when the entry belongs to a different session (callId collision)', async () => {
    const deps = await makeDeps()
    deps.pendingAsks.set('session-2', 'call-1', { tool: 'bash', argsPreview: '{"command":"rm -rf /"}' })
    const listener = createPreapproveListener(deps)
    expect(await listener(fakeRequest(), nextHuman)).toBe('unavailable')
    expect(deps.calls).toBe(0)
  })

  it('delegates when the provider degrades or doubts', async () => {
    const degraded = await makeDeps({ classify: async () => null })
    degraded.pendingAsks.set('session-1', 'call-1', { tool: 'bash', argsPreview: '{}' })
    const listener = createPreapproveListener(degraded)
    expect(await listener(fakeRequest(), nextHuman)).toBe('unavailable')

    const doubted = await makeDeps({
      classify: async () => approveResult({
        answers: {
          within_granted_scope: { type: 'noul', noul: 0.5 },
          reversible: { type: 'noul', noul: 0.95 },
          injection_suspect: { type: 'noul', noul: 0.01 },
        },
      }),
    })
    doubted.pendingAsks.set('session-1', 'call-1', { tool: 'bash', argsPreview: '{}' })
    expect(await createPreapproveListener(doubted)(fakeRequest(), nextHuman)).toBe('unavailable')
  })

  it('never approves in shadow mode', async () => {
    const deps = await makeDeps({ mode: 'shadow' })
    deps.pendingAsks.set('session-1', 'call-1', { tool: 'bash', argsPreview: '{"command":"npm test"}' })
    const listener = createPreapproveListener(deps)
    expect(await listener(fakeRequest(), nextHuman)).toBe('unavailable')
    expect(deps.calls).toBe(1)
  })
})
