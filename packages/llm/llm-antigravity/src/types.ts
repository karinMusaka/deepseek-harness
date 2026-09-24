/**
 * Wire types for the Antigravity CLI (`agy`) `--input-format stream-json
 * --output-format stream-json` protocol, plus the adapter's own model-catalog
 * shape. No runtime code lives here.
 * @module @deepseek-ai/dsh-llm-antigravity/types
 */

/** One model entry an operator declares in `Config.models`. */
export interface AntigravityCatalogModel {
  /** Model id accepted by `agy --model` (for example `gemini-3.8-flash-high`). */
  id: string
  /** Human-readable display name; defaults to {@link id}. */
  name?: string
  /** Optional selector detail distinguishing similar entries. */
  description?: string
  /** Known combined request/response context capacity, when disclosed. */
  contextWindow?: number
  /** Known per-request output cap, when disclosed. */
  maxTokens?: number
}

/** One line agy's `stream-json` stdin protocol accepts: the whole turn as a single user message. */
export interface AgyStreamInputMessage {
  event: 'user'
  message: {
    content: Array<{
      type: 'text'
      text: string
    }>
  }
}

/** Fields shared by every NDJSON line agy writes to stdout. */
export interface AgyOutputEventBase {
  event: string
  conversation_id?: string
}

/** `init` line emitted once at session start. */
export interface AgyInitEvent extends AgyOutputEventBase {
  event: 'init'
  init: {
    model: string
    cwd: string
    tools: string[]
    permission_mode?: string
  }
}

/** Token usage breakdown reported by agy. */
export interface AgyTokenUsage {
  input_tokens: number
  output_tokens: number
  thinking_tokens?: number
  cache_read_tokens?: number
  total_tokens: number
}

/** `step_update` line emitted while agy executes one turn. */
export interface AgyStepUpdateEvent extends AgyOutputEventBase {
  event: 'step_update'
  step_update: {
    conversation_id: string
    step_index: number
    state: 'ACTIVE' | 'DONE' | 'ERROR'
    step_type: string
    text_delta?: string
    duration_seconds?: number
    usage?: AgyTokenUsage
    tool_name?: string
    tool_info?: unknown
  }
}

/** One agy built-in action headless mode auto-denied. */
export interface AgyDeniedAction {
  action: string
  display_name: string
}

/** `result` line emitted once at the end of a turn. */
export interface AgyResultEvent extends AgyOutputEventBase {
  event: 'result'
  result: {
    conversation_id: string
    status: 'SUCCESS' | 'ERROR'
    response?: string
    error?: string
    duration_seconds?: number
    num_turns?: number
    usage?: AgyTokenUsage
    denied_actions?: AgyDeniedAction[]
  }
}

/**
 * Any NDJSON line agy's stdout may carry. `AgyOutputEventBase` is the
 * fallback arm for an `event` value this adapter does not recognize
 * (agy's own union is not closed from this side of the process boundary).
 */
export type AgyOutputEvent = AgyInitEvent | AgyStepUpdateEvent | AgyResultEvent | AgyOutputEventBase

/** One model entry reported by `agy models` (id and display name only; no capacities). */
export interface AgyDiscoveredModel {
  id: string
  name: string
}
