/**
 * Plugin configuration. Every deployment-varying choice is a schema field so
 * `cordis.yml` can change it without a code edit; defaults keep the plugin
 * inert (`enabled: false`) and conservative (`mode: 'shadow'`).
 * @module dsh-jev-interceptor/config
 */

import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Complete plugin configuration, validated by the same-named schema.
 *
 * All fields are optional in YAML. `enabled: false` (the default) makes the
 * plugin register nothing and behave exactly like an absent plugin; turning it
 * on starts in `shadow` mode, which observes and records decisions without
 * enforcing them.
 */
export interface Config {
  /** Master switch; `false` (default) leaves stock behavior untouched. */
  enabled?: boolean
  /** `shadow` (default) records would-be decisions only; `enforce` acts on them. */
  mode?: 'shadow' | 'enforce'
  /** Which Jev entry point to call. */
  provider?: 'typesafe' | 'openrouter' | 'custom'
  /** Full decisions endpoint URL; required for `custom`, overrides the preset otherwise. */
  endpoint?: string
  /** Model id; defaults to the provider preset (`jev-latest` / `~typesafe/jev-latest`). */
  model?: string
  /** Credential reference (environment-variable name) resolved per request; default `TYPESAFE_API_KEY`. */
  apiKeyEnv?: string
  /** Wall-clock budget per decision attempt in milliseconds (default 1500). */
  timeoutMs?: number
  /** Cooldown after consecutive failures in milliseconds (default 60000). */
  cooldownMs?: number
  /** Consecutive failures that open the cooldown (default 3). */
  failureThreshold?: number
  /** Maximum in-flight Jev requests (default 4; the provider rate-limits near 8). */
  maxConcurrency?: number
  /** Decision input cache capacity (default 512). */
  cacheSize?: number
  /** Directory for `telemetry.jsonl` (default `~/.dsh-jev-interceptor`). */
  telemetryDir?: string
  /** Trailing messages digested into the guard state (default 6). */
  recentMessages?: number
  /** Per-message text bound in the state, characters (default 300). */
  recentMessageChars?: number
  /** Head characters kept from tool arguments in the state (default 2048). */
  argsHeadChars?: number
  /** Tail characters kept from tool arguments in the state (default 512). */
  argsTailChars?: number

  /** Guard hook master switch (default on when the plugin is enabled). */
  guardEnabled?: boolean
  /** Tool names skipped without a Jev call (read-only short-circuit, zero cost). */
  guardReadOnlyTools?: string[]
  /** Tool names never classified by this plugin. */
  guardExcludeTools?: string[]
  /** Minimum risk confidence to act on medium/low classifications (default 0.6). */
  guardConfidenceMin?: number
  /** Confidence for a high classification to deny instead of asking (default 0.85). */
  guardDenyConfidence?: number
  /** Irreversibility at/above which even a low-risk call escalates (default 0.2). */
  guardIrreversibleCeiling?: number
  /** Irreversibility required (with high risk + confidence) to deny instead of ask (default 0.5). */
  guardIrreversibleDenyFloor?: number
  /** Injection probability at/above which a call escalates regardless of risk (default 0.8). */
  guardInjectionAskThreshold?: number

  /** Pre-approval hook master switch (default on when the plugin is enabled). */
  preapproveEnabled?: boolean
  /** Tools eligible for auto-approval; empty (default) disables every auto-approval. */
  preapproveToolAllowlist?: string[]
  /** Confidence required on BOTH pre-approval questions (default 0.85). */
  preapproveAutoApproveMin?: number
  /** Irreversibility at/above which auto-approval is blocked (default 0.15). */
  preapproveIrreversibleMax?: number
}

/** Read-only dsh tool names (verified against the dsh tool registry) that never need classification. */
const DEFAULT_READ_ONLY_TOOLS = ['read', 'read_image', 'grep', 'glob', 'todo_write'] as const

/**
 * Every default in one place: the schema references these for YAML loads, and
 * {@link resolveSettings} re-applies them for programmatic construction that
 * bypasses Schemastery normalization (the explicit resolve step dsh requires
 * over hidden `??` fallbacks scattered through `run()` paths).
 */
