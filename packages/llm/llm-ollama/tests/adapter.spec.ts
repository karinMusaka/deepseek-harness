import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import LlmRuntime, { createUserMessage, userAgent } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import * as LlmOllama from '@deepseek-ai/dsh-llm-ollama'
import { OllamaAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-ollama'
import { httpErrorCode } from '../src/adapter.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textLines } from './mock-server.ts'
import type { Behavior } from './mock-server.ts'

const IMAGE: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 1,
  width: 1,
  height: 1,
}

/** Minimal attachment service: only `readImage` is on this adapter's path. */
class TestAttachmentStore extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 1,
    maxImagesPerMessage: 1,
    maxMessageImageBytes: 1,
    maxImagePixels: 1,
    mediaTypes: ['image/png'],
  }

  validateImage(_input: SaveImageAttachment): Promise<void> {
    return Promise.reject(new Error('not used'))
  }

  saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return Promise.reject(new Error('not used'))
  }

  readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    return Promise.resolve({ ref, data: Uint8Array.of(7) })
  }
}

afterEach(async () => {
  await closeMockServers()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

async function harness(baseURL: string, config: object = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmOllama, { baseURL, ...config })
  return ctx
}

/** Direct adapter over the plugin's real resolve step. */
function adapterOf(
  config: LlmOllama.Config = {},
  resolveAttachments?: () => AttachmentStore | undefined,
): OllamaAdapter {
  return new OllamaAdapter({
    options: () => resolveAdapterOptions(config),
    ...resolveAttachments === undefined ? {} : { resolveAttachments },
  })
}

function ask(text: string) {
  return [createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'test' },
  })]
}

