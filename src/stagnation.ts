/**
 * 语义停滞检测（`tools/post-execute` + `agent/pre-step`）。
 *
 * dsh 的 repeat-tool-reminder 只能识别精确重复调用；换参数的死循环（同一
 * 工具、每次不同参数、反复失败）对它不可见。本监听器在有界失败窗口内
 * 检测这种模式，用一次 Jev 双 noul 判断（无进展 + 同类失败）确认后，
 * 把一条 plugin-notice 提醒注入下一请求的 additionalContexts——完全
 * 复刻 repeat-tool-reminder 的「observe-and-enrich, never veto」形态：
 * 不拦截结果、不改写内容，只附加上下文。
 *
 * fail-closed（这里比 pre-execute 更严格——上游约定 post-execute 里抛
 * 异常的 listener 会把整个调用改写成 isError）：
 * - 三层兜底：同步观察段 try/catch、Jev 判定内部全 catch、合并段 try/catch；
 *   任何异常都原样透传下游决策；
 * - Jev 降级（无 key/冷却/超时/解析失败）只记遥测，绝不注入提醒；
 * - 内存有界：WeakMap<Agent,...> 随 agent 回收，每 (agent, 工具) 窗口
 *   环形裁剪到 stagnationWindow 条，条目 10 分钟卫生过期。
 * @module dsh-jev-interceptor/stagnation
 */

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { decideStagnation, type StagnationAnswers } from './matrix.js'
import type { LiveSettings } from './config.js'
import type { JevClient } from './jev.js'
import { noul, type JevAnswers, type JevQuestion } from './types.js'
import { canonicalArguments } from './text.js'
import type { Telemetry } from './telemetry.js'

/** 一次尝试在窗口中的记录（全部字段有界）。 */
export interface AttemptRecord {
  /** 参数指纹（canonicalArguments 字符串）：互异指纹数 ≥2 才不是精确重复。 */
  readonly fingerprint: string
  readonly isError: boolean
  /** 参数预览（进 Jev state，长度受 stagnationArgsPreviewChars 限制）。 */
  readonly argsPreview: string
  /** 失败摘要（进 Jev state，长度有界）。 */
  readonly summary: string
  /** 记录时间（毫秒），供卫生过期。 */
  readonly at: number
}

/** 数值触发门（纯代码判断，Jev 只做其后的离散分类）。 */
export interface StagnationThresholds {
  /** 窗口内失败次数达到该值才考虑发起 Jev 判断。 */
  readonly triggerCount: number
  /** 失败占比下限（成功即清空语义下的显式安全门）。 */
  readonly failureRatioMin: number
  /** 两次提醒的最小间隔毫秒。 */
  readonly cooldownMs: number
}

/** 窗口条目的卫生过期上限：更老的失败不再构成「当前停滞」。 */
const STALE_MS = 10 * 60_000

/** 每 (agent, 工具) 的失败环形缓冲 + 提醒冷却时间。 */
export class StagnationTracker {
  private readonly windowSize: number
  private readonly windows = new WeakMap<object, Map<string, { attempts: AttemptRecord[]; lastAlertAt: number }>>()

  /**
   * @param windowSize - 每 (agent, 工具) 窗口容量（环形裁剪）。
   */
  constructor(windowSize: number) {
    this.windowSize = Math.max(2, windowSize)
  }

  /**
   * 记录一次失败尝试，返回过滤过期条目后的当前窗口（旧→新）。
   * @param agentKey - agent 对象（WeakMap 键，随 agent 回收）。
   * @param tool - 工具名。
   * @param attempt - 本次失败记录。
   * @param now - 当前毫秒时间。
   */
  record(agentKey: object, tool: string, attempt: AttemptRecord, now: number): readonly AttemptRecord[] {
    const perAgent = this.windows.get(agentKey) ?? new Map<string, { attempts: AttemptRecord[]; lastAlertAt: number }>()
    this.windows.set(agentKey, perAgent)
    const entry = perAgent.get(tool) ?? { attempts: [], lastAlertAt: 0 }
    entry.attempts = entry.attempts.filter(a => now - a.at <= STALE_MS)
    entry.attempts.push(attempt)
    if (entry.attempts.length > this.windowSize) entry.attempts.splice(0, entry.attempts.length - this.windowSize)
    perAgent.set(tool, entry)
    return entry.attempts
  }

