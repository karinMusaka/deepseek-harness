/**
 * Ollama `/api/chat` wire format. Types only.
 *
 * Source of truth: a live `ollama serve` 0.33.1 measured over `curl`
 * (2026-08-27). The route streams raw NDJSON — one complete JSON object per
 * `\n`-terminated line, with no `data:` prefix and no out-of-band terminator —
 * and marks its last line with `"done": true` rather than a sentinel string.
 *
 * @module dsh-llm-ollama/types
 */

/** Request body for `POST {baseURL}/api/chat`. */
export interface WireRequest {
  model: string
  messages: WireMessage[]
  stream: true
  /** Generation knobs; omitted entirely when the request configures none. */
  options?: WireOptions
}

/**
 * Per-request generation knobs. Ollama nests every sampling and budget field
 * here rather than at the top level, and ignores unknown members instead of
 * rejecting them, so only measured fields are sent.
 */
export interface WireOptions {
  /** Output-token cap; the harness `maxTokens`. Reaching it ends the stream with `done_reason: "length"`. */
  num_predict?: number
  temperature?: number
  /** Stop sequences; generation halts as soon as the model produces any one of them. */
  stop?: string[]
}

/**
 * One entry of the request `messages` array. Ollama accepts a single content
 * string per message plus a parallel `images` array; it has no tool-role
 * message and no separate reasoning-passback field on this route.
 */
export interface WireMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  /** Base64-encoded image bytes, without a `data:` URI prefix. */
  images?: string[]
}

/**
 * One parsed NDJSON line of a streaming chat response.
 *
 * Every line before the last carries `done: false` and a `message` delta. The
 * terminal line carries `done: true`, `done_reason`, and the token counts;
 * its `message.content` is the empty string. A line may instead carry `error`
 * when generation fails after the response headers were already sent.
 */
export interface WireChatChunk {
  message?: { role?: string; content?: string }
  done?: boolean
  /** Measured vocabulary: `stop` (model finished or hit a stop sequence) and `length` (hit `num_predict`). */
  done_reason?: string
  /** Input tokens evaluated for this request; Ollama reports no cache split. */
  prompt_eval_count?: number
  /** Generated tokens. */
  eval_count?: number
  /** Mid-stream generation failure; present only on a failing line. */
  error?: string
}

/**
 * Non-2xx error body: one plain-string `error` member, not an object. A model
 * the server has not pulled answers 404, a rejected request (unsupported
 * `tools`, undecodable image bytes) answers 400.
 */
export interface WireErrorBody {
  error?: string
}