describe('OllamaAdapter against a mock server', () => {
  it('streams a text generation end to end through the assembler', async () => {
    const server = await mockServer([{ kind: 'ndjson', lines: textLines }])
    const ctx = await harness(server.url)

    const result = await assemble(ctx, { model: 'moondream:latest', messages: ask('hi') })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 1 })

    expect(server.requests[0]).toEqual({
      model: 'moondream:latest',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      // The adapter default materialized by LlmRuntime, nested the way Ollama wants it.
      options: { num_predict: 2048 },
    })
    // The route is unauthenticated: attribution is the only harness header.
    expect(server.headers[0]?.['user-agent']).toBe(userAgent())
    expect(server.headers[0]?.accept).toBe('application/x-ndjson')
    expect(server.headers[0]).not.toHaveProperty('authorization')
  })

  it('streams raw chunks through ctx.llm.stream', async () => {
    const server = await mockServer([{ kind: 'ndjson', lines: textLines, delayMs: 2 }])
    const ctx = await harness(server.url)

    const kinds: string[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'ollama',
      model: 'moondream:latest',
      messages: ask('hi'),
    })) {
      kinds.push(chunk.type)
    }
    expect(kinds).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  })

  it('preserves an explicit request cap over the adapter default', async () => {
    const server = await mockServer([{ kind: 'ndjson', lines: textLines }])
    const ctx = await harness(server.url, { maxTokens: 32 })
    await assemble(ctx, { model: 'moondream:latest', messages: [], maxTokens: 8 })
    expect(server.requests[0]).toMatchObject({ options: { num_predict: 8 } })
  })

  it.each([
    [404, 'UNKNOWN_MODEL'],
    [400, 'INVALID_REQUEST'],
    [429, 'RATE_LIMIT'],
    [500, 'SERVER'],
    [503, 'SERVER'],
  ])('maps HTTP %d to failure code %s with the plain-string body message', async (status, code) => {
    const behavior: Behavior = {
      kind: 'http-error',
      status,
      body: JSON.stringify({ error: `failed with ${status}` }),
    }
    const server = await mockServer([behavior])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'moondream:latest', messages: [] })
    expect(result.finish).toEqual({
      kind: 'error',
      failure: { message: `failed with ${status}`, code, status },
    })
  })

  it('maps an unusual status to HTTP_<status>', () => {
    expect(httpErrorCode(418)).toBe('HTTP_418')
  })

  it.each([
    ['a JSON body without an error member', '{"done":false}'],
    ['an empty error string', '{"error":""}'],
    ['a non-JSON body', 'Bad Gateway'],
  ])('keeps the status-line message for %s', async (_case, body) => {
    const server = await mockServer([{ kind: 'http-error', status: 502, body, contentType: 'text/plain' }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'moondream:latest', messages: [] })
    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: { code: 'SERVER', message: 'Ollama API error (HTTP 502)', status: 502 },
    })
  })

  it('reports a transport failure with the endpoint in the message', async () => {
    // Port 1 is reserved/unbound, so the service normalizes the fetch failure.
    const ctx = await harness('http://127.0.0.1:1')
    const result = await assemble(ctx, { model: 'moondream:latest', messages: [] })
    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: { code: 'TRANSPORT', message: 'Ollama API request to http://127.0.0.1:1 failed' },
    })
  })

  it('maps connection failures to TRANSPORT without losing the cause', async () => {
    const cause = new TypeError('connection refused')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(cause)
    const adapter = adapterOf({ baseURL: 'http://example.invalid' })
    try {
      const drain = async (): Promise<void> => {
        for await (const _chunk of adapter.stream({ provider: 'ollama', model: 'm', messages: [] })) { /* drain */ }
      }
      await expect(drain()).rejects.toMatchObject({ code: 'TRANSPORT', cause })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('classifies an aborted request as an aborted finish', async () => {
    const controller = new AbortController()
    controller.abort()
    const ctx = await harness('http://127.0.0.1:1')
    const result = await assemble(ctx, {
      model: 'moondream:latest',
      messages: [],
      signal: controller.signal,
    })
    expect(result.finish).toMatchObject({ kind: 'aborted', failure: { code: 'ABORTED' } })
  })

  it('throws EMPTY_RESPONSE when the response has no body', async () => {
    const adapter = adapterOf({ baseURL: 'http://example.invalid' })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))
    try {
      const drain = async (): Promise<void> => {
        for await (const _chunk of adapter.stream({ provider: 'ollama', model: 'm', messages: [] })) { /* drain */ }
      }
      await expect(drain()).rejects.toThrow(/no response body/)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('classifies an abrupt body close as TRANSPORT', async () => {
    const server = await mockServer([{
      kind: 'close-early',
      lines: ['{"message":{"content":"par"},"done":false}'],
    }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'moondream:latest', messages: [] })
    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: { code: 'TRANSPORT' },
    })
  })

  it('aborts mid-stream via the request signal', async () => {
    const server = await mockServer([{ kind: 'ndjson', lines: textLines, delayMs: 50 }])
    const ctx = await harness(server.url)
    const controller = new AbortController()

    const pending = (async () => {
      const chunks = []
      for await (const chunk of ctx.llm.stream({
        provider: 'ollama',
        model: 'moondream:latest',
        messages: [],
        signal: controller.signal,
      })) {
        chunks.push(chunk)
      }
      return chunks
    })()

    setTimeout(() => { controller.abort() }, 30)
    const chunks = await pending
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.type).toBe('finish')
    if (chunks[0]?.type !== 'finish') throw new Error('expected a finish chunk')
    expect(chunks[0].reason.kind).toBe('aborted')
  })

  it('aborts the underlying body when the stream stays idle past its watchdog', async () => {
    vi.useFakeTimers()
    let stopped = false
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      const signal = init?.signal
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener('abort', () => {
            stopped = true
            controller.error(signal.reason)
          }, { once: true })
        },
      })
      return Promise.resolve(new Response(body, { status: 200 }))
    })
    const adapter = adapterOf({ baseURL: 'http://example.invalid', streamIdleTimeoutMs: 100 })
    try {
      const drain = (async () => {
        for await (const _chunk of adapter.stream({ provider: 'ollama', model: 'm', messages: [] })) { /* drain */ }
      })()
      const rejected = expect(drain).rejects.toMatchObject({ code: 'TIMEOUT' })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(100)
      await rejected
      expect(stopped).toBe(true)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('keeps an idle provider read alive through content-free lines', async () => {
    vi.useFakeTimers()
    const encoder = new TextEncoder()
    const idle = '{"message":{"role":"assistant","content":""},"done":false}\n'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => { controller.enqueue(encoder.encode(idle)) }, 75)
          setTimeout(() => { controller.enqueue(encoder.encode(idle)) }, 150)
          setTimeout(() => {
            controller.enqueue(encoder.encode(textLines.map(line => `${line}\n`).join('')))
            controller.close()
          }, 225)
        },
      })
      return Promise.resolve(new Response(body, { status: 200 }))
    })
    const adapter = adapterOf({ baseURL: 'http://example.invalid', streamIdleTimeoutMs: 100 })
    try {
      const chunks: string[] = []
      const drain = (async () => {
        for await (const chunk of adapter.stream({ provider: 'ollama', model: 'm', messages: [] })) {
          chunks.push(chunk.type)
        }
      })()
      await vi.advanceTimersByTimeAsync(75)
      await vi.advanceTimersByTimeAsync(75)
      await vi.advanceTimersByTimeAsync(75)
      await expect(drain).resolves.toBeUndefined()
      expect(chunks).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('resolves connection facts exactly once per stream call', async () => {
    const server = await mockServer([{ kind: 'ndjson', lines: textLines }])
    const options = vi.fn(() => resolveAdapterOptions({ baseURL: server.url }))
    const adapter = new OllamaAdapter({ options })

    for await (const _chunk of adapter.stream({ provider: 'ollama', model: 'm', messages: [] })) { /* drain */ }

    expect(options).toHaveBeenCalledTimes(1)
  })
})

