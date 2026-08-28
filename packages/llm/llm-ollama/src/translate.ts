/**
 * Translate Ollama NDJSON lines into the harness `StreamChunk` protocol.
 *
 * The route streams one visible-text channel, so at most one harness block is
 * ever open, at index 0. Termination is a JSON field rather than a sentinel
 * line: `block-end`, `usage`, and `finish` are all deferred to the `done: true`
 * line, which is also the only line carrying the token counts, so `usage`
 * always precedes `finish` and nothing follows `finish`.
 *
 * @module dsh-llm-ollama/translate
 */

import { EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { WireChatChunk } from './types.ts'

/** The single text block this route can open. */
const TEXT_INDEX = 0

/**
 * Map the wire `done_reason` vocabulary to the harness FinishReason.
 * @param reason - the terminal line's `done_reason`, or `undefined` when it carried none.
 * @returns `stop` for a finished generation or an absent reason, `max-tokens` for the
 *   `num_predict` cap, and `{kind: 'error'}` with the uppercased value as `code` for anything else.
 */
export function mapDoneReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case undefined:
    case 'stop': return { kind: 'stop' }
    case 'length': return { kind: 'max-tokens' }
    default:
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
      }
  }
}

/**
 * Map the terminal line's token counts. Ollama reports no cache split, so
 * `prompt_eval_count` is already the disjoint uncached input count the harness
 * `TokenUsage` convention wants.
 * @param chunk - the parsed `done: true` line.
 * @returns disjoint harness counts, or `undefined` when the line reported neither count.
 */
export function mapUsage(chunk: WireChatChunk): TokenUsage | undefined {
  if (chunk.prompt_eval_count === undefined && chunk.eval_count === undefined) return undefined
  return {
    inputTokens: chunk.prompt_eval_count ?? 0,
    outputTokens: chunk.eval_count ?? 0,
  }
}

/**
 * Consume NDJSON lines and yield StreamChunks.
 * @param lines - complete JSON lines from {@link parseNdjson}, in arrival order.
 * @returns text deltas as they arrive, then the deferred `block-end`, `usage`, and `finish`
 *   from the `done: true` line. A `stop` (or absent) reason that opened no block is a degenerate
 *   provider completion and maps to an `EMPTY_RESPONSE` error finish instead of an empty message.
 * @throws `LlmError` `MALFORMED_RESPONSE` for a line that is not JSON, `SERVER` for a line
 *   carrying a generation failure, and `STREAM_CLOSED` when the lines end without `done: true`.
 */
export async function* translate(lines: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let text: string | undefined

  for await (const line of lines) {
    let chunk: WireChatChunk
    try {
      chunk = JSON.parse(line) as WireChatChunk
    } catch {
      throw new LlmError(`malformed NDJSON line: ${line.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }

    // Generation can fail after the response headers were already sent, in
    // which case the failure arrives as an in-band line instead of an HTTP
    // status; it stays server-side and therefore retryable.
    if (chunk.error !== undefined) {
      throw new LlmError(`Ollama reported a generation failure: ${chunk.error}`, 'SERVER')
    }

    const content = chunk.message?.content
    if (content !== undefined && content.length > 0) {
      if (text === undefined) {
        text = ''
        yield { type: 'block-start', index: TEXT_INDEX, blockType: 'text' }
      }
      text += content
      yield { type: 'text-delta', index: TEXT_INDEX, text: content }
    }

    if (chunk.done === true) {
      if (text !== undefined) {
        yield { type: 'block-end', index: TEXT_INDEX, block: { type: 'text', text } }
      }
      const usage = mapUsage(chunk)
      if (usage !== undefined) yield { type: 'usage', usage }
      const reason = mapDoneReason(chunk.done_reason)
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && text === undefined
          ? {
            kind: 'error',
            failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
          }
          : reason,
      }
      return
    }
  }

  throw new LlmError('Ollama NDJSON stream ended without a done line', 'STREAM_CLOSED')
}
