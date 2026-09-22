/**
 * Wire types for the Jev (TypeSafe AI "System One") decisions API and typed
 * question builders. The request shape is `state + questions`; every question
 * is answered independently in one round trip ("speculative fan-out"), so a
 * guard adds questions at near-zero latency cost.
 *
 * The same payload shape is accepted by the TypeSafe endpoint
 * (`POST /v1/systemone`) and by OpenRouter's decisions endpoint
 * (`POST /api/alpha/decisions`, model `~typesafe/jev-latest`).
 * @module dsh-jev-interceptor/types
 */

/** A yes/no question answered with one calibrated probability in `[0, 1]`. */
export interface NoulQuestion {
  readonly type: 'noul'
  readonly instructions: string
  /** Optional per-side judging criteria; keys are `true` / `false`. */
  readonly criteria?: { readonly true?: string; readonly false?: string }
}

/** A single-choice question; at most 255 options, reliable within ~240. */
export interface ChoiceQuestion {
  readonly type: 'choice'
  readonly instructions: string
  /** Option id to judging criteria; `null` marks an option with no notes. */
  readonly criteria: Readonly<Record<string, string | null>>
}

/** An ordered-scale question over 2-10 graded levels. */
export interface ScoreQuestion {
  readonly type: 'score'
  readonly instructions: string
  /** Ordered level labels, coarsest first. */
  readonly criteria: readonly string[]
}

/** The three typed question primitives Jevaluates. */
export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion

/** Answer to a {@link NoulQuestion}: one probability. */
export interface NoulAnswer {
  readonly type: 'noul'
  readonly noul: number
}

/** Answer to a {@link ChoiceQuestion}: pick plus the full calibrated distribution. */
export interface ChoiceAnswer {
  readonly type: 'choice'
  readonly choice: string
  readonly probabilities: Readonly<Record<string, number>>
  readonly confidence: number
}

/** Answer to a {@link ScoreQuestion}: distribution-weighted level (may fall between levels). */
export interface ScoreAnswer {
  readonly type: 'score'
  readonly score: number
  readonly confidence: number
  /** Present when the provider returns the full level distribution. */
  readonly probabilities?: Readonly<Record<string, number>>
}

/** Answers keyed by their question id. */
export type JevAnswers = Readonly<Record<string, NoulAnswer | ChoiceAnswer | ScoreAnswer>>

/** Token accounting returned with every decision. */
export interface JevUsage {
  readonly input_tokens?: number
  readonly output_tokens?: number
  /** Present on OpenRouter responses; absent on TypeSafe direct. */
  readonly cost?: number
}

/**
 * Build a yes/no question.
 * @param instructions - what to judge, addressed to the data in `state`.
 * @param criteria - optional per-side judging notes.
 * @returns the typed question object.
 */
export function noul(instructions: string, criteria?: NoulQuestion['criteria']): NoulQuestion {
  return { type: 'noul', instructions, ...(criteria === undefined ? {} : { criteria }) }
}

/**
 * Build a single-choice question.
 * @param instructions - what to judge, addressed to the data in `state`.
 * @param criteria - option id to judging notes (`null` for bare options).
 * @returns the typed question object.
 */
export function choice(
  instructions: string,
  criteria: Readonly<Record<string, string | null>>,
): ChoiceQuestion {
  return { type: 'choice', instructions, criteria }
}

/**
 * Build an ordered-scale question.
 * @param instructions - what to judge, addressed to the data in `state`.
 * @param criteria - ordered level labels, coarsest first.
 * @returns the typed question object.
 */
export function score(instructions: string, criteria: readonly string[]): ScoreQuestion {
  return { type: 'score', instructions, criteria }
}

/** Whether an untrusted parsed value is a finite probability in `[0, 1]`. */
function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

/** Whether an untrusted parsed value is a non-empty record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate an untrusted decision response body into {@link JevAnswers}.
 * @param body - the parsed JSON response.
 * @returns the validated answers record.
 * @throws when the body is not an answers object with well-formed members.
 */
export function parseAnswers(body: unknown): JevAnswers {
  if (!isRecord(body)) throw new Error('jev: response body is not an object')
  const answers: Record<string, NoulAnswer | ChoiceAnswer | ScoreAnswer> = {}
  for (const [id, raw] of Object.entries(body)) {
    if (!isRecord(raw)) throw new Error(`jev: answer "${id}" is not an object`)
    if (raw['type'] === 'noul') {
      if (!isProbability(raw['noul'])) throw new Error(`jev: noul answer "${id}" lacks a probability`)
      answers[id] = { type: 'noul', noul: raw['noul'] }
      continue
    }
    if (raw['type'] === 'choice') {
      if (typeof raw['choice'] !== 'string') throw new Error(`jev: choice answer "${id}" lacks a selection`)
      if (!isProbability(raw['confidence'])) throw new Error(`jev: choice answer "${id}" lacks confidence`)
      if (!isRecord(raw['probabilities'])) throw new Error(`jev: choice answer "${id}" lacks probabilities`)
      for (const member of Object.values(raw['probabilities'])) {
        // A non-numeric member would detonate later formatting; reject at the parse boundary.
        if (!isProbability(member)) throw new Error(`jev: choice answer "${id}" has a non-numeric probability`)
      }
      answers[id] = {
        type: 'choice',
        choice: raw['choice'],
        probabilities: raw['probabilities'] as Record<string, number>,
        confidence: raw['confidence'],
      }
      continue
    }
    if (raw['type'] === 'score') {
      if (!isProbability(raw['confidence'])) throw new Error(`jev: score answer "${id}" lacks confidence`)
      if (typeof raw['score'] !== 'number' || !Number.isFinite(raw['score'])) {
        throw new Error(`jev: score answer "${id}" lacks a score`)
      }
      let probabilities: Record<string, number> | undefined
      if (isRecord(raw['probabilities'])) {
        for (const member of Object.values(raw['probabilities'])) {
          if (!isProbability(member)) throw new Error(`jev: score answer "${id}" has a non-numeric probability`)
        }
        probabilities = raw['probabilities'] as Record<string, number>
      }
      answers[id] = {
        type: 'score',
        score: raw['score'],
        confidence: raw['confidence'],
        ...(probabilities === undefined ? {} : { probabilities }),
      }
      continue
    }
    throw new Error(`jev: answer "${id}" has an unknown type`)
  }
  return answers
}