describe('image capability gating', () => {
  const imageMessages = [createUserMessage({
    content: [{ type: 'text', text: 'is this a photo?' }, { type: 'image', attachment: IMAGE }],
    source: { kind: 'plugin', plugin: 'test' },
  })]

  it('sends declared image bytes as base64 beside the message text', async () => {
    const server = await mockServer([{ kind: 'ndjson', lines: textLines }])
    const ctx = await harness(server.url, {
      models: [{ id: 'moondream:latest', inputModalities: ['text', 'image'] }],
    })
    await ctx.plugin(TestAttachmentStore)

    const result = await assemble(ctx, { model: 'moondream:latest', messages: imageMessages })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.requests[0]).toMatchObject({
      messages: [{ role: 'user', content: 'is this a photo?', images: ['Bw=='] }],
    })
  })

  it('refuses an image for a model the catalog does not declare for it, before any request', async () => {
    const server = await mockServer([])
    const ctx = await harness(server.url, { models: [{ id: 'moondream:latest' }] })
    await ctx.plugin(TestAttachmentStore)

    const result = await assemble(ctx, { model: 'moondream:latest', messages: imageMessages })
    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: { code: 'UNSUPPORTED_CONTENT', message: /is not declared for image input/ as unknown as string },
    })
    expect(server.requests).toHaveLength(0)
  })

  it('refuses an image for an uncatalogued pass-through model', async () => {
    const server = await mockServer([])
    const ctx = await harness(server.url)
    await ctx.plugin(TestAttachmentStore)

    const result = await assemble(ctx, { model: 'never-declared', messages: imageMessages })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'UNSUPPORTED_CONTENT' } })
    expect(server.requests).toHaveLength(0)
  })

  it('refuses an image when no attachment service is mounted', async () => {
    const server = await mockServer([])
    const ctx = await harness(server.url, {
      models: [{ id: 'moondream:latest', inputModalities: ['text', 'image'] }],
    })

    const result = await assemble(ctx, { model: 'moondream:latest', messages: imageMessages })
    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: { code: 'UNSUPPORTED_CONTENT', message: /durable attachment service/ as unknown as string },
    })
    expect(server.requests).toHaveLength(0)
  })

  it('refuses an image when the adapter has no attachment resolver at all', async () => {
    const adapter = adapterOf({
      baseURL: 'http://example.invalid',
      models: [{ id: 'm', inputModalities: ['text', 'image'] }],
    })
    const drain = async (): Promise<void> => {
      for await (const _chunk of adapter.stream({ provider: 'ollama', model: 'm', messages: imageMessages })) {
        /* drain */
      }
    }
    await expect(drain()).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })
})