  /** 成功调用清空该工具窗口：一次成功即证明这条路径走得通。 */
  clear(agentKey: object, tool: string): void {
    this.windows.get(agentKey)?.delete(tool)
  }

  /** 用户插话等外部信号：清空该 agent 的全部窗口。 */
  clearAgent(agentKey: object): void {
    this.windows.delete(agentKey)
  }

  /** 上次提醒时间（0 表示从未）。 */
  lastAlertAt(agentKey: object, tool: string): number {
    return this.windows.get(agentKey)?.get(tool)?.lastAlertAt ?? 0
  }

  /** 记录一次提醒（冷却起点）。 */
  noteAlert(agentKey: object, tool: string, now: number): void {
    const entry = this.windows.get(agentKey)?.get(tool)
    if (entry !== undefined) entry.lastAlertAt = now
  }
}

/**
 * 数值触发门：窗口是否值得花一次 Jev 判断。
 * 纯函数——count 达标、互异指纹 ≥2（精确重复是 repeat-tool-reminder 的
 * 地盘）、失败占比达标、冷却外。
 * @param attempts - 当前有效窗口。
 * @param thresholds - 数值门槛。
 * @param lastAlertAt - 上次提醒时间（0 = 从未）。
 * @param now - 当前毫秒时间。
 */
export function shouldProbe(
  attempts: readonly AttemptRecord[],
  thresholds: StagnationThresholds,
  lastAlertAt: number,
  now: number,
): boolean {
  if (attempts.length < thresholds.triggerCount) return false
  // lastAlertAt 为 0 表示从未报警，不受冷却限制。
  if (lastAlertAt > 0 && now - lastAlertAt < thresholds.cooldownMs) return false
  const failed = attempts.filter(a => a.isError).length
  if (attempts.length === 0 || failed / attempts.length < thresholds.failureRatioMin) return false
  // 精确重复（同一指纹）由上游 repeat-tool-reminder 覆盖；这里只看换参循环。
  const uniqueFingerprints = new Set(attempts.map(a => a.fingerprint)).size
  if (uniqueFingerprints < 2) return false
  return true
}

/**
 * 把一条失败消息压平成有界摘要（进 Jev state）。
 * @param message - 工具失败的 error.message。
 * @param maxChars - 摘要上限字符。
 */
