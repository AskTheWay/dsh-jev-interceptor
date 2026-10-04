import { describe, expect, it } from 'vitest'
import { ApprovalTrace, createApprovalLoopListener } from '../src/approval-loop.js'
import { Telemetry, type TelemetryEntry } from '../src/telemetry.js'

/** Capturing telemetry stub: record() lands synchronously in an array. */
class CapturingTelemetry {
  readonly entries: TelemetryEntry[] = []
  record(entry: TelemetryEntry): void {
    this.entries.push(entry)
  }
}

function fakeSession(id = 'session-1'): { id: string } {
  return { id }
}

describe('ApprovalTrace agreement matrix', () => {
  it('flags the headline case: Jev would auto-approve, the human rejected', () => {
    const trace = new ApprovalTrace()
    trace.noteAsked('a1', 's1', 'bash', 'call-1')
    trace.noteVerdict('s1', 'call-1', 'auto-approve')
    const agreement = trace.onDecided('a1', 'rejected')
    expect(agreement?.bucket).toBe('would-over-approve')
    expect(agreement?.jev).toBe('auto-approve')
    expect(agreement?.human).toBe('rejected')
  })

  it('flags friction: Jev said human-only, the human approved anyway', () => {
    const trace = new ApprovalTrace()
    trace.noteAsked('a1', 's1', 'bash', 'call-1')
    trace.noteVerdict('s1', 'call-1', 'human')
    expect(trace.onDecided('a1', 'allowed-once')?.bucket).toBe('friction-human-approved')
  })

  it('records aligned outcomes on both sides', () => {
    const trace = new ApprovalTrace()
    trace.noteAsked('a1', 's1', 'bash', 'c1')
    trace.noteVerdict('s1', 'c1', 'auto-approve')
    expect(trace.onDecided('a1', 'allowed-once')?.bucket).toBe('aligned-approve')
    trace.noteAsked('a2', 's1', 'bash', 'c2')
    trace.noteVerdict('s1', 'c2', 'human')
    expect(trace.onDecided('a2', 'rejected')?.bucket).toBe('aligned-reject')
  })

  it('skips asks Jev never evaluated and unknown ids', () => {
    const trace = new ApprovalTrace()
    trace.noteAsked('a1', 's1', 'bash', 'c1')
    expect(trace.onDecided('a1', 'rejected')).toBeUndefined()
    trace.noteAsked('a2', 's1', 'bash')
    trace.noteVerdict('s1', 'missing-call', 'auto-approve')
    expect(trace.onDecided('unknown', 'rejected')).toBeUndefined()
  })

  it('correlates re-escalations to the newest open ask of the same call', () => {
    const trace = new ApprovalTrace()
    trace.noteAsked('a1', 's1', 'bash', 'c1')
    trace.noteAsked('a2', 's1', 'bash', 'c1')
    // The verdict attaches to a2 (the open ask), not the superseded a1.
    trace.noteVerdict('s1', 'c1', 'auto-approve')
    expect(trace.onDecided('a1', 'rejected')).toBeUndefined()
    expect(trace.onDecided('a2', 'rejected')?.bucket).toBe('would-over-approve')
  })

  it('never crosses sessions on colliding call ids', () => {
    const trace = new ApprovalTrace()
    trace.noteAsked('a1', 's1', 'bash', 'call-0')
    trace.noteVerdict('s2', 'call-0', 'auto-approve')
    expect(trace.onDecided('a1', 'rejected')).toBeUndefined()
  })
})

describe('createApprovalLoopListener', () => {
  it('feeds the trace from asked/decided events and writes agreement telemetry', () => {
    const trace = new ApprovalTrace()
    const telemetry = new CapturingTelemetry()
    const listener = createApprovalLoopListener({ trace, telemetry: telemetry as unknown as Telemetry })
    const session = fakeSession('s1') as never

    listener(session, { type: 'approval/asked', data: { id: 'a1', toolName: 'bash', callId: 'c1' } } as never)
    trace.noteVerdict('s1', 'c1', 'auto-approve')
    listener(session, { type: 'approval/decided', data: { id: 'a1', outcome: 'rejected' } } as never)

    expect(telemetry.entries.length).toBe(1)
    const entry = telemetry.entries[0]
    expect(entry.tag).toBe('approval-loop')
    expect(entry.action).toBe('agreement')
    expect(entry.detail).toContain('would-over-approve')
    expect(entry.detail).toContain('jev=auto-approve')
    expect(entry.detail).toContain('human=rejected')
  })

  it('ignores unrelated session events', () => {
    const trace = new ApprovalTrace()
    const telemetry = new CapturingTelemetry()
    const listener = createApprovalLoopListener({ trace, telemetry: telemetry as unknown as Telemetry })
    listener(fakeSession('s1') as never, { type: 'user/message', data: {} } as never)
    listener(fakeSession('s1') as never, { type: 'turn/start', data: { turn: 1 } } as never)
    expect(telemetry.entries.length).toBe(0)
  })
})
