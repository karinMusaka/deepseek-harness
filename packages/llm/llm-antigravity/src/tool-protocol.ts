/**
 * Tolerant parser for the prompt-level tool-calling protocol described by
 * {@link TOOL_CALL_PROTOCOL}: a `{"tool_calls":[...]}` JSON object, optionally
 * wrapped in a ` ```json ` fence, optionally surrounded by prose.
 * @module @deepseek-ai/dsh-llm-antigravity/tool-protocol
 */

/** One tool invocation the model requested through the prompt-level protocol. */
export interface ParsedToolCall {
  name: string
  arguments: Record<string, unknown>
}

/** A response the model produced under the tool-calling protocol. */
export interface ParsedToolCallResponse {
  /** Non-fenced text found outside the JSON payload, trimmed; empty when the whole response was the payload. */
  prose: string
  /** At least one validated tool call. */
  calls: readonly ParsedToolCall[]
}

const FENCE_PATTERN = /```json\s*\n?([\s\S]*?)\n?```/

/**
 * Validate one candidate call from a parsed `tool_calls` array.
 * @param candidate - one array element from the parsed JSON.
 * @returns the validated call, or `undefined` when its shape does not match the protocol.
 */
function validateCall(candidate: unknown): ParsedToolCall | undefined {
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const name = (candidate as Record<string, unknown>).name
  const args = (candidate as Record<string, unknown>).arguments
  if (typeof name !== 'string' || name.length === 0) return undefined
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  return { name, arguments: args as Record<string, unknown> }
}

/**
 * Parse agy's buffered response under the tool-calling protocol.
 * @param response - the complete agy `result.response` text.
 * @returns the parsed prose and calls, or `undefined` when the response is not
 *   a valid `{"tool_calls":[...]}` payload with at least one well-formed call
 *   (a caller falls back to treating the whole response as plain text).
 */
export function parseToolCallResponse(response: string): ParsedToolCallResponse | undefined {
  const trimmed = response.trim()
  if (trimmed.length === 0) return undefined
  const fenceMatch = FENCE_PATTERN.exec(trimmed)
  // FENCE_PATTERN's one capture group sits outside any alternation, so it
  // always participates when the pattern matches; `noUncheckedIndexedAccess`
  // still types group access as possibly `undefined`, hence the fallback.
  /* v8 ignore next -- unreachable: this capture group always participates in a match for this pattern. */
  const jsonText = fenceMatch !== null ? (fenceMatch[1] ?? '') : trimmed

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText.trim())
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const rawCalls = (parsed as Record<string, unknown>).tool_calls
  if (!Array.isArray(rawCalls) || rawCalls.length === 0) return undefined

  const calls: ParsedToolCall[] = []
  for (const candidate of rawCalls) {
    const call = validateCall(candidate)
    if (call === undefined) return undefined
    calls.push(call)
  }

  const prose = fenceMatch !== null
    ? (trimmed.slice(0, fenceMatch.index) + trimmed.slice(fenceMatch.index + fenceMatch[0].length)).trim()
    : ''

  return { prose, calls }
}
