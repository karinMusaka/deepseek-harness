/**
 * Serialize harness messages into an Ollama `/api/chat` request. Each harness
 * message becomes one wire message with the same role, its text blocks joined
 * into the single `content` string and its image blocks read into the parallel
 * `images` array. Tool schemas and tool blocks are refused rather than
 * flattened, because this route has no tool vocabulary at all and a silently
 * dropped tool call or result would change what the model is answering.
 * Assistant reasoning blocks are dropped: the route has no passback field for
 * them, and they are not model input.
 *
 * @module dsh-llm-ollama/serialize
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { WireMessage, WireOptions, WireRequest } from './types.ts'

/** Join the text blocks of one message's content. */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * Refuse the request vocabulary this route cannot represent. Tool blocks are
 * checked at the top level of each message only: a nested `tool-call` can
 * only sit inside a `tool-result`, which is itself refused here.
 * @param options - the harness request.
 * @throws `LlmError` `UNSUPPORTED_OPTION` for declared tool schemas and
 *   `UNSUPPORTED_CONTENT` for a `tool-call` or `tool-result` block in history.
 */
function assertSupported(options: GenerateOptions): void {
  if (options.tools !== undefined && options.tools.length > 0) {
    throw new LlmError('The Ollama chat adapter does not support tool calling.', 'UNSUPPORTED_OPTION')
  }
  for (const message of options.messages) {
    for (const block of message.content) {
      if (block.type === 'tool-call' || block.type === 'tool-result') {
        throw new LlmError(
          `The Ollama chat adapter cannot represent a ${block.type} block in conversation history.`,
          'UNSUPPORTED_CONTENT',
        )
      }
    }
  }
}

/** Read every image block of one message into base64, in block order. */
async function imagesOf(
  blocks: readonly ContentBlock[],
  attachments: AttachmentStore | undefined,
): Promise<string[]> {
  const images: string[] = []
  for (const block of blocks) {
    if (block.type !== 'image') continue
    if (attachments === undefined) {
      throw new LlmError('Ollama image input requires the durable attachment service.', 'UNSUPPORTED_CONTENT')
    }
    const stored = await attachments.readImage(block.attachment)
    images.push(Buffer.from(stored.data).toString('base64'))
  }
  return images
}

/**
 * Serialize one harness message. The harness and wire role vocabularies are
 * identical on this route, so the role passes through unchanged.
 * @param message - one harness conversation message.
 * @param attachments - durable byte resolver, required only when the message carries an image.
 * @returns the wire message; `images` is omitted when the message carries none.
 */
async function serializeMessage(
  message: Message,
  attachments: AttachmentStore | undefined,
): Promise<WireMessage> {
  const images = await imagesOf(message.content, attachments)
  return {
    role: message.role,
    content: flattenText(message.content),
    ...images.length === 0 ? {} : { images },
  }
}

/**
 * Serialize the conversation, resolving durable image bytes.
 * @param messages - the harness conversation, in order.
 * @param attachments - durable byte resolver, required only when a message carries an image.
 * @returns one wire message per harness message, order preserved.
 */
export async function serializeMessages(
  messages: readonly Message[],
  attachments?: AttachmentStore,
): Promise<WireMessage[]> {
  const wire: WireMessage[] = []
  for (const message of messages) wire.push(await serializeMessage(message, attachments))
  return wire
}

/**
 * Build the full wire request. Always streaming; every generation knob is
 * omitted unless the request carries it, so the server's own defaults apply.
 * @param options - the harness request (model, history, system, sampling).
 * @param attachments - durable byte resolver, required only when a message carries an image.
 * @returns the `/api/chat` request body; `options` is omitted when the request sets no knob.
 * @throws `LlmError` `UNSUPPORTED_OPTION` for declared tool schemas, and
 *   `UNSUPPORTED_CONTENT` for a tool block in history or an image without the attachment service.
 */
export async function serializeRequest(
  options: GenerateOptions,
  attachments?: AttachmentStore,
): Promise<WireRequest> {
  assertSupported(options)
  const messages: WireMessage[] = []
  if (options.system !== undefined) messages.push({ role: 'system', content: options.system })
  messages.push(...await serializeMessages(options.messages, attachments))

  const generation: WireOptions = {
    ...options.maxTokens === undefined ? {} : { num_predict: options.maxTokens },
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...options.stop === undefined ? {} : { stop: options.stop },
  }
  return {
    model: options.model,
    messages,
    stream: true,
    ...Object.keys(generation).length === 0 ? {} : { options: generation },
  }
}