export function summarizeFailure(message: string, maxChars: number): string {
  const flat = message.replaceAll(/\s+/g, ' ').trim()
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars)}…`
}

/** 参数预览：canonical 字符串截断。 */
function previewOf(arguments_: ToolExecution['arguments'], maxChars: number): string {
  const canonical = canonicalArguments(arguments_)
  return canonical.length <= maxChars ? canonical : `${canonical.slice(0, maxChars)}…`
}

/** The one fan-out every stagnation judgment asks. */
const STAGNATION_QUESTIONS: Readonly<Record<string, JevQuestion>> = {
  no_progress: noul(
    'The listed attempts are consecutive invocations of the same tool with different arguments that all failed. Judging only by the shown argument previews and error summaries, do these attempts show NO meaningful progress toward resolving the error?',
    {
      true: 'The attempts repeat variations of the same doomed approach with no sign of convergence',
      false: 'The attempts visibly change strategy, narrow the problem down, or otherwise progress',
    },
  ),
  similar_failure: noul(
    'Do the error summaries look like the same underlying failure repeating, rather than distinct problems being solved one by one?',
    {
      true: 'The errors share one root cause resurfacing across attempts',
      false: 'Each error is a distinct, different problem',
    },
  ),
}

/** Extract and kind-check the two stagnation answers. */
function extractStagnationAnswers(answers: JevAnswers): StagnationAnswers | undefined {
  const noProgress = answers['no_progress']
  const similarFailure = answers['similar_failure']
  if (noProgress?.type !== 'noul') return undefined
  if (similarFailure?.type !== 'noul') return undefined
  return { noProgress, similarFailure }
}

/** Resolved configuration and services the stagnation listener consumes. */
export interface StagnationDeps {
  /** Live settings read once per event: runtime toggles take effect immediately. */
  readonly live: () => LiveSettings
  readonly tracker: StagnationTracker
  readonly thresholds: StagnationThresholds
  /** 双 noul 行动置信门（stagnationConfidenceMin）。 */
  readonly confidenceMin: number
  readonly argsPreviewChars: number
  readonly jev: JevClient
  readonly telemetry: Telemetry
  readonly now?: () => number
}

/**
 * 构造停滞提醒消息（dsh-agent 的 model-selection notice 同款形态）。
 *
 * source.kind 是 merge-extensible 联合（上游注释明示"each producer declares
 * its own kind; consumers fall through unknown kinds"）：第三方插件声明自己
 * 的 kind，类型侧断言、运行时消费端按未知 kind 回退为普通内容展示。
 * summary 经 boundContextSummary 绑 120 字符上限。
 */
function buildReminder(tool: string, attempts: readonly AttemptRecord[], confidence: number): UserMessage {
  const text = `工具 ${tool} 已连续 ${String(attempts.length)} 次以不同参数失败，且失败模式相似、无进展迹象`
    + `（Jev 停滞判定，置信 ${confidence.toFixed(2)}）。当前策略疑似换参数死循环。`
    + '请停下来：重新阅读错误信息、换一条完全不同的解决路径，或向用户说明困难——不要继续微调参数重试。'
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'dsh-jev-interceptor',
      form: 'notice',
      summary: boundContextSummary(`${tool} 连续 ${String(attempts.length)} 次换参失败（疑似停滞）`),
    } as unknown as UserMessage['source'],
  })
}

/** 把提醒 prepend 进下游决策的 additionalContexts（block 分支保留 feedback）。 */
function prependContext(downstream: PostToolDecision, reminder: UserMessage): PostToolDecision {
  const contexts = [reminder, ...(downstream.additionalContexts ?? [])]
  if (downstream.kind === 'block') {
    return { kind: 'block', feedback: downstream.feedback, additionalContexts: contexts }
  }
  return { ...downstream, additionalContexts: contexts }
}

/** 观察段的产出：窗口满足触发门时携带已发起的 Jev 判断。 */
interface ObservedStagnation {
  readonly probe?: Promise<{ alerted: boolean; confidence: number } | undefined>
  readonly target?: { agent: object; tool: string; attempts: readonly AttemptRecord[] }
  readonly sessionId?: string
  /** 仅在 probe 发起时存在。 */
  readonly mode?: 'shadow' | 'enforce'
}

/**
 * 同步观察段：成功清空窗口、失败记录窗口、满足数值触发门时发起 Jev 判断
 * （与 next() 并行）。可抛——调用方 catch 后按未观察处理（照 guard.ts 的
 * evaluateGuard 形态，next() 一律在 try 之外调用）。
 */
function observeStagnation(
  deps: StagnationDeps,
  exec: ToolExecution,
  result: Readonly<ToolExecutionResult>,
  now: () => number,
): ObservedStagnation {
  const live = deps.live()
  if (!live.enabled || exec.agent === undefined) return {}
  const mode = live.mode
  const agent = exec.agent
  const sessionId = agent.session.id
  if (result.isError !== true) {
    deps.tracker.clear(agent, exec.name)
    return {}
  }
  const at = now()
  const attempts = deps.tracker.record(agent, exec.name, {
    fingerprint: canonicalArguments(exec.arguments),
    isError: true,
    argsPreview: previewOf(exec.arguments, deps.argsPreviewChars),
    summary: summarizeFailure(result.error.message, 200),
    at,
  }, at)
  if (!shouldProbe(attempts, deps.thresholds, deps.tracker.lastAlertAt(agent, exec.name), at)) {
    return {}
  }
  return {
    probe: judgeStagnation(deps, exec, attempts, mode, sessionId),
    target: { agent, tool: exec.name, attempts },
    sessionId,
    mode,
  }
}

/**
 * Create the stagnation listeners: the `tools/post-execute` observer and the
 * `agent/pre-step` user-interjection reset. Both register with plain append.
 * @param deps - resolved configuration and services.
 * @returns `{ onPostExecute, onPreStep }`。
 */
export function createStagnationListener(deps: StagnationDeps): {
  onPostExecute: (
    exec: ToolExecution,
    result: Readonly<ToolExecutionResult>,
    next: () => Promise<PostToolDecision>,
  ) => Promise<PostToolDecision>
  onPreStep: (
    payload: { agent: Agent; messages?: unknown[] },
    next: () => Promise<PreStepDecision>,
  ) => Promise<PreStepDecision>
} {
  const now = deps.now ?? Date.now
  return {
    onPostExecute: async (exec, result, next) => {
      // 观察段异常静默（上游契约：post-execute 对同一调用串行派发；这里抛
      // 异常会把整个调用改写成 isError——try 是安全边界）。next() 全程在
      // try 之外、恰好一次：吞掉它的拒绝会在排空的 waterfall 上二次调用，
      // 绕过上游「listener 抛异常 → isError」的 fail-closed 改写。
      let observed: ObservedStagnation = {}
      try {
        observed = observeStagnation(deps, exec, result, now)
      } catch {
        observed = {}
      }
      if (observed.probe === undefined || observed.target === undefined) return await next()
      const downstream = await next()
      try {
        const judged = await observed.probe
        if (judged === undefined || !judged.alerted) return downstream
        // shadow 模式只记遥测不注入（照 guard/preapprove 的 would-have 语义）。
        if (observed.mode === 'enforce') {
          deps.tracker.noteAlert(observed.target.agent, observed.target.tool, now())
          return prependContext(downstream, buildReminder(observed.target.tool, observed.target.attempts, judged.confidence))
        }
        return downstream
      } catch {
        return downstream
      }
    },
    onPreStep: async (payload, next) => {
      // 用户插话 = 新指令到达：该 agent 的停滞窗口全部作废（照抄
      // repeat-tool-reminder 的重置语义）。结构断言兼容两代 payload 形状。
      try {
        if (Array.isArray(payload.messages)) {
          for (const message of payload.messages) {
            const source = (message as { source?: { kind?: string } } | null)?.source
            if (source?.kind === 'user') {
              deps.tracker.clearAgent(payload.agent)
              break
            }
          }
        }
      } catch {
        // 重置失败不影响任何行为。
      }
      return await next()
    },
  }
}

/**
 * 一次停滞判断（内部全 catch：降级与异常都返回 undefined，绝不 reject）。
 */
async function judgeStagnation(
  deps: StagnationDeps,
  exec: ToolExecution,
  attempts: readonly AttemptRecord[],
  mode: 'shadow' | 'enforce',
  sessionId: string | undefined,
): Promise<{ alerted: boolean; confidence: number } | undefined> {
  try {
    const answers = await deps.jev.classify({
      tag: 'stagnation',
      mode,
      tool: exec.name,
      sessionId,
      state: {
        tool: exec.name,
        attempts: attempts.map(a => ({ args: a.argsPreview, error: a.summary })),
      },
      questions: STAGNATION_QUESTIONS,
      signal: exec.signal,
    })
    if (answers === null) return undefined // 降级已由 JevClient 记遥测
    const extracted = extractStagnationAnswers(answers.answers)
    if (extracted === undefined) {
      deps.telemetry.record({
        ts: new Date().toISOString(),
        tag: 'stagnation',
        mode,
        tool: exec.name,
        sessionId,
        action: 'degraded',
        detail: 'answer-shape-mismatch',
        latencyMs: answers.latencyMs,
      })
      return undefined
    }
    const verdict = decideStagnation(extracted, deps.confidenceMin)
    deps.telemetry.record({
      ts: new Date().toISOString(),
      tag: 'stagnation',
      mode,
      tool: exec.name,
      sessionId,
      model: answers.model,
      action: verdict === 'alert' ? 'stagnation-alert' : 'skipped',
      detail: `no_progress=${extracted.noProgress.noul.toFixed(2)} similar=${extracted.similarFailure.noul.toFixed(2)}`,
      latencyMs: answers.latencyMs,
      ...(answers.inputTokens === undefined ? {} : { inputTokens: answers.inputTokens }),
      ...(answers.costUsd === undefined ? {} : { costUsd: answers.costUsd }),
      cached: answers.cached,
    })
    const confidence = Math.min(extracted.noProgress.noul, extracted.similarFailure.noul)
    return { alerted: verdict === 'alert', confidence }
  } catch {
    return undefined
  }
}