describe('plugin registration and config', () => {
  it('keeps wire helpers off the package root', () => {
    for (const helper of [
      'httpErrorCode',
      'serializeMessages',
      'serializeRequest',
      'parseNdjson',
      'mapDoneReason',
      'mapUsage',
      'translate',
    ]) expect(LlmOllama).not.toHaveProperty(helper)
  })

  it('registers the ollama provider and unregisters on dispose (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const fiber = await ctx.plugin(LlmOllama, { baseURL: 'http://127.0.0.1:1' })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'ollama', name: 'Ollama' }])
    expect(ctx.llm.listConfigurableProviders()).toEqual([{
      provider: 'ollama',
      displayName: 'Ollama',
      settingsNs: 'llm-ollama',
      settingsPath: [],
    }])
    await fiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
  })

  it('registers retryPolicy from the provider config', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmOllama, {
      baseURL: 'http://127.0.0.1:1',
      retryPolicy: { mode: 'always', backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 } },
    })
    expect(ctx.llm.providerRetryPolicy('ollama')).toEqual({
      mode: 'always',
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0.2,
    })
  })

  it('advertises no model until a deployment declares one, while every id still passes through', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmOllama, { baseURL: 'http://127.0.0.1:1' })
    await expect(ctx.llm.listModels('ollama')).resolves.toEqual([])
    await expect(ctx.llm.resolveModelInfo('ollama', 'qwen3:8b')).resolves.toEqual({
      provider: 'ollama',
      id: 'qwen3:8b',
      name: 'qwen3:8b',
      inputModalities: ['text'],
      context: { contextWindow: 4096 },
      defaultMaxTokens: 2048,
    })
  })

  it('advertises the declared catalog with its exact capacities and modalities', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmOllama, {
      baseURL: 'http://127.0.0.1:1',
      defaultContextWindow: 8192,
      models: [
        { id: 'moondream:latest', name: 'Moondream', description: 'Local vision', contextWindow: 2048, maxTokens: 256, inputModalities: ['text', 'image'] },
        { id: 'qwen3:8b' },
      ],
    })
    await expect(ctx.llm.listModels('ollama')).resolves.toEqual([
      {
        provider: 'ollama',
        id: 'moondream:latest',
        name: 'Moondream',
        description: 'Local vision',
        inputModalities: ['text', 'image'],
      },
      { provider: 'ollama', id: 'qwen3:8b', name: 'qwen3:8b', inputModalities: ['text'] },
    ])
    await expect(ctx.llm.resolveModelInfo('ollama', 'moondream:latest'))
      .resolves.toMatchObject({ context: { contextWindow: 2048 }, defaultMaxTokens: 256 })
    await expect(ctx.llm.resolveModelInfo('ollama', 'qwen3:8b'))
      .resolves.toMatchObject({ context: { contextWindow: 8192 }, defaultMaxTokens: 2048 })
  })

  it('treats an empty declared modality list as text only', async () => {
    // Schemastery normalizes an omitted array to `[]`, so both spellings state
    // the same negative capability.
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmOllama, { baseURL: 'http://127.0.0.1:1', models: [{ id: 'm', inputModalities: [] }] })
    await expect(ctx.llm.listModels('ollama')).resolves.toEqual([
      { provider: 'ollama', id: 'm', name: 'm', inputModalities: ['text'] },
    ])
  })

  it('exposes no reasoning levels, which this route cannot select', async () => {
    const adapter = adapterOf()
    await expect(adapter.resolveModel('ollama', 'qwen3:8b')).resolves.not.toHaveProperty('reasoning')
    expect(adapter.providerInfo('ollama')).toEqual({ id: 'ollama', name: 'Ollama' })
  })

  it.each([
    [[{ id: '' }], /ids must be non-empty/],
    [[{ id: 'm', name: '' }], /empty name/],
    [[{ id: 'm', contextWindow: 0 }], /contextWindow/],
    [[{ id: 'm', contextWindow: 1.5 }], /contextWindow/],
    [[{ id: 'm', maxTokens: 0 }], /maxTokens must be a positive integer/],
    [[{ id: 'm', inputModalities: ['audio'] }], /unknown input modality "audio"/],
    [[{ id: 'm' }, { id: 'm' }], /duplicate catalog model/],
  ] as const)('rejects invalid advisory model config', (models, message) => {
    expect(() => resolveAdapterOptions({ models: [...models] as LlmOllama.OllamaCatalogModel[] }))
      .toThrow(message)
  })

  it('rejects an invalid catalog entry at plugin load, before registering the route', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await expect(ctx.plugin(LlmOllama, {
      baseURL: 'http://127.0.0.1:1',
      models: [{ id: 'dup' }, { id: 'dup' }],
    })).rejects.toThrow(/duplicate catalog model/)
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it.each([0, 1.5])('rejects invalid adapter-wide default context capacity %s', async (defaultContextWindow) => {
    expect(() => resolveAdapterOptions({ defaultContextWindow }))
      .toThrow(/defaultContextWindow must be a positive integer/)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await expect(ctx.plugin(LlmOllama, { baseURL: 'http://127.0.0.1:1', defaultContextWindow }))
      .rejects.toThrow(/defaultContextWindow/)
  })

  it.each([0, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid adapter-wide maxTokens %s', (maxTokens) => {
    expect(() => resolveAdapterOptions({ maxTokens })).toThrow(/maxTokens must be a positive safe integer/)
  })

  it('rejects invalid idle watchdog bounds for direct and plugin composition', async () => {
    expect(() => resolveAdapterOptions({ streamIdleTimeoutMs: Number.POSITIVE_INFINITY }))
      .toThrow(/streamIdleTimeoutMs.*positive finite/)
    expect(() => resolveAdapterOptions({ streamIdleTimeoutMs: MAX_TIMER_DELAY_MS + 1 }))
      .toThrow(/streamIdleTimeoutMs.*no greater/)

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await expect(ctx.plugin(LlmOllama, { baseURL: 'http://127.0.0.1:1', streamIdleTimeoutMs: 0 }))
      .rejects.toThrow(/streamIdleTimeoutMs/)
  })

  it('rejects invalid nested retryPolicy before registering the provider', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await expect(ctx.plugin(LlmOllama, {
      baseURL: 'http://127.0.0.1:1',
      retryPolicy: { mode: 'normal', maxRetries: -1 },
    })).rejects.toThrow(/retryPolicy/)
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('resolves the endpoint from config, then any environment layer, then the default local server', () => {
    expect(resolveAdapterOptions({}).baseURL).toBe(LlmOllama.DEFAULT_BASE_URL)
    const project = createLaunchEnvironmentSnapshot([
      { source: 'project-env', path: '/work/.env', values: { OLLAMA_BASE_URL: 'http://gpu-box:11434' } },
    ])
    expect(resolveAdapterOptions({}, project).baseURL).toBe('http://gpu-box:11434')
    expect(resolveAdapterOptions({ baseURL: 'http://explicit:11434' }, project).baseURL)
      .toBe('http://explicit:11434')
  })

  it('routes a request to $OLLAMA_BASE_URL when config omits the endpoint', async () => {
    const server = await mockServer([{ kind: 'ndjson', lines: textLines }])
    vi.stubEnv('OLLAMA_BASE_URL', server.url)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmOllama, {})
    await assemble(ctx, { model: 'moondream:latest', messages: [] })
    expect(server.requests).toHaveLength(1)
  })

  it('uses the default catalog when apply is called directly', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    LlmOllama.apply(ctx, { baseURL: 'http://127.0.0.1:1' })
    await expect(ctx.llm.listModels('ollama')).resolves.toEqual([])
  })
})
