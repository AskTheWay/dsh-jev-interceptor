import { JevClient, Telemetry } from '../lib/index.js'
import { projectConversation, retainScoredSession, scoreCandidateIndices, previewAt } from '../lib/retention.js'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const key = process.env.OPENROUTER_API_KEY
const client = new JevClient({
  endpoint: 'https://openrouter.ai/api/alpha/decisions', model: '~typesafe/jev-latest',
  timeoutMs: 8000, cooldownMs: 30_000, failureThreshold: 3, maxConcurrency: 4, cacheSize: 0,
  resolveKey: async () => key,
  telemetry: new Telemetry(await mkdtemp(join(tmpdir(), 'probe-'))),
  logger: { warn: () => {} },
})

const CN = [
  ['user', '你好，帮我看一下这个项目，第一次接触'],
  ['user', '需求：登录页在 Safari 下样式错位，参考 Figma 设计稿修复'],
  ['assistant', '好的，我先看下 login.css 和相关组件的现状'],
  ['user', 'npm install 输出：added 312 packages in 18s, 5 vulnerabilities'],
  ['user', "错误现场：TypeError: Cannot read properties of undefined (reading 'token') at auth.ts:88 in handleLogin"],
  ['assistant', '定位到了：auth.ts:88 在 token 未初始化时直接访问了 .value'],
  ['user', '关键决定：用可选链 + 默认空字符串修复，不要改动全局状态结构'],
  ['user', '哈哈哈今天好累，改完这个就去吃饭'],
  ['assistant', '修复已提交，npm test 全部通过（32 个用例）'],
  ['user', '对了，记得把 README 里的旧截图也换成新版本的'],
  ['user', '顺便聊聊，你觉得 Vue 和 React 哪个更适合这个项目？'],
  ['assistant', '框架对比长文：Vue 模板语法上手快，React 生态更大，迁移成本方面……（600 字泛谈）'],
  ['user', '最新：Safari 实测正常，这个问题可以收尾了'],
]
const snap = {
  session: { id: 's', cwd: '/w', version: 1, createdAt: 0 }, capturedThroughSeq: CN.length,
  events: CN.map(([role, text], i) => role === 'user'
    ? { type: 'user/message', seq: i, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }
    : { type: 'assistant/message', seq: i, data: { message: { content: [{ type: 'text', text }] }, turn: 0, step: 0, attempt: 0, revision: 0, stopReason: { kind: 'stop' } } }),
}
// 1) 真实打分
const projected = projectConversation(snap)
const indices = scoreCandidateIndices(projected, 40)
const LEVELS = ['noise: greetings, chit-chat, or superseded logs', 'background', 'relevant', 'critical: error evidence, unresolved threads, or decisions/fixes that shaped the code']
const questions = {}
for (const i of indices) questions[`msg_${i}`] = { type: 'score', instructions: `Score this message's value for the task in \`task\`, judging \`messages.${i}\``, criteria: [...LEVELS] }
const r = await client.classify({ tag: 'session-reference', mode: 'shadow',
  state: { task: '写周报：回顾登录页 token 报错当时怎么定位和修复的', referenced_session: 'cn',
    messages: indices.map(i => ({ index: i, role: projected[i].role, preview: previewAt(projected, i, 300) })) }, questions })
const scores = new Map()
for (const i of indices) { const a = r.answers[`msg_${i}`]; if (a?.type === 'score') scores.set(i, Math.min(1, Math.max(0, a.score / 3))) }
// 2) 同一预算两种保留
const sizeOf = items => Buffer.byteLength(JSON.stringify({ conversation: items.map(({role,text}) => ({role,text})) }), 'utf8')
const byLen = [...projected].sort((a,b) => Buffer.byteLength(a.text) - Buffer.byteLength(b.text))
let cut = 0; for (let i = 0; i < 5; i++) cut += Buffer.byteLength(byLen[i].text, 'utf8')
const budget = sizeOf(projected) - cut
const fifo = retainScoredSession(snap, 'L', budget, null)
const scored = retainScoredSession(snap, 'L', budget, scores)
const fmt = res => res.data.conversation.map(c => `[${c.role[0]}] ${c.text.slice(0, 40).replaceAll('\n',' ')}`).join('\n')
console.log(`预算 ${budget}B：FIFO 保留 ${fifo.stats.retainedMessages} 条 / 打分保留 ${scored.stats.retainedMessages} 条\n`)
// 3) 下游探针：三问 × 两快照
const PROBES = [
  '报错出现的确切位置是哪个文件的第几行？',
  '修复方案的关键决定是什么（不能改动什么）？',
  '修复后用什么命令验证、结果如何？',
  '最初的原始需求是什么？要求参考什么来修复？',
]
const ask = async (label, convo) => {
  let ok = 0
  for (const q of PROBES) {
    const a = await client.classify({ tag: 'session-reference', mode: 'shadow',
      state: { snapshot_label: label, conversation: convo, question: q },
      questions: { answerable: { type: 'noul', instructions: 'Can `question` be answered fully and correctly using ONLY the conversation in `conversation`? Do not use outside knowledge.', criteria: { true: 'The conversation contains the answer', false: 'The conversation lacks the answer or only implies it vaguely' } } } })
    const v = a?.answers.answerable?.noul ?? 0
    const yes = v >= 0.5
    if (yes) ok++
    console.log(`  ${label} | ${q} → ${yes ? '可答' : '不可答'} (p=${v.toFixed(2)})`)
  }
  return ok
}
console.log('=== FIFO 快照 ==='); const fifoOk = await ask('FIFO', fifo.data.conversation.map(c => ({ role: c.role, text: c.text })))
console.log('=== 打分快照 ==='); const scoredOk = await ask('SCORED', scored.data.conversation.map(c => ({ role: c.role, text: c.text })))
console.log(`\n结论：FIFO 可答 ${fifoOk}/3，打分可答 ${scoredOk}/3`)
