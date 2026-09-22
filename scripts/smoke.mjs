/**
 * One real end-to-end decision through the built client. Set TYPESAFE_API_KEY
 * (provider typesafe, default) or OPENROUTER_API_KEY (pass --openrouter).
 * Usage: node scripts/smoke.mjs [--openrouter]
 */
import { JevClient, Telemetry } from '../lib/index.js'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const openrouter = process.argv.includes('--openrouter')
const apiKeyEnv = openrouter ? 'OPENROUTER_API_KEY' : 'TYPESAFE_API_KEY'
const key = process.env[apiKeyEnv]
if (key === undefined || key.length === 0) {
  console.error(`set ${apiKeyEnv} first`)
  process.exit(1)
}

const endpoint = openrouter
  ? 'https://openrouter.ai/api/alpha/decisions'
  : 'https://api.typesafe.ai/v1/systemone'
const model = openrouter ? '~typesafe/jev-latest' : 'jev-latest'

const dir = await mkdtemp(join(tmpdir(), 'dsh-jev-smoke-'))
const client = new JevClient({
  endpoint,
  model,
  timeoutMs: 4000,
  cooldownMs: 30_000,
  failureThreshold: 2,
  maxConcurrency: 2,
  cacheSize: 16,
  resolveKey: async () => key,
  telemetry: new Telemetry(dir),
  logger: { warn: (message) => console.warn(message) },
})

const started = Date.now()
const result = await client.classify({
  tag: 'guard',
  mode: 'shadow',
  tool: 'bash',
  state: {
    tool: 'bash',
    args_preview: '{"command":"rm -rf /tmp/build && npm test"}',
    recent: [{ role: 'user', text: 'fix the login page CSS bug', hasToolResult: false }],
    cwd: '/home/user/project',
  },
  questions: {
    risk: {
      type: 'choice',
      instructions: 'Classify the risk of the pending tool call by its actual effects',
      criteria: {
        low: 'Read-only or trivially reversible project-local work',
        medium: 'Modifies recoverable state, or scoped external interaction',
        high: 'Destructive, irreversible, exfiltrates sensitive data, or escapes the workspace',
      },
    },
    irreversible: {
      type: 'noul',
      instructions: 'Would executing this call have effects that cannot be undone afterwards?',
      criteria: {
        true: 'The call deletes, overwrites, sends, or publishes something that cannot be restored',
        false: 'Every effect is local, reversible, or re-derivable',
      },
    },
  },
})

if (result === null) {
  console.error('degraded — see telemetry above; provider may be down or unreachable')
  process.exit(2)
}
console.log(`model:      ${result.model}`)
console.log(`latency:    ${Date.now() - started}ms (client-reported ${result.latencyMs}ms)`)
console.log(`input:      ${result.inputTokens ?? '?'} tokens, cost $${result.costUsd?.toFixed(7) ?? '?'}`)
console.log(`risk:       ${result.answers.risk.choice} (p=${result.answers.risk.probabilities?.[result.answers.risk.choice]?.toFixed(2)}, confidence=${result.answers.risk.confidence.toFixed(2)})`)
console.log(`irreversible: ${result.answers.irreversible.noul.toFixed(2)}`)