export const DEFAULTS = {
  enabled: false,
  mode: 'shadow' as const,
  provider: 'typesafe' as const,
  apiKeyEnv: 'TYPESAFE_API_KEY',
  timeoutMs: 1500,
  cooldownMs: 60_000,
  failureThreshold: 3,
  maxConcurrency: 4,
  cacheSize: 512,
  recentMessages: 6,
  recentMessageChars: 300,
  argsHeadChars: 2048,
  argsTailChars: 512,
  guardEnabled: true,
  guardReadOnlyTools: [...DEFAULT_READ_ONLY_TOOLS],
  guardExcludeTools: [] as string[],
  guardConfidenceMin: 0.6,
  guardDenyConfidence: 0.85,
  guardIrreversibleCeiling: 0.2,
  guardIrreversibleDenyFloor: 0.5,
  guardInjectionAskThreshold: 0.8,
  preapproveEnabled: true,
  preapproveToolAllowlist: [] as string[],
  preapproveAutoApproveMin: 0.85,
  preapproveIrreversibleMax: 0.15,
} as const

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled),
  mode: z.union(['shadow', 'enforce']).default(DEFAULTS.mode),
  provider: z.union(['typesafe', 'openrouter', 'custom']).default(DEFAULTS.provider),
  endpoint: z.string(),
  model: z.string(),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULTS.apiKeyEnv),
  timeoutMs: z.number().step(1).min(100).default(DEFAULTS.timeoutMs),
  cooldownMs: z.number().step(1).min(1000).default(DEFAULTS.cooldownMs),
  failureThreshold: z.number().step(1).min(1).default(DEFAULTS.failureThreshold),
  maxConcurrency: z.number().step(1).min(1).max(8).default(DEFAULTS.maxConcurrency),
  cacheSize: z.number().step(1).min(0).default(DEFAULTS.cacheSize),
  telemetryDir: z.string(),
  recentMessages: z.number().step(1).min(0).max(24).default(DEFAULTS.recentMessages),
  recentMessageChars: z.number().step(1).min(40).default(DEFAULTS.recentMessageChars),
  argsHeadChars: z.number().step(1).min(64).default(DEFAULTS.argsHeadChars),
  argsTailChars: z.number().step(1).min(0).default(DEFAULTS.argsTailChars),

  guardEnabled: z.boolean().default(DEFAULTS.guardEnabled),
  guardReadOnlyTools: z.array(z.string()).default([...DEFAULTS.guardReadOnlyTools]),
  guardExcludeTools: z.array(z.string()).default(DEFAULTS.guardExcludeTools),
  guardConfidenceMin: z.number().min(0).max(1).default(DEFAULTS.guardConfidenceMin),
  guardDenyConfidence: z.number().min(0).max(1).default(DEFAULTS.guardDenyConfidence),
  guardIrreversibleCeiling: z.number().min(0).max(1).default(DEFAULTS.guardIrreversibleCeiling),
  guardIrreversibleDenyFloor: z.number().min(0).max(1).default(DEFAULTS.guardIrreversibleDenyFloor),
  guardInjectionAskThreshold: z.number().min(0).max(1).default(DEFAULTS.guardInjectionAskThreshold),

  preapproveEnabled: z.boolean().default(DEFAULTS.preapproveEnabled),
  preapproveToolAllowlist: z.array(z.string()).default(DEFAULTS.preapproveToolAllowlist),
  preapproveAutoApproveMin: z.number().min(0).max(1).default(DEFAULTS.preapproveAutoApproveMin),
  preapproveIrreversibleMax: z.number().min(0).max(1).default(DEFAULTS.preapproveIrreversibleMax),
})

/** Fully-defaulted settings, the one resolved shape the rest of the plugin consumes. */
export interface ResolvedSettings {
  readonly mode: 'shadow' | 'enforce'
  readonly timeoutMs: number
  readonly cooldownMs: number
  readonly failureThreshold: number
  readonly maxConcurrency: number
  readonly cacheSize: number
  readonly telemetryDir: string
  readonly recentMessages: number
  readonly recentMessageChars: number
  readonly argsHeadChars: number
  readonly argsTailChars: number
  readonly guardEnabled: boolean
  readonly readOnlyTools: ReadonlySet<string>
  readonly excludeTools: ReadonlySet<string>
  readonly guardConfidenceMin: number
  readonly guardDenyConfidence: number
  readonly guardIrreversibleCeiling: number
  readonly guardIrreversibleDenyFloor: number
  readonly guardInjectionAskThreshold: number
  readonly preapproveEnabled: boolean
  readonly preapproveToolAllowlist: ReadonlySet<string>
  readonly preapproveAutoApproveMin: number
  readonly preapproveIrreversibleMax: number
  readonly apiKeyEnv: string
}

