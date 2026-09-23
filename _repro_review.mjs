// 复现脚本:核验 retention.ts 打分索引错位
// 场景 A(Phase 1):[m0 score=0, m1 score=1.0, m2 score=1/3, m3 newest]
//   正确语义应删 m0、m2 保住 m1;若 bug 真实则删掉 score=1.0 的 m1 保住 m2。
// 场景 B(Phase 2):Phase 1 删 1 条后进入截断,检查截断靶是否被错位分数翻转。
import { retainScoredSession, projectConversation } from './lib/retention.js'

const mkSnapshot = (texts) => ({
  events: texts.map((t) => ({
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: t }] },
  })),
  session: { id: 's1', cwd: null },
  capturedThroughSeq: texts.length,
})

const describe = (r) =>
  r === undefined ? 'undefined' : r.data.conversation.map((c) => c.text.slice(0, 40)).join(' | ')

// ---------- 场景 A:Phase 1 丢弃循环错位 ----------
console.log('===== 场景 A: Phase 1 丢弃循环 =====')
const textsA = [
  'NOISE_FILLER_0 ' + 'x'.repeat(600),   // m0 噪声,长填充
  'CRITICAL_DECISION_1: adopt plan B',    // m1 关键证据,短
  'BACKGROUND_NOTE_2 ' + 'y'.repeat(300), // m2 背景,中
  'NEWEST_3 latest question',             // m3 最新,受保护
]
const snapA = mkSnapshot(textsA)
const scoresA = new Map([[0, 0.0], [1, 1.0], [2, 1 / 3]]) // m3 是 newest,按 scoreCandidateIndices 不会被评分

// 先探测 size 以选定 maxBytes:使「删 1 条不够、删 2 条(正确组合 m0+m2)刚好够」
const sizeOf = (keepIdx) => {
  const snap = mkSnapshot(keepIdx.map((i) => textsA[i]))
  return retainScoredSession(snap, 'L', Number.POSITIVE_INFINITY, null).data
    ? Buffer.byteLength(JSON.stringify({ sessionId: 's1', label: 'L', cwd: null, capturedThroughSeq: 4, conversation: keepIdx.map((i) => ({ role: 'user', text: textsA[i] })) }).replaceAll('<', '\\u003c'), 'utf8')
    : 0
}
const sizeKeep13 = sizeOf([1, 3])   // 正确语义保留集
const sizeKeep12 = sizeOf([1, 2])   // 仅删 m0(1 条)后
const maxBytesA = sizeKeep13        // 正确语义结果恰好 fit;单删 m0 不够
console.log('size(keep m1,m3)=', sizeKeep13, ' size(keep m1,m2)=', sizeKeep12, ' maxBytes =', maxBytesA)

const resultA = retainScoredSession(snapA, 'L', maxBytesA, scoresA)
console.log('实际(bug)保留 :', describe(resultA))
console.log('实际(bug) stats:', JSON.stringify(resultA?.stats))
const oracleA = retainScoredSession(mkSnapshot([textsA[1], textsA[3]]), 'L', Number.POSITIVE_INFINITY, null)
console.log('正确语义应保留 :', describe(oracleA), '(m0 score=0 与 m2 score=1/3 被删, score=1.0 的 m1 存活)')
console.log('m1(CRITICAL, score=1.0) 是否在实际结果中:', resultA?.data.conversation.some((c) => c.text.includes('CRITICAL')) ?? 'N/A')

// ---------- 场景 B:Phase 2 截断靶错位 ----------
console.log('\n===== 场景 B: Phase 2 截断选靶 =====')
const textsB = [
  'NOISE_LONG_0 ' + 'x'.repeat(500),        // m0 score=0,长
  'CRITICAL_LONG_1: decision log ' + 'z'.repeat(500), // m1 score=1.0,长
  'NEWEST_2 short',                          // m2 newest,未评分
]
const snapB = mkSnapshot(textsB)
const scoresB = new Map([[0, 0.0], [1, 1.0]])
// maxBytes:删掉 m0 之后仍需再截断一条才能放下
const sizeB1 = Buffer.byteLength(JSON.stringify({ sessionId: 's1', label: 'L', cwd: null, capturedThroughSeq: 3, conversation: [{ role: 'user', text: textsB[1] }, { role: 'user', text: textsB[2] }] }).replaceAll('<', '\\u003c'), 'utf8')
const maxBytesB = sizeB1 - 300 // 迫使 Phase 2 截断
const resultB = retainScoredSession(snapB, 'L', maxBytesB, scoresB)
console.log('结果:', describe(resultB))
console.log('stats:', JSON.stringify(resultB?.stats))
const truncatedWhich = resultB?.data.conversation.find((c) => c.text.includes('[… omitted'))
console.log('被截断的是:', truncatedWhich ? (truncatedWhich.text.includes('CRITICAL') ? 'm1 CRITICAL (score=1.0) — 错误:正确语义应截未评分的 m2 或以 longest 兜底,绝不截 score=1.0 的 m1' : 'm2') : '无')
console.log('\n验证 scores 键语义: scoreCandidateIndices 返回原始投影索引 =', '见 session-reference.ts L269/L296-300 scores.set(index,...)')
