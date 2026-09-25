# Contributing

English | [中文](CONTRIBUTING.zh.md)

Thanks for helping improve dsh-jev-interceptor.

## Development setup

- Node **≥ 20.3** (the code uses `AbortSignal.any`).
- The repo ships an `.npmrc` with `legacy-peer-deps=true` — current `@deepseek-ai/*` release-candidate peer ranges don't flatten under plain npm; runtime peers are provided by the dsh installation.

```sh
git clone https://github.com/AskTheWay/dsh-jev-interceptor.git
cd dsh-jev-interceptor
npm ci
npm run typecheck   # src + tests, against real @deepseek-ai package types
npm test            # vitest, offline, no API key needed
npm run build       # tsc -> lib/
```

Optional live checks (cost cents, need a key):

```sh
node scripts/smoke.mjs              # one real decision (TYPESAFE_API_KEY or OPENROUTER_API_KEY)
OPENROUTER_API_KEY=... node scripts/effect-test.mjs   # guard battery + retention duels
```

## How to submit

1. Branch from `main` (`feat/...`, `fix/...`, `docs/...`).
2. Keep commits in [Conventional Commits](https://www.conventionalcommits.org/) style (`feat:`, `fix:`, `docs:`, `test:`) — the release flow reads them.
3. Open a PR. CI must pass: typecheck (both tsconfigs), full test suite, build, and an `npm pack` sanity check.
4. **AI-assisted work is welcome — disclose it in the PR.** Substantial agent-written code should say so; depth evidence (tests, repro scripts) matters more than authorship, and concealment costs trust.

## Repository layout

| Module | Owns |
|---|---|
| `src/index.ts` | Plugin entry: mounts hooks, shared Jev client, `/jev-stats` |
| `src/jev.ts` | The decision client: wall-clock budget, retry, cooldown, concurrency, cache — returns `null` (degrade) instead of throwing |
| `src/guard.ts` | `tools/pre-execute` risk gate + the `PendingAsks` bridge |
| `src/preapprove.ts` | `approval/request` evidence-gated auto-approval |
| `src/session-reference.ts` | Subclassed resolver taking over session retention |
| `src/retention.ts` | Pure retention algorithm (fork of upstream projection.ts) |
| `src/matrix.ts` | Pure decision matrices (guard / preapprove) |
| `src/resilience.ts` | Semaphore, cooldown gate, LRU |
| `src/config.ts` | Schemastery schema + `DEFAULTS` + the explicit `resolveSettings` step |
| `src/telemetry.ts` | JSONL decision log + `/jev-stats` aggregation |

`docs/jev-usage-points.md` maps every verified decision point in dsh and which ones this plugin claims.

## The safety contract (read before touching hooks)

These invariants are the product. Each has regression tests; if your change weakens one, the change is wrong.

1. **Never widen permissions.** The guard never returns `allow` — "no objection" is `next()`. The approval `never` policy is enforced upstream and must stay unreachable from here.
2. **Fail closed to stock behavior, always.** No key / cooldown / timeout / parse mismatch / internal error → delegate. A decision hook that throws or blocks on provider failure is a bug; see `test/guard.test.ts` ("delegates when classification throws").
3. **Evidence-gated auto-approval.** `allowed-once` requires a fresh guard-captured entry matching session and tool. Never judge a grant on the ask reason alone.
4. **Bounded input only.** Tool arguments enter the Jev state as head+tail previews; message digests are character-capped. Jev's own guidance: filter in code, send only what the question needs.
5. **Score keys are original projection indices** (`retention.ts`) — splice-shifted positions once dropped the critical message; the regression test locks this.
6. **Cache and queue discipline.** Score cache is per-turn (cleared each scoring pass, deleted on degrade); the semaphore must never leak slots on abort.
7. **No hardcoded tunables.** Anything a deployment might differ on is a `Config` field with a `DEFAULTS` entry and a `resolveSettings` mapping.

## Adding a new decision hook

Checklist (see `docs/jev-usage-points.md` for candidates and fit notes):

- [ ] The hook sits on a documented dsh extension point and stays **pure composition** (append/prepend listener) unless a takeover is justified — takeovers inherit everything and default to passthrough.
- [ ] Inputs are bounded; scores/answers are consumed only behind confidence gates.
- [ ] Every failure path degrades to stock behavior; shadow mode records without enforcing.
- [ ] A new `DecisionTag` in telemetry, with per-hook action vocabulary.
- [ ] Tests: behavior (what it does), the degradation paths, and at least one adversarial case.
- [ ] `Config` schema + `DEFAULTS` + `resolveSettings` + README/README.zh config notes.

## Style

- ESM everywhere; relative imports use the `.js` suffix.
- Match dsh conventions: registrations are effects; waterfall listeners always call `next()` or deliberately short-circuit; closed unions end in an `assertNever`-style fallback.
- Code comments and JSDoc in English; user-facing docs ship as English + Chinese pairs (one physical line per paragraph, one home per fact).
- Tests describe behavior, not correctness theater; change obsolete behavior together with its tests.
- Files end with exactly one trailing newline.

## Security

- Report vulnerabilities privately via [GitHub Security Advisories](https://github.com/AskTheWay/dsh-jev-interceptor/security/advisories) — do not open public issues.
- Remember the data plane: bounded previews and digests are sent to the configured provider (TypeSafe or OpenRouter). Never widen what leaves the machine without a config gate and a README note.
