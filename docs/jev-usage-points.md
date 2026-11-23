# Where Jev fits in DeepSeek Harness

English | [中文](jev-usage-points.zh.md)

This document inventories the discrete decision points in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) where a System-1 decision model like [Jev](https://typesafe.ai) (TypeSafe AI's non-generative "System One" model: text + typed questions in, calibrated typed decisions out, milliseconds, ~$0.042/MTok input) can replace or assist today's rules. It comes from a systematic scan of the dsh codebase (every hook referenced below was verified against the source with `file:line` evidence).

**Fit legend**: 🟢 high (small structured input, closed-set output, discrete decision) · 🟡 medium (viable with input bounding or partial involvement) · ⚪ low (pure computation, security boundary, or text generation — not a Jev job).

## How dsh exposes decisions

dsh is an everything-is-a-plugin Cordis harness: every decision point is an async event waterfall a third-party plugin can join with `ctx.on(...)` and delegate through `next()`. Two structural facts shape every integration:

- **Fail-closed is the house style.** The approval service rejects under the `never` policy before any listener runs (`user-approval/src/index.ts:268`); a throwing listener fails the question closed, not the tool call open. A Jev hook degrades via `next()`, never by widening a permission.
- **Asynchronous injection is allowed everywhere it matters.** `tools/pre-execute`, `approval/request`, `agent/request`, `agent/pre-step` are all async waterfalls with `AbortSignal`. The only synchronous decision points (`executionMode`, the tools `guard()` layer, projection folds) are out of bounds for network calls.

## Decision-point inventory

### This plugin (v0.1–v0.5) — approval loop + session retention + offload + stagnation

| # | Decision point | Today | Jev's role | Fit |
|---|---|---|---|---|
| 1 | **Tool-call risk gate** — `tools/pre-execute` (`core/tools/src/index.ts:146`, dispatch `:1482-1505`) | Waterfall default is plain `allow`; base ships no per-call classifier. The only precedent, `experimental/auto-review`, uses a *generative* LLM at temperature 0 with a hand-written JSON text protocol for a low/medium/high classification | One fan-out per call: risk `choice` + irreversible / matches-task / injection-suspect `noul`s. High-confidence + irreversible → deny; medium → ask; low → delegate | 🟢 |
| 2 | **Approval pre-answer** — `approval/request` (`user-approval/src/types.ts:85-89`) | Only human answerers (Web UI / ACP bridge); every `ask` costs a human round trip | First answerer: within-granted-scope + reversible `noul`s; auto-approves only allowlisted tools at high confidence, else defers to the human | 🟢 |
| 3 | **Session-snapshot retention** (v0.2) — `session-reference/src/projection.ts:93-128` | FIFO drop + longest-first truncation; zero semantics | Subclassed resolver scores each droppable message (*noise→critical*) in one fan-out; drops least-valuable first, truncates padding before substance; `disabled`/shadow modes stay byte-for-byte upstream | 🟢 |
| 8 | **Image-offload pre-planning** (v0.4) — `compaction-image-offload` (README admits "nothing plans an offload before dispatch") | FIFO offload after a failed request | Per-image residual-value `score` before the request, offloading only high-confidence sacrificial images | 🟢 |
| 10 | **Stagnation detection** (v0.5) — `tools/post-execute` | Exact-match repeat detection (`repeat-tool-reminder`); cross-parameter loops invisible | "no progress + same failure mode" dual `noul` over a bounded failure window; on high confidence a plugin-notice reminder tells the agent to change strategy (observe-and-enrich, never vetoes) | 🟡 |

Hooks 1 + 2 are one loop: base has no built-in `ask` source, so most approval traffic is the guard's own escalations.

### Roadmap — verified hooks this plugin does not claim yet

| # | Decision point | Today | Jev's role | Fit |
|---|---|---|---|---|
| 4 | **Content-aware model routing** — `agent/request` (`core/agent/src/runtime-types.ts:337`) | The two existing listeners are user/UI-explicit only; no content-driven routing exists | Complexity `score` + route `choice` over a whitelist of registered routes; needs hysteresis (route flips invalidate the KV-cache prefix) | 🟢 |
| 5 | **Subagent model default** — `tool-subagent/src/model-selection.ts:99` | A model-omitted delegation silently inherits the parent route | One `choice` at the child's first step from the delegation prompt | 🟢 |
| 6 | **Ralph worker-report verification** — `workflow/tool-ralph/src/index.ts:281-331` | The script's own comment: "Completion and blockers are worker reports, not independent evaluation" (`:408`); status is worker self-report | confirm / overturn-to-continue / overturn-to-blocked `choice` over the bounded report (16k-char cap) | 🟢 |
| 7 | **Goal round continuation** — `goal-round-driver/src/index.ts:164-192` | `roundsStarted < maxGoalRounds` unconditionally continues; no progress judgment | progress `score` + continue `noul` over objective + last round's output | 🟢 |
| 9 | **Spill preview tiering** — `spill/spill-policy/src/index.ts:197-220` | Fixed byte budget head+tail preview | Tier `choice` (tiny/short/standard/generous) by task value; must preserve the never-exceed-cap and never-isError invariants | 🟡 |
| 11 | **Search rerank** — `session-query-sqlite/src/index.ts:670-707` | FTS5 match_count ordering, no semantics | Query×snippet relevance `score`, page-local only (pagination determinism) | 🟡 |
| 12 | **Plan readiness pre-screen** — `plan-mode/src/index.ts:295-348` | Human approves or keeps planning | complete / needs-revision pre-check to cut review round trips (human stays sovereign) | 🟡 |
| 13 | **Sandbox escalation necessity** — `sandbox/src/escalation.ts:153-186` | Widen-mode table + one-line justification + human | "Is this escalation necessary and minimal?" `noul` as a pre-screen answerer | 🟡 |

### Deliberately not Jev territory

- **Hard security boundaries** — fs sandbox path fences, workspace cwd authorization, the sync `tools.guard()` layer, `never` approval policy: must stay deterministic and auditable; a probabilistic classifier only ever sits *in front* of them.
- **Pure computation** — compaction trigger thresholds (token counts), retry counters, shrink invariants, spill mtime cleanup, FTS surface classification: no semantic signal to add.
- **Text generation** — compaction summaries, session titles, corrective feedback: System-1 models do not generate text; Jev's docs warn chaining choices into text is both slow and poor.
- **Keystroke-rate hooks** — @file/@session completion ranking: shape fits, but per-keystroke cost/frequency argues for local inference (Laya) over a remote API.

## Constraints that shaped this plugin's design

From Jev's published limits (verified against docs.typesafe.ai, 2026-09):

- **64k tokens/request total, 32k for state+longest question** — every hook above bounds its input (head+tail argument previews, trailing-message digests); no hook ships raw unbounded data.
- **Provider rate limits near 8 concurrent requests** — the shared client caps in-flight calls (default 4) and opens a cooldown after consecutive failures.
- **Calibrated but not infallible** — confidence gates every action; low confidence delegates, never guesses. Jev's own guidance: put numeric judgments in code, not in the model.
- **English-first** — CJK accuracy is weaker; the thresholds are configuration, and the bilingual regression set is a roadmap item.
- **Prompt injection is acknowledged by the provider** — tool arguments go into the `state` data field only, `instructions` are fixed strings, and the injection-suspect answer escalates instead of suppressing.

## Alternatives and fallbacks

The client speaks the plain `state + questions` wire shape, which is identical across:

- **TypeSafe direct** uses `POST /v1/systemone` and `jev-1.14.0`, with `TYPESAFE_API_KEY` as the default credential reference. [TypeSafe models](https://docs.typesafe.ai/models)
- **OpenRouter** uses `POST /api/v1/systemone` and `typesafe/jev-1.14-20261014`, with `OPENROUTER_API_KEY` as the default credential reference. An explicitly configured legacy alpha endpoint still gets the legacy default model. [API reference](https://openrouter.ai/docs/api/api-reference/systemone/submit-a-system-one-request) · [Jev 1.14](https://openrouter.ai/typesafe/jev-1.14)
- **Local candidates** include Laya via llama.cpp. Verify the response schema, bilingual behavior, latency, and thresholds before adopting it for a task. [llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#post-v1systemone-typesafe-compatible-system-one-api) · [Laya model card](https://huggingface.co/convaiinnovations/laya-typed-decisions)

Set `provider`/`endpoint`/`model` accordingly; see the README for examples.

## November 2026 ecosystem and validation priorities

As of November 23, TypeSafe lists Jev 1.14, released October 14, as its latest release. TypeSafe expects the largest improvement in multilingual performance. Images, `box`, and longer context are candidates for independent prototypes. This plugin's development baseline is DSH 0.2.2-rc.3. Check new hooks on 0.2.2-rc.5 and 0.2.3-alpha.2 separately. [TypeSafe changelog](https://docs.typesafe.ai/changelog) · [Jev 1.14 announcement](https://typesafe.ai/blog/jev-1-14) · [DSH rc.5](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.5) · [DSH alpha.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.3-alpha.2)

| Project | Pattern to adopt |
|---|---|
| [Jevcore](https://github.com/PerryLink/jevcore) | Offline mock by default, documented data flow, and a shared decision core for DSH, MCP, and Node. The earlier [dsh-jev](https://github.com/buberlo/dsh-jev) points users to Jevcore. |
| [OpenCode Decision Models](https://github.com/third774/opencode-decision-models#tools) | Inspect available models and their capabilities, then run bounded batches over a fixed evaluation set. |
| [OpenCode/Cursor Jev Router](https://github.com/drmaas/jev-router) and [Claude Code Jev Router](https://github.com/gargpratyush/jev-router) | Use a small list of real candidates and allow the router to defer. Measure the overhead of asking every turn. |
| [Perplexity Decider v1.3](https://www.perplexity.ai/en-GB/hub/blog/perplexity-decider), [Clef](https://blog.cloudflare.com/clef-faster-cheaper-multimodal/), and [Laya](https://huggingface.co/convaiinnovations/laya-typed-decisions) | Use these models as comparators for bilingual classification, session reranking, and latency. Recheck thresholds on the actual task for each model. |

The panel, ping, decision client, and `/jev-status` share the effective connection. Changing it resets the old connection's cache and cooldown while keeping cumulative daily spend. The panel shows whether an edit was saved to the active DSH profile.

Calibration now replays decision and agreement records that match the model ID reported by the provider. The official pinned versions can show their existing samples before a connection test. Unversioned or rolling-alias records remain visible in the log. Use the panel or `/jev-calibrate --model <id>` to replay historical versions. Applying panel advice checks that the model and the original threshold still match the report.

1. **Add bilingual holdout evaluation.** Attach question version, tool type, and language to the model-scoped replay. Split tuning and holdout by session or time. Measure false blocks, unnecessary asks, coverage, degradation, end-to-end p50/p95, and cost. Use paired Chinese and English tasks to compare short rules with rules that include positive and negative examples. Explicit examples lowered interruption rates on a synthetic policy dataset, which motivates a separate test on this plugin's own traffic. [Policy gate study](https://arxiv.org/abs/2611.02155) · [Paired evaluation](https://arxiv.org/abs/2610.02267)
2. **Prototype read-only semantic improvements.** Start with reranking within a retrieval page or pointing out missing evidence in a Ralph report. Compare relevance, time to find evidence, and added latency, preserving the original result when evidence is weak.
3. **Log model recommendations in shadow first.** Compare a fixed route, a simple rule, and Jev on first-turn choices. Track task outcomes, total billed cost, latency, and cache hits. The paired evaluation found chance-level zero-shot routing, and MultiTurnRoute treats prefix reuse as part of routing cost. [Paired evaluation](https://arxiv.org/abs/2610.02267) · [MultiTurnRoute](https://arxiv.org/abs/2611.10848)