/**
 * The explicit resolve step from raw config to fully-defaulted settings.
 * @param config - raw plugin config (YAML-validated or programmatic).
 * @returns settings with every field populated.
 */
export function resolveSettings(config: Config): ResolvedSettings {
  return {
    mode: config.mode ?? DEFAULTS.mode,
    timeoutMs: config.timeoutMs ?? DEFAULTS.timeoutMs,
    cooldownMs: config.cooldownMs ?? DEFAULTS.cooldownMs,
    failureThreshold: config.failureThreshold ?? DEFAULTS.failureThreshold,
    maxConcurrency: config.maxConcurrency ?? DEFAULTS.maxConcurrency,
    cacheSize: config.cacheSize ?? DEFAULTS.cacheSize,
    telemetryDir: config.telemetryDir && config.telemetryDir.length > 0
      ? config.telemetryDir
      : joinHome('.dsh-jev-interceptor'),
    recentMessages: config.recentMessages ?? DEFAULTS.recentMessages,
    recentMessageChars: config.recentMessageChars ?? DEFAULTS.recentMessageChars,
    argsHeadChars: config.argsHeadChars ?? DEFAULTS.argsHeadChars,
    argsTailChars: config.argsTailChars ?? DEFAULTS.argsTailChars,
    guardEnabled: config.guardEnabled ?? DEFAULTS.guardEnabled,
    readOnlyTools: new Set(config.guardReadOnlyTools ?? DEFAULTS.guardReadOnlyTools),
    excludeTools: new Set(config.guardExcludeTools ?? DEFAULTS.guardExcludeTools),
    guardConfidenceMin: config.guardConfidenceMin ?? DEFAULTS.guardConfidenceMin,
    guardDenyConfidence: config.guardDenyConfidence ?? DEFAULTS.guardDenyConfidence,
    guardIrreversibleCeiling: config.guardIrreversibleCeiling ?? DEFAULTS.guardIrreversibleCeiling,
    guardIrreversibleDenyFloor: config.guardIrreversibleDenyFloor ?? DEFAULTS.guardIrreversibleDenyFloor,
    guardInjectionAskThreshold: config.guardInjectionAskThreshold ?? DEFAULTS.guardInjectionAskThreshold,
    preapproveEnabled: config.preapproveEnabled ?? DEFAULTS.preapproveEnabled,
    preapproveToolAllowlist: new Set(config.preapproveToolAllowlist ?? DEFAULTS.preapproveToolAllowlist),
    preapproveAutoApproveMin: config.preapproveAutoApproveMin ?? DEFAULTS.preapproveAutoApproveMin,
    preapproveIrreversibleMax: config.preapproveIrreversibleMax ?? DEFAULTS.preapproveIrreversibleMax,
    apiKeyEnv: config.apiKeyEnv ?? DEFAULTS.apiKeyEnv,
  }
}

/** Default telemetry directory under the user's home. */
function joinHome(relative: string): string {
  return join(homedir(), relative)
}

/** TypeSafe's public decisions endpoint. */
export const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

/** OpenRouter's alpha decisions endpoint (model ids carry a `~` prefix there). */
export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions'

/** Default model id for the TypeSafe provider preset. */
export const TYPESAFE_MODEL = 'jev-latest'

/** Default model id for the OpenRouter provider preset. */
export const OPENROUTER_MODEL = '~typesafe/jev-latest'

/**
 * Resolve the effective endpoint and model for the configured provider.
 * @param config - validated plugin configuration.
 * @returns the endpoint URL and model id.
 * @throws when `custom` is selected without an explicit endpoint and model.
 */
export function resolveEndpoint(config: Config): { endpoint: string; model: string } {
  if (config.provider === 'custom') {
    if (config.endpoint === undefined || config.endpoint.length === 0) {
      throw new Error('dsh-jev-interceptor: provider "custom" requires endpoint')
    }
    if (config.model === undefined || config.model.length === 0) {
      throw new Error('dsh-jev-interceptor: provider "custom" requires model')
    }
    return { endpoint: config.endpoint, model: config.model }
  }
  const preset = config.provider === 'openrouter'
    ? { endpoint: OPENROUTER_ENDPOINT, model: OPENROUTER_MODEL }
    : { endpoint: TYPESAFE_ENDPOINT, model: TYPESAFE_MODEL }
  return {
    endpoint: config.endpoint ?? preset.endpoint,
    model: config.model ?? preset.model,
  }
}
