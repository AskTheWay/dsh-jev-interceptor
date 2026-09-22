# Where Jev fits in DeepSeek Harness

English | [中文](jev-usage-points.zh.md)

This document inventories the discrete decision points in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) where a System-1 decision model like [Jev](https://typesafe.ai) (TypeSafe AI's non-generative "System One" model: text + typed questions in, calibrated typed decisions out, milliseconds, ~$0.042/MTok input) can replace or assist today's rules. It comes from a systematic scan of the dsh codebase (every hook referenced below was verified against the source with `file:line` evidence).

**Fit legend**: 🟢 high (small structured input, closed-set output, discrete decision) · 🟡 medium (viable with input bounding or partial involvement) · ⚪ low (pure computation, security boundary, or text generation — not a Jev job).

## How dsh exposes decisions

dsh is an everything-is-a-plugin Cordis harness: every decision point is an async event waterfall a third-party plugin can join with `ctx.on(...)` and delegate through `next()`. Two structural facts shape every integration:

- **Fail-closed is the house style.** The approval service rejects under the `never` policy before any listener runs (`user-approval/src/index.ts:268`); a throwing listener fails the question closed, not the tool call open. A Jev hook degrades via `next()`, never by widening a permission.
- **Asynchronous injection is allowed everywhere it matters.** `tools/pre-execute`, `approval/request`, `agent/request`, `agent/pre-step` are all async waterfalls with `AbortSignal`. The only synchronous decision points (`executionMode`, the tools `guard()` layer, projection folds) are out of bounds for network calls.

## Decision-point inventory

### This plugin (v0.1) — the approval loop

| # | Decision point | Today | Jev's role | Fit |
|---|---|---|---|---|
| 1 | **Tool-call risk gate** — `tools/pre-execute` (`core/tools/src/index.ts:146`, dispatch `:1482-1505`) | Waterfall default is plain `allow`; base ships no per-call classifier. The only precedent, `experimental/auto-review`, uses a *generative* LLM at temperature 0 with a hand-written JSON text protocol for a low/medium/high classification | One fan-out per call: risk `choice` + irreversible / matches-task / injection-suspect `noul`s. High-confidence + irreversible → deny; medium → ask; low → delegate | 🟢 |
| 2 | **Approval pre-answer** — `approval/request` (`user-approval/src/types.ts:85-89`) | Only human answerers (Web UI / ACP bridge); every `ask` costs a human round trip | First answerer: within-granted-scope + reversible `noul`s; auto-approves only allowlisted tools at high confidence, else defers to the human | 🟢 |

Hooks 1 + 2 are one loop: base has no built-in `ask` source, so most approval traffic is the guard's own escalations.

### Roadmap — verified hooks this plugin does not claim yet

| # | Decision point | Today | Jev's role | Fit |
|---|---|---|---|---|
| 3 | **Content-aware model routing** — `agent/request` (`core/agent/src/runtime-types.ts:337`) | The two existing listeners are user/UI-explicit only; no content-driven routing exists | Complexity `score` + route `choice` over a whitelist of registered routes; needs hysteresis (route flips invalidate the KV-cache prefix) | 🟢 |
| 4 | **Subagent model default** — `tool-subagent/src/model-selection.ts:99` | A model-omitted delegation silently inherits the parent route | One `choice` at the child's first step from the delegation prompt | 🟢 |
| 5 | **Ralph worker-report verification** — `workflow/tool-ralph/src/index.ts:281-331` | The script's own comment: "Completion and blockers are worker reports, not independent evaluation" (`:408`); status is worker self-report | confirm / overturn-to-continue / overturn-to-blocked `choice` over the bounded report (16k-char cap) | 🟢 |
| 6 | **Goal round continuation** — `goal-round-driver/src/index.ts:164-192` | `roundsStarted < maxGoalRounds` unconditionally continues; no progress judgment | progress `score` + continue `noul` over objective + last round's output | 🟢 |
| 7 | **Image-offload pre-planning** — `compaction-image-offload` (README admits "nothing plans an offload before dispatch") | FIFO offload after a failed request | Per-image residual-value `score` before the request, offloading only high-confidence sacrificial images | 🟢 |
| 8 | **Session-reference keep/drop** — `context/session-reference/src/projection.ts:93-128` | FIFO drop + longest-first truncation; zero semantics | Per-message value `score` for drop order and truncation target (one-shot pre-step call, latency-tolerant) | 🟢 |
| 9 | **Spill preview tiering** — `spill/spill-policy/src/index.ts:197-220` | Fixed byte budget head+tail preview | Tier `choice` (tiny/short/standard/generous) by task value; must preserve the never-exceed-cap and never-isError invariants | 🟡 |
| 10 | **Stagnation detection** — `tools/post-execute` (`repeat-tool-reminder` covers exact repeats only) | Exact-match repeat detection; cross-parameter loops invisible | "no progress across differing attempts" `noul` over a bounded failure window | 🟡 |
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

- **TypeSafe direct** — `POST https://api.typesafe.ai/v1/systemone`, model `jev-latest` (or a pinned `jev-1.13.x`).
- **OpenRouter** — `POST https://openrouter.ai/api/alpha/decisions`, model `~typesafe/jev-latest` (alpha endpoint; not listed in the public model catalog; chat/completions refuses decisions models).
- **Laya** (Apache-2.0, local) — same question/answer shape, ~33ms on a T4; weaker zero-shot and shorter context, needs domain fine-tuning. A natural future provider behind the same interface.

Set `provider`/`endpoint`/`model` accordingly; see the README for examples.
