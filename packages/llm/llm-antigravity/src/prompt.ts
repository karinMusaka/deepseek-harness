/**
 * Prompt assembly: the fixed preamble that keeps agy from acting as its own
 * agent, the transcript rendered by role, and the prompt-level tool-calling
 * protocol appended when the request carries tool schemas.
 * @module @deepseek-ai/dsh-llm-antigravity/prompt
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'

/**
 * Fixed preamble sent ahead of every request. Quoted verbatim in the package
 * README's Model Experience section; keep both copies identical.
 */
export const COMPLETION_BACKEND_PREAMBLE = 'You are serving as a text completion backend for another agent runtime (DeepSeek Harness), not as an autonomous coding agent. Never invoke your own built-in tools (run_command, view_file, write_to_file, or any other native action) to answer this request. Read the system instructions and conversation below and reply with exactly the text — or, when a tool-calling protocol is described below, the JSON — that the runtime asks for.'

/**
 * Fixed instructions appended after the tool schema list. Data-independent by
 * design (the schemas themselves are appended separately) so this text stays
 * quotable verbatim in the README.
 */
export const TOOL_CALL_PROTOCOL = 'To call one or more of the tools listed above, reply with ONLY a single JSON object of the exact form {"tool_calls":[{"name":"<tool name>","arguments":{<arguments object>}}]}. A ```json fenced code block wrapping that exact object is also accepted. Emit nothing else: no prose before or after it, and no additional keys. Do not invoke your own built-in tools under any circumstance. If none of the listed tools are needed to answer, reply with plain text instead — do not emit tool_calls JSON in that case.'

/** Built prompt text plus whether the tool-calling protocol was appended. */
export interface BuiltPrompt {
  text: string
  toolsRequested: boolean
}

/**
 * Render one role label for a transcript entry from its message source.
 * @param message - one harness message from {@link GenerateOptions.messages}.
 * @returns a short uppercase label; a merge-extended source falls back to the message's provider-neutral role.
 */
function renderRole(message: Message): string {
  switch (message.source.kind) {
    case 'user': return 'USER'
    case 'model': return 'ASSISTANT'
    case 'tool': return `TOOL RESULT (${message.source.callId})`
    case 'plugin': return 'CONTEXT'
    default: return message.role.toUpperCase()
  }
}

/**
 * Render one content block as agy-visible text.
 * @param block - one block from a message's content array.
 * @returns the block's textual rendering.
 * @throws {LlmError} `UNSUPPORTED_CONTENT` for an image or any other
 *   non-text block agy (a text-only model route) cannot represent.
 */
function renderBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text': return block.text
    case 'reasoning': return `[reasoning] ${block.text}`
    case 'tool-call': return `[tool-call ${block.id} ${block.name}] ${block.arguments}`
    case 'tool-result': {
      const rendered = block.content.map(renderBlock).join('\n')
      return `[tool-result ${block.toolCallId}${block.isError === true ? ' error' : ''}] ${rendered}`
    }
    default:
      throw new LlmError(
        `Antigravity adapter cannot render "${block.type}" content as text (agy is a text-only route)`,
        'UNSUPPORTED_CONTENT',
      )
  }
}

/**
 * Render the full message history as one text block per message.
 * @param messages - the request's ordered conversation messages.
 * @returns the rendered transcript, one blank-line-separated section per message.
 */
function renderTranscript(messages: readonly Message[]): string {
  return messages
    .map(message => `[${renderRole(message)}]\n${message.content.map(renderBlock).join('\n')}`)
    .join('\n\n')
}

/**
 * Build the complete prompt text sent to agy on stdin: the fixed preamble,
 * the system text, the tool schemas and calling protocol when requested, and
 * the rendered transcript.
 * @param options - the full model request.
 * @returns the prompt text and whether the tool-calling protocol was appended.
 * @throws {LlmError} `UNSUPPORTED_CONTENT` when any message carries an image or other non-text block.
 */
export function buildPrompt(options: GenerateOptions): BuiltPrompt {
  const sections: string[] = [COMPLETION_BACKEND_PREAMBLE]
  if (options.system !== undefined && options.system.length > 0) {
    sections.push(`[System]\n${options.system}`)
  }
  const tools: readonly ToolSchema[] = options.tools ?? []
  const toolsRequested = tools.length > 0
  if (toolsRequested) {
    sections.push(`[Available Tools]\n${JSON.stringify(tools, null, 2)}`)
    sections.push(TOOL_CALL_PROTOCOL)
  }
  sections.push(renderTranscript(options.messages))
  return { text: sections.join('\n\n'), toolsRequested }
}
