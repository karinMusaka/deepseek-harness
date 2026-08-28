import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { CallId, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { serializeRequest } from '../src/serialize.ts'

const ref = (byte: number): ImageAttachmentRef => ({
  attachmentId: AttachmentId(`sha256:${String(byte).repeat(64)}`),
  mediaType: 'image/png',
  bytes: 1,
  width: 1,
  height: 1,
})

const attachments = {
  readImage: vi.fn((value: ImageAttachmentRef) =>
    Promise.resolve({ ref: value, data: Uint8Array.of(value.attachmentId.endsWith('1') ? 1 : 2) })),
} as unknown as AttachmentStore

function user(content: ContentBlock[]): Message {
  return createUserMessage({ content, source: { kind: 'plugin', plugin: 'test' } })
}

function history(role: 'system' | 'assistant', content: ContentBlock[]): Message {
  return createMessage({ role, content, source: { kind: 'plugin', plugin: 'test' } })
}

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'ollama', model: 'moondream:latest', messages: [], ...overrides }
}

describe('serializeRequest', () => {
  it('prepends the system slot and preserves each role with its joined text', async () => {
    await expect(serializeRequest(request({
      system: 'be terse',
      messages: [
        user([{ type: 'text', text: 'hel' }, { type: 'text', text: 'lo' }]),
        history('assistant', [{ type: 'text', text: 'hi' }]),
        history('system', [{ type: 'text', text: 'mid-history note' }]),
      ],
    }))).resolves.toEqual({
      model: 'moondream:latest',
      stream: true,
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'system', content: 'mid-history note' },
      ],
    })
  })

  it('omits the generation options entirely when the request sets no knob', async () => {
    const body = await serializeRequest(request())
    expect(body).not.toHaveProperty('options')
    expect(body.messages).toEqual([])
  })

  it('maps the output cap, temperature, and stop sequences into the nested options', async () => {
    await expect(serializeRequest(request({
      maxTokens: 64,
      temperature: 0,
      stop: ['\n\n'],
    }))).resolves.toMatchObject({
      options: { num_predict: 64, temperature: 0, stop: ['\n\n'] },
    })
  })

  it('refuses declared tool schemas before any conversion', async () => {
    await expect(serializeRequest(request({
      tools: [{ name: 'lookup', description: 'look up', parameters: { type: 'object' } }],
    }))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
  })

  it('accepts a request whose tool list is empty', async () => {
    await expect(serializeRequest(request({ tools: [] }))).resolves.toMatchObject({ stream: true })
  })

  it.each(['tool-call', 'tool-result'] as const)('refuses a %s block in history', async (type) => {
    const block: ContentBlock = type === 'tool-call'
      ? { type: 'tool-call', id: CallId('call-1'), name: 'lookup', arguments: '{}' }
      : { type: 'tool-result', toolCallId: CallId('call-1'), content: [{ type: 'text', text: 'out' }] }
    await expect(serializeRequest(request({ messages: [user([block])] })))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('reads image blocks into base64 in block order beside the joined text', async () => {
    await expect(serializeRequest(request({
      messages: [user([
        { type: 'text', text: 'what is this?' },
        { type: 'image', attachment: ref(1) },
        { type: 'image', attachment: ref(2) },
      ])],
    }), attachments)).resolves.toMatchObject({
      messages: [{ role: 'user', content: 'what is this?', images: ['AQ==', 'Ag=='] }],
    })
  })

  it('refuses image content when no attachment service resolves the bytes', async () => {
    await expect(serializeRequest(request({
      messages: [user([{ type: 'image', attachment: ref(1) }])],
    }))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('drops assistant reasoning, which this route has no field for', async () => {
    await expect(serializeRequest(request({
      messages: [history('assistant', [
        { type: 'reasoning', text: 'thinking out loud' },
        { type: 'text', text: 'answer' },
      ])],
    }))).resolves.toMatchObject({
      messages: [{ role: 'assistant', content: 'answer' }],
    })
  })
})
