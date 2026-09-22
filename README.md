# dsh-jev-interceptor

English | [中文](README.zh.md)

[System-1 decisions](docs/jev-usage-points.md) for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): this plugin classifies every pending tool call with [Jev](https://typesafe.ai) — TypeSafe AI's non-generative "System One" model — in one millisecond-scale request, and uses the calibrated answers to

1. **escalate risky calls to a human before they run** (`tools/pre-execute`), and
2. **auto-approve clearly-granted, reversible ones** (`approval/request`) so humans stop clicking through routine approvals.

Everything degrades fail-closed: with no key, during provider cooldown, on timeout, or on any internal error, every hook delegates through `next()` and dsh behaves exactly as if this plugin were not installed. The plugin never widens a permission the base composition would not grant, and it is inert until you enable it.

## Why

dsh ships no per-call risk classifier — the pre-execute waterfall's default is plain `allow`. The only built-in precedent, `experimental/auto-review`, runs a **generative** LLM at temperature 0 and parses a hand-written JSON protocol to do a three-way classification: slow, expensive, and self-described as experimental. This plugin puts the same decision where it belongs — a typed decision primitive:

| | auto-review (generative LLM) | this plugin (Jev) |
|---|---|---|
| Decision shape | JSON text emitted token-by-token, then parsed | typed `choice`/`noul` answers, structurally zero type errors |
| Cost | one full LLM request per call | ~$0.00002 per call at ~1-4k input tokens ($0.042/MTok) |
| Uncertainty | implicit in prose | per-question probability distributions + confidence |
| Failure | parse fallback → deny | low confidence → delegate (`next()`), never a guess |

The full inventory of where Jev fits in dsh — this plugin's two hooks plus eleven verified roadmap hooks (model routing, subagent defaults, worker-report verification, image-offload pre-planning, session-snapshot retention, and more) — lives in [docs/jev-usage-points.md](docs/jev-usage-points.md).

## Install

Requires Node ≥ 20.3 (AbortSignal.any) and a dsh profile.

```sh
dsh plugin --profile <name> add dsh-jev-interceptor
```

or from a git checkout (users must allowlist the build script; see the dsh plugin docs):

```sh
dsh plugin --profile <name> add github:<you>/dsh-jev-interceptor
```

## Configure

The plugin is disabled by default and starts in **shadow mode** when enabled — it records every decision it *would* take (telemetry + `/jev-stats`) without enforcing anything. Promote to `enforce` once the numbers look right.

In your profile's `cordis.patch.yml` (or via the settings surface):

```yaml
- id: jev-interceptor
  name: dsh-jev-interceptor
  config:
    enabled: true
    mode: shadow            # or 'enforce' to act on decisions
    provider: typesafe      # 'typesafe' | 'openrouter' | 'custom'
    # apiKeyEnv: TYPESAFE_API_KEY   # credential-ref; or OPENROUTER_API_KEY for openrouter
    # endpoint: ...                 # required for provider: custom
    # model: ...                    # defaults per provider; pin a version for stable thresholds
```

OpenRouter example (decisions models live on a dedicated endpoint there):

```yaml
    provider: openrouter
    apiKeyEnv: OPENROUTER_API_KEY
```

Everything else is a config field (timeouts, cooldown, concurrency, cache, per-hook thresholds, tool lists) — see the `Config` schema in `src/config.ts`. Notable defaults:

- read-only tools (`read`, `read_image`, `grep`, `glob`, `todo_write`) short-circuit with zero cost;
- the Auto permission preset is left entirely to `auto-review`;
- the pre-approval allowlist starts **empty** — until you name tools in `preapproveToolAllowlist`, nothing is ever auto-approved.

## Safety model

- **Never `allow`.** "No objection" is expressed as `next()`, so downstream listeners (external hooks, auto-review) keep their veto.
- **Fail-closed everywhere.** No key / cooldown / timeout / parse mismatch / internal error → delegate. The approval service's `never` policy is enforced upstream of every listener, so this plugin structurally cannot relax it.
- **Evidence-gated auto-approval.** `allowed-once` requires captured argument evidence: only a call the guard escalated (fresh pending entry, matching session and tool) can be auto-approved. Hook asks and sandbox escalations carry no arguments and always go to the human.
- **Injection-aware.** Tool arguments enter the Jev `state` data field only; `instructions` are fixed strings; a suspected-injection answer escalates rather than suppresses.
- **Bounded input.** Head+tail argument previews and trailing-message digests — the provider's own guidance is to filter in code and send only what a question needs.
- **Observable.** Every decision lands in `<dsh-home>/plugins/dsh-jev-interceptor/telemetry.jsonl` (default `~/.dsh/plugins/dsh-jev-interceptor/`, honoring `$DSH_HOME`) (action, answers, confidence, latency, tokens, cost, degrade reasons); `/jev-stats` summarizes it per hook.
- **Resilient.** Wall-clock timeout per attempt, one retry on 429/529, cooldown after consecutive failures (timeouts count), in-flight cap (default 4; the provider rate-limits near 8), LRU decision cache.

## Development

```sh
npm install --legacy-peer-deps   # devDeps pin a current dsh API generation
npm run typecheck
npm test                         # vitest, 52 tests, no network
npm run build                    # tsc -> lib/
```

`scripts/smoke.mjs` runs the built client once against a real provider (set `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`).

## Status and roadmap

v0.1 implements the approval loop (guard + pre-approval + telemetry). The verified next hooks — content-aware model routing, subagent model defaults, Ralph report verification, goal-round progress, image-offload pre-planning, session-snapshot retention — are catalogued in [docs/jev-usage-points.md](docs/jev-usage-points.md). Jev is a closed, early-access service: the client speaks the plain `state + questions` shape shared by TypeSafe direct, OpenRouter, and the Apache-2.0 local alternative [Laya](https://huggingface.co/convaiinnovations/laya), so providers stay swappable.

## License

[MIT](LICENSE)
