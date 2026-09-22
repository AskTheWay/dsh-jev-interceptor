/**
 * Bounded-text helpers that build Jev `state` inputs from unbounded session
 * data. Tool arguments and message history have no size ceiling in dsh, while
 * Jev charges per input token and degrades on irrelevant bulk ("context rot"),
 * so every field that reaches the wire passes through an explicit bound.
 * @module dsh-jev-interceptor/text
 */

/** Marker inserted where bounded preview text skips its middle. */
export const OMISSION_MARKER = '…[truncated]…'

/**
 * Render a head+tail preview of one long string, keeping the beginning and end
 * and marking the skipped middle. Short inputs pass through unchanged.
 * @param text - the source text of any length.
 * @param headChars - characters kept from the beginning.
 * @param tailChars - characters kept from the end.
 * @returns the bounded preview, or the original when it already fits.
 */
export function headTailPreview(text: string, headChars: number, tailChars: number): string {
  if (text.length <= headChars + tailChars) return text
  const skipped = text.length - headChars - tailChars
  return `${text.slice(0, headChars)}${OMISSION_MARKER}[${skipped} chars]${OMISSION_MARKER}${text.slice(text.length - tailChars)}`
}

/**
 * Lossless-JSON canonical form of parsed tool arguments, or the raw string
 * when the value does not round-trip.
 * @param args - the frozen parsed arguments of one tool call (or raw JSON text).
 * @returns canonical `JSON.stringify` output for stable previews and cache keys.
 */
export function canonicalArguments(args: unknown): string {
  if (typeof args === 'string') return args
  return JSON.stringify(args) ?? 'null'
}

/**
 * One bounded recent-message digest entry.
 */
export interface RecentMessageDigest {
  readonly role: string
  readonly text: string
  readonly hasToolResult: boolean
}

/** A minimal structural view of one derived message, for history digestion. */
export interface DigestibleMessage {
  readonly role: string
  readonly content: readonly { readonly type: string; readonly text?: string }[]
}

/**
 * Digest the trailing conversation into bounded entries for the Jev state.
 * @param messages - the full derived history (newest last).
 * @param count - how many trailing messages to keep.
 * @param maxCharsPerMessage - text bound applied to each message.
 * @returns the bounded digests, oldest kept first.
 */
export function digestRecent(
  messages: readonly DigestibleMessage[],
  count: number,
  maxCharsPerMessage: number,
): RecentMessageDigest[] {
  const kept = messages.slice(-count)
  return kept.map((message) => {
    const texts: string[] = []
    let hasToolResult = false
    for (const block of message.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text)
      } else {
        if (block.type === 'tool-result' || block.type === 'tool-call') hasToolResult = true
        texts.push(`[${block.type}]`)
      }
    }
    return {
      role: message.role,
      // Hard character bound; a digest entry must never exceed its budget.
      text: texts.join('\n').slice(0, maxCharsPerMessage),
      hasToolResult,
    }
  })
}
