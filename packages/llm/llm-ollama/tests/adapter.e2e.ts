import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmOllama from '@deepseek-ai/dsh-llm-ollama'
import { assemble, type AssembledResult } from './assemble.ts'

/**
 * Real-server e2e against a local `ollama serve`. Opted into explicitly with
 * $DSH_LLM_OLLAMA_E2E, because an Ollama endpoint needs no credential: a
 * reachable server alone must not turn this suite on in a keyless lane.
 * $OLLAMA_BASE_URL selects a non-default endpoint; $DSH_LLM_OLLAMA_E2E_MODEL
 * selects a pulled vision model (default `moondream:latest`).
 */

const MODEL = process.env.DSH_LLM_OLLAMA_E2E_MODEL ?? 'moondream:latest'
/** A 1x1 PNG: enough for the vision path to accept and describe an image. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const PNG = Uint8Array.from(Buffer.from(PNG_BASE64, 'base64'))

const ref: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: PNG.byteLength,
  width: 1,
  height: 1,
}

class E2eAttachmentStore extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: PNG.byteLength,
    maxImagesPerMessage: 1,
    maxMessageImageBytes: PNG.byteLength,
    maxImagePixels: 1,
    mediaTypes: ['image/png'],
  }

  validateImage(_input: SaveImageAttachment): Promise<void> {
    return Promise.reject(new Error('not used'))
  }

  saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return Promise.reject(new Error('not used'))
  }

  readImage(value: ImageAttachmentRef): Promise<StoredImageAttachment> {
    return Promise.resolve({ ref: value, data: PNG })
  }
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(config: LlmOllama.Config = {}): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmOllama, config)
  return ctx
}

function textOf(result: AssembledResult): string {
  return result.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

describe.skipIf(!process.env.DSH_LLM_OLLAMA_E2E)('llm-ollama e2e (real Ollama server)', () => {
  it('completes a text generation with reported token counts', async () => {
    const ctx = await harness()
    const result = await assemble(ctx, {
      model: MODEL,
      messages: [createUserMessage({
        // An open-ended continuation prompt, not an instruction: the small
        // models this route serves answer an instruction with an immediate
        // end-of-sequence often enough that the adapter would correctly report
        // EMPTY_RESPONSE and the assertion below would measure the model, not
        // the transport.
        content: [{ type: 'text', text: 'Write one sentence about the Roman Empire.' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
      maxTokens: 32,
    })
    expect(['stop', 'max-tokens']).toContain(result.finish.kind)
    expect(textOf(result).length).toBeGreaterThan(0)
    expect(result.usage?.inputTokens).toBeGreaterThan(0)
    expect(result.usage?.outputTokens).toBeGreaterThan(0)
  })

  it('reports the output cap as max-tokens', async () => {
    const ctx = await harness()
    const result = await assemble(ctx, {
      model: MODEL,
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'Write a very long detailed essay about the Roman Empire.' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
      maxTokens: 5,
    })
    expect(result.finish.kind).toBe('max-tokens')
  })

  it('describes a declared image through the vision path', async () => {
    const ctx = await harness({ models: [{ id: MODEL, inputModalities: ['text', 'image'] }] })
    await ctx.plugin(E2eAttachmentStore)
    const result = await assemble(ctx, {
      model: MODEL,
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'Describe this image in one short sentence.' }, { type: 'image', attachment: ref }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
      maxTokens: 64,
    })
    expect(['stop', 'max-tokens']).toContain(result.finish.kind)
    expect(textOf(result).length).toBeGreaterThan(0)
  })

  it('reports an unpulled model as UNKNOWN_MODEL', async () => {
    const ctx = await harness()
    const result = await assemble(ctx, { model: 'nonexistent-model-xyz', messages: [] })
    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: { code: 'UNKNOWN_MODEL', status: 404 },
    })
  })

  it('streams raw chunks in protocol order', async () => {
    const ctx = await harness()
    const kinds: string[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'ollama',
      model: MODEL,
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'Count from 1 to 5, digits only.' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
      maxTokens: 32,
    })) {
      kinds.push(chunk.type)
    }
    expect(kinds[0]).toBe('block-start')
    expect(kinds.at(-1)).toBe('finish')
    expect(kinds.filter(kind => kind === 'finish')).toHaveLength(1)
    expect(kinds.indexOf('usage')).toBeLessThan(kinds.indexOf('finish'))
  })
})
