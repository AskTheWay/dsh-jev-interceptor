// 复现脚本：验证 retention.js 打分键错位 bug
// 场景：5 条消息 m0..m4（每条文本 100 字节 ASCII），m4 为 newest 不可丢
// scores = {m0:0.9, m1:0.0, m2:1.0(CRITICAL), m3:0.5}
// 预算设为「丢 1 条后仍超、丢 2 条后恰好放下」的窗口中点 → 恰好 2 次整条丢弃
import { retainScoredSession, projectConversation } from 'file:///D:/python_workspace/agents/dsh-jev-interceptor/lib/retention.js'

const TAG = (i) => `m${i}::` + 'x'.repeat(100 - `m${i}::`.length) // 每条恰好 100 字节
const texts = [TAG(0), TAG(1), TAG(2), TAG(3), TAG(4)]

const snapshot = {
  session: { id: 's-test', cwd: null, version: 1 },
  capturedThroughSeq: 5,
  events: texts.map((text, i) =>
    i % 2 === 0
      ? { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }
      : { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } },
  ),
}

// 序列化字节（与模块内部 stringifyTagSafeJson 一致：文本无 '<'，replaceAll 无影响）
const byteSize = (conversation) =>
  Buffer.byteLength(JSON.stringify({
    sessionId: 's-test', label: 'L', cwd: null, capturedThroughSeq: 5,
    conversation: conversation.map(({ role, text }) => ({ role, text })),
  }), 'utf8')

const size5 = byteSize(projectConversation(snapshot).map(({ role, text }) => ({ role, text })))
const size4 = byteSize(projectConversation(snapshot).slice(1).map(({ role, text }) => ({ role, text }))) // 丢任意 1 条
const size3 = byteSize(projectConversation(snapshot).slice(2).map(({ role, text }) => ({ role, text }))) // 丢任意 2 条
const maxBytes = Math.floor((size3 + size4) / 2) // 窗口中点：丢1条仍超，丢2条恰好放下
console.log(`size5=${size5} size4(丢1条)=${size4} size3(丢2条)=${size3} maxBytes=${maxBytes}`)

// 原始投影索引 → 分数（与 session-reference.ts scoreSnapshot 写入的键一致）
const scores = new Map([[0, 0.9], [1, 0.0], [2, 1.0], [3, 0.5]]) // m4 是 newest 不可丢，无需打分

const result = retainScoredSession(snapshot, 'L', maxBytes, scores)
const which = (t) => t.slice(0, t.indexOf(':'))
console.log('--- scored 模式实际结果 ---')
console.log('丢弃条数 omittedMessages =', result.stats.omittedMessages, '(预算设计预期 = 2)')
console.log('保留消息:', result.data.conversation.map((c) => which(c.text)).join(', '))
console.log('phase2 截断是否触发:', result.data.conversation.some((c) => c.text.includes('omitted')))

console.log('--- 期望的正确结果（按分丢最不重要的两次） ---')
console.log('应丢弃 m1(0.0) 与 m3(0.5)，保留: m0, m2, m4  ← m2 是 score=1.0 的 critical')

// FIFO 对照（scores=null，即上游行为）
const fifo = retainScoredSession(snapshot, 'L', maxBytes, null)
console.log('--- FIFO 对照 (scores=null) ---')
console.log('保留消息:', fifo.data.conversation.map((c) => which(c.text)).join(', '), '丢弃', fifo.stats.omittedMessages, '条')
