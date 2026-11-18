import { describe, expect, it } from 'vitest'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import { createAutoDecideListener, GUARD_REASON_PREFIX } from '../src/auto-decide.js'
import { PendingAsks } from '../src/guard.js'
import type { LiveSettings } from '../src/config.js'

const GUARD_REASON = `${GUARD_REASON_PREFIX} medium-risk call needs human confirmation (risk=medium 0.80)`

function fakeRequest(overrides: Partial<ApprovalRequestEvent> = {}): ApprovalRequestEvent {
  return {
    agent: {
      session: {
        id: 'session-1',
        header: { cwd: '/work/project' },
        deriveMessages: () => [],
      },
    } as unknown as ApprovalRequestEvent['agent'],
    toolName: 'bash',
    callId: 'call-1' as ToolCallId,
    reason: GUARD_REASON,
    ...overrides,
  } as ApprovalRequestEvent
}

const nextHuman = async (): Promise<'unavailable'> => 'unavailable'

function listener(options: {
  flag?: boolean
  live?: LiveSettings
  autoDecision?: 'approve' | 'deny'
} = {}) {
  const pending = new PendingAsks()
  pending.set('session-1', 'call-1', {
    tool: 'bash',
    argsPreview: '{}',
    ...(options.autoDecision === undefined ? {} : { autoDecision: options.autoDecision }),
  })
  return {
    pending,
    run: createAutoDecideListener({
      live: () => options.live ?? { enabled: true, mode: 'enforce' },
      enabled: () => options.flag ?? true,
      pendingAsks: pending,
    }),
  }
}

describe('createAutoDecideListener', () => {
  it('approves a matching non-high-risk guard escalation once', async () => {
    const { pending, run } = listener({ autoDecision: 'approve' })
    expect(await run(fakeRequest(), nextHuman)).toBe('allowed-once')
    // The grant consumed the evidence: a second ask for the same call goes to the human.
    expect(pending.take('session-1', 'call-1' as ToolCallId, 'bash')).toBeUndefined()
    expect(await run(fakeRequest(), nextHuman)).toBe('unavailable')
  })

  it('rejects a matching high-risk or injection escalation instead of asking', async () => {
    const { run } = listener({ autoDecision: 'deny' })
    expect(await run(fakeRequest({ reason: `${GUARD_REASON_PREFIX} high-risk call needs human confirmation (risk=high 0.70)` }), nextHuman))
      .toBe('rejected')
  })

  it('does nothing while the opt-in flag is off, leaving the evidence for a human ask', async () => {
    const { pending, run } = listener({ flag: false, autoDecision: 'approve' })
    expect(await run(fakeRequest(), nextHuman)).toBe('unavailable')
    expect(pending.take('session-1', 'call-1' as ToolCallId, 'bash')?.tool).toBe('bash')
  })

  it('treats an absent autoDecision as "ask the human"', async () => {
    const { run } = listener()
    expect(await run(fakeRequest(), nextHuman)).toBe('unavailable')
  })

  it('ignores requests that are not this plugin\'s guard escalation', async () => {
    const { run } = listener({ autoDecision: 'approve' })
    expect(await run(fakeRequest({ reason: 'hook: needs approval' }), nextHuman)).toBe('unavailable')
    expect(await run(fakeRequest({ reason: 'jev-guardish but not ours' }), nextHuman)).toBe('unavailable')
    expect(await run(fakeRequest({ reason: undefined }), nextHuman)).toBe('unavailable')
  })

  it('requires fresh evidence for the same tool', async () => {
    const { run } = listener({ autoDecision: 'approve' })
    expect(await run(fakeRequest({ toolName: 'write' }), nextHuman)).toBe('unavailable')
  })

  it('delegates in shadow mode, when the plugin is disabled, or without a call id', async () => {
    const shadow = listener({ live: { enabled: true, mode: 'shadow' }, autoDecision: 'approve' })
    expect(await shadow.run(fakeRequest(), nextHuman)).toBe('unavailable')
    const disabled = listener({ live: { enabled: false, mode: 'enforce' }, autoDecision: 'deny' })
    expect(await disabled.run(fakeRequest(), nextHuman)).toBe('unavailable')
    const { run } = listener({ autoDecision: 'approve' })
    expect(await run(fakeRequest({ callId: undefined }), nextHuman)).toBe('unavailable')
  })
})
