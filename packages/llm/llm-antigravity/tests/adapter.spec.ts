import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlockAssembler, createUserMessage, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { AntigravityAdapter } from '../src/adapter.ts'
import type { AntigravityAdapterOptions } from '../src/adapter.ts'
import { installFakeAgy } from './support/fake-agy.ts'
import type { FakeAgy } from './support/fake-agy.ts'

const GET_TIME_TOOL: ToolSchema = {
  name: 'get_time',
  description: 'Get the current time',
  parameters: { type: 'object', properties: {} },
}

function options(overrides: Partial<GenerateOptions> & { model: string }): GenerateOptions {
  return {
    provider: 'antigravity',
    messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] })],
    ...overrides,
  }
}

interface RunResult {
  chunks: StreamChunk[]
  assembler: BlockAssembler
}

async function run(adapter: AntigravityAdapter, request: GenerateOptions): Promise<RunResult> {
  const assembler = new BlockAssembler()
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(request)) {
    chunks.push(chunk)
    assembler.push(chunk)
  }
  return { chunks, assembler }
}

async function expectLlmError(promise: Promise<unknown>): Promise<LlmError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(LlmError)
    return error as LlmError
  }
  throw new Error('expected promise to reject with an LlmError')
}

describe('AntigravityAdapter', () => {
  let fake: FakeAgy | undefined

  afterEach(async () => {
    await fake?.cleanup()
    fake = undefined
    vi.unstubAllEnvs()
  })

  function makeAdapter(overrides: Partial<AntigravityAdapterOptions> = {}): AntigravityAdapter {
    if (fake === undefined) throw new Error('installFakeAgy() must run before makeAdapter()')
    return new AntigravityAdapter({
      binaryPath: fake.binaryPath,
      printTimeoutSeconds: 5,
      models: [],
      defaultContextWindow: 1048576,
      defaultMaxTokens: 65536,
      ...overrides,
    })
  }

  describe('providerInfo', () => {
    it('reports the given provider id and a fixed display name', async () => {
      fake = await installFakeAgy()
      const adapter = makeAdapter()
      expect(adapter.providerInfo('antigravity')).toEqual({ id: 'antigravity', name: 'Antigravity (agy)' })
    })
  })

  describe('text streaming', () => {
    it('streams live text deltas and maps usage, ending with a stop finish', async () => {
      fake = await installFakeAgy()
      const adapter = makeAdapter()
      const { chunks, assembler } = await run(adapter, options({ model: 'text-stream' }))

      expect(chunks.filter(c => c.type === 'text-delta').map(c => c.text)).toEqual(['Hello, ', 'world!'])
      expect(assembler.finish).toEqual({ kind: 'stop' })
      expect(assembler.usage).toEqual({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        reasoningTokens: 1,
      })
      const message = assembler.message({ kind: 'model', provider: 'antigravity', model: 'text-stream' })
      expect(message.content).toEqual([{ type: 'text', text: 'Hello, world!' }])
    })

    it('falls back to one text block from the final result when no deltas were streamed', async () => {
      fake = await installFakeAgy()
      const adapter = makeAdapter()
      const { chunks, assembler } = await run(adapter, options({ model: 'text-no-delta' }))

      expect(chunks.filter(c => c.type === 'text-delta').map(c => c.text)).toEqual(['whole response at once'])
      expect(assembler.finish).toEqual({ kind: 'stop' })
      const message = assembler.message({ kind: 'model', provider: 'antigravity', model: 'text-no-delta' })
      expect(message.content).toEqual([{ type: 'text', text: 'whole response at once' }])
    })

    it('falls back to the accumulated deltas when the terminal result omits response entirely', async () => {
      fake = await installFakeAgy()
      const adapter = makeAdapter()
      const { assembler } = await run(adapter, options({ model: 'text-stream-no-response-field' }))
      const message = assembler.message({ kind: 'model', provider: 'antigravity', model: 'text-stream-no-response-field' })
      expect(message.content).toEqual([{ type: 'text', text: 'streamed only' }])
    })
  })

  describe('tool calling', () => {
    it('buffers text during tool-mode (no live text-delta) and emits one tool-call block from a fenced reply', async () => {
      fake = await installFakeAgy()
      const adapter = makeAdapter()
      const { chunks, assembler } = await run(adapter, options({ model: 'tool-fenced', tools: [GET_TIME_TOOL] }))

      expect(chunks.some(c => c.type === 'text-delta')).toBe(false)
      expect(assembler.finish).toEqual({ kind: 'tool-calls' })
      const message = assembler.message({ kind: 'model', provider: 'antigravity', model: 'tool-fenced' })
      expect(message.content).toHaveLength(1)
      expect(message.content[0]).toMatchObject({ type: 'tool-call', name: 'get_time', arguments: '{}' })
    })

    it('emits leading prose as a text block before the tool-call block', async () => {
      fake = await installFakeAgy()
      const adapter = makeAdapter()
      const { assembler } = await run(adapter, options({ model: 'tool-fenced-prose', tools: [GET_TIME_TOOL] }))

      expect(assembler.finish).toEqual({ kind: 'tool-calls' })
      const message = assembler.message({ kind: 'model', provider: 'antigravity', model: 'tool-fenced-prose' })
      expect(message.content).toEqual([
        { type: 'text', text: 'Sure, let me check.' },
        expect.objectContaining({ type: 'tool-call', name: 'get_time', arguments: '{"tz":"UTC"}' }),
      ])
    })

    it('parses an unfenced JSON reply with multiple calls into distinct blocks', async () => {
      fake = await installFakeAgy()
      const adapter = makeAdapter()
      const { assembler } = await run(adapter, options({ model: 'tool-unfenced', tools: [GET_TIME_TOOL] }))

      expect(assembler.finish).toEqual({ kind: 'tool-calls' })
      const message = assembler.message({ kind: 'model', provider: 'antigravity', model: 'tool-unfenced' })
      expect(message.content).toEqual([
        expect.objectContaining({ type: 'tool-call', name: 'get_time', arguments: '{}' }),
        expect.objectContaining({ type: 'tool-call', name: 'get_weather', arguments: '{"city":"Tokyo"}' }),
      ])
      const ids = message.content.map(block => 'id' in block ? block.id : undefined)
      expect(new Set(ids).size).toBe(2)
    })

    it('falls back to the whole response as text when the fenced JSON does not parse', async () => {
      fake = await installFakeAgy()
      const adapter = makeAdapter()
      const { assembler } = await run(adapter, options({ model: 'tool-invalid-json', tools: [GET_TIME_TOOL] }))

      expect(assembler.finish).toEqual({ kind: 'stop' })
      const message = assembler.message({ kind: 'model', provider: 'antigravity', model: 'tool-invalid-json' })
      expect(message.content).toEqual([{ type: 'text', text: '```json\n{not valid json\n```' }])
    })

    it('falls back to plain text when tools were offered but the model just answered in prose', async () => {
      fake = await installFakeAgy()
      const adapter = makeAdapter()
      const { assembler } = await run(adapter, options({ model: 'tool-non-json-reply', tools: [GET_TIME_TOOL] }))

      expect(assembler.finish).toEqual({ kind: 'stop' })
      const message = assembler.message({ kind: 'model', provider: 'antigravity', model: 'tool-non-json-reply' })
      expect(message.content).toEqual([{ type: 'text', text: 'I do not need any tools for that.' }])
    })
  })

  describe('provider-reported failures', () => {
    it('throws SERVER for an ERROR result', async () => {
      fake = await installFakeAgy()
      const adapter = makeAdapter()
      const error = await expectLlmError(run(adapter, options({ model: 'result-error' })))
      expect(error.code).toBe('SERVER')
      expect(error.message).toContain('agy: generation failed')
    })

    it('throws SERVER with a generic message for an ERROR result carrying no error text', async () => {
      fake = await installFakeAgy()
      const adapter = makeAdapter()
      const error = await expectLlmError(run(adapter, options({ model: 'result-error-no-message' })))
      expect(error.code).toBe('SERVER')
      expect(error.message.length).toBeGreaterThan(0)
    })

    it('throws AGENT_TOOLS_DENIED for an empty response with denied built-in tool actions', async () => {
      fake = await installFakeAgy()
      const adapter = makeAdapter()
      const error = await expectLlmError(run(adapter, options({ model: 'denied-empty' })))
      expect(error.code).toBe('AGENT_TOOLS_DENIED')
      expect(error.message).toContain('Run Command')
    })

    it('emits an EMPTY_RESPONSE error finish (with usage) for an empty response with no denied actions', async () => {
      fake = await installFakeAgy()
      const adapter = makeAdapter()
      const { assembler } = await run(adapter, options({ model: 'empty-no-denial' }))
      expect(assembler.finish.kind).toBe('error')
      if (assembler.finish.kind === 'error') {
        expect(assembler.finish.failure.code).toBe(EMPTY_RESPONSE_CODE)
      }
      expect(assembler.usage).toEqual({ inputTokens: 5, outputTokens: 0 })
    })

    it('emits an EMPTY_RESPONSE error finish with no usage chunk when agy reports none', async () => {
      fake = await installFakeAgy()
      const adapter = makeAdapter()
      const { chunks, assembler } = await run(adapter, options({ model: 'empty-no-denial-no-usage' }))
      expect(assembler.finish.kind).toBe('error')
      expect(chunks.some(c => c.type === 'usage')).toBe(false)
    })

    it('throws SERVER with the bounded stderr tail for a non-zero exit before any result', async () => {
      fake = await installFakeAgy()
      const adapter = makeAdapter()
      const error = await expectLlmError(run(adapter, options({ model: 'nonzero-exit' })))
      expect(error.code).toBe('SERVER')
      expect(error.message).toContain('agy: fatal transport error')
    })

    it('throws STREAM_CLOSED when the process exits 0 without emitting a result', async () => {
      fake = await installFakeAgy()
      const adapter = makeAdapter()
      const error = await expectLlmError(run(adapter, options({ model: 'missing-result' })))
      expect(error.code).toBe('STREAM_CLOSED')
    })

    it('throws MALFORMED_RESPONSE for a non-JSON NDJSON line', async () => {
      fake = await installFakeAgy()
      const adapter = makeAdapter()
      const error = await expectLlmError(run(adapter, options({ model: 'malformed-line' })))
      expect(error.code).toBe('MALFORMED_RESPONSE')
    })

    it('throws SERVER naming the signal for a process that dies by signal, unrelated to any caller abort', async () => {
      fake = await installFakeAgy()
      const adapter = makeAdapter()
      const error = await expectLlmError(run(adapter, options({ model: 'self-kill' })))
      expect(error.code).toBe('SERVER')
      expect(error.message).toContain('SIGKILL')
    })
  })

  describe('request-level rejections', () => {
    it('throws UNSUPPORTED_OPTION for a stop-sequence request', async () => {
      fake = await installFakeAgy()
      const adapter = makeAdapter()
      const error = await expectLlmError(run(adapter, options({ model: 'text-stream', stop: ['STOP'] })))
      expect(error.code).toBe('UNSUPPORTED_OPTION')
    })

    it('throws ABORTED immediately for a pre-aborted signal, without spawning', async () => {
      fake = await installFakeAgy()
      const adapter = makeAdapter()
      const controller = new AbortController()
      controller.abort()
      const error = await expectLlmError(run(adapter, options({ model: 'text-stream', signal: controller.signal })))
      expect(error.code).toBe('ABORTED')
    })
  })

  describe('spawn failures', () => {
    it('throws CONFIG naming the binary path for ENOENT', async () => {
      const adapter = new AntigravityAdapter({
        binaryPath: join(tmpdir(), 'dsh-agy-does-not-exist-xyz'),
        printTimeoutSeconds: 5,
        models: [],
        defaultContextWindow: 1048576,
        defaultMaxTokens: 65536,
      })
      const error = await expectLlmError(run(adapter, options({ model: 'text-stream' })))
      expect(error.code).toBe('CONFIG')
      expect(error.message).toContain('dsh-agy-does-not-exist-xyz')
    })

    it('throws TRANSPORT (not CONFIG) for a non-ENOENT spawn failure', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-agy-noexec-'))
      const notExecutable = join(dir, 'not-executable')
      await writeFile(notExecutable, '#!/usr/bin/env node\nprocess.exit(0)\n')
      await chmod(notExecutable, 0o644)
      try {
        const adapter = new AntigravityAdapter({
          binaryPath: notExecutable,
          printTimeoutSeconds: 5,
          models: [],
          defaultContextWindow: 1048576,
          defaultMaxTokens: 65536,
        })
        const error = await expectLlmError(run(adapter, options({ model: 'text-stream' })))
        expect(error.code).toBe('TRANSPORT')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  })

  describe('untrusted temp working directory', () => {
    it('runs agy inside a fresh directory distinct from the harness cwd, then removes it', async () => {
      fake = await installFakeAgy()
      const adapter = makeAdapter()
      const { assembler } = await run(adapter, options({ model: 'cwd-echo' }))
      const message = assembler.message({ kind: 'model', provider: 'antigravity', model: 'cwd-echo' })
      const block = message.content[0]
      const agyCwd = block?.type === 'text' ? block.text : ''
      expect(agyCwd.length).toBeGreaterThan(0)
      expect(agyCwd).not.toBe(process.cwd())
      const realTmp = await realpath(tmpdir())
      expect(agyCwd.startsWith(realTmp)).toBe(true)
      expect(existsSync(agyCwd)).toBe(false)
    })
  })

  describe('cancellation and early teardown', () => {
    it('aborts mid-stream (after partial output) and kills the child', async () => {
      fake = await installFakeAgy()
      const adapter = makeAdapter()
      const controller = new AbortController()
      const chunks: StreamChunk[] = []
      let caught: unknown
      try {
        for await (const chunk of adapter.stream(options({ model: 'hang-after-delta', signal: controller.signal }))) {
          chunks.push(chunk)
          if (chunk.type === 'text-delta') controller.abort()
        }
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(LlmError)
      expect((caught as LlmError).code).toBe('ABORTED')
      expect(chunks.some(c => c.type === 'text-delta')).toBe(true)
    })

    it('an early consumer return (no signal) kills the still-running child and removes its temp directory', async () => {
      fake = await installFakeAgy()
      const adapter = makeAdapter()
      const markerDir = await mkdtemp(join(tmpdir(), 'dsh-agy-marker-'))
      const markerPath = join(markerDir, 'cwd.txt')
      vi.stubEnv('FAKE_AGY_CWD_MARKER', markerPath)
      try {
        const chunks: StreamChunk[] = []
        for await (const chunk of adapter.stream(options({ model: 'hang-after-delta' }))) {
          chunks.push(chunk)
          if (chunk.type === 'text-delta') break
        }
        expect(chunks.some(c => c.type === 'text-delta')).toBe(true)
        await vi.waitFor(() => {
          expect(existsSync(markerPath)).toBe(true)
        }, { timeout: 5000 })
        const agyCwd = (await readFile(markerPath, 'utf8')).trim()
        expect(agyCwd.length).toBeGreaterThan(0)
        await vi.waitFor(() => {
          expect(existsSync(agyCwd)).toBe(false)
        }, { timeout: 5000 })
      } finally {
        await rm(markerDir, { recursive: true, force: true })
      }
    })
  })

  describe('model discovery (agy models)', () => {
    it('discovers and caches the model list when no catalog is configured', async () => {
      fake = await installFakeAgy()
      vi.stubEnv('FAKE_AGY_MODELS_SCENARIO', 'ok')
      const adapter = makeAdapter({ models: [] })
      const first = await adapter.listModels('antigravity')
      expect(first).toEqual([
        { provider: 'antigravity', id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)', inputModalities: ['text'] },
        { provider: 'antigravity', id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)', inputModalities: ['text'] },
      ])
      // A second call must not spawn again: flip the env so a re-spawn would
      // change the answer, then confirm the cached result is unchanged.
      vi.stubEnv('FAKE_AGY_MODELS_SCENARIO', 'empty')
      const second = await adapter.listModels('antigravity')
      expect(second).toEqual(first)
    })

    it('tolerates a banner-only (empty) catalog', async () => {
      fake = await installFakeAgy()
      vi.stubEnv('FAKE_AGY_MODELS_SCENARIO', 'empty')
      const adapter = makeAdapter({ models: [] })
      await expect(adapter.listModels('antigravity')).resolves.toEqual([])
    })

    it('reports DISCOVERY_FAILED naming the signal when the models subcommand dies by signal', async () => {
      fake = await installFakeAgy()
      vi.stubEnv('FAKE_AGY_MODELS_SCENARIO', 'crash')
      const adapter = makeAdapter({ models: [] })
      const error = await expectLlmError(adapter.listModels('antigravity'))
      expect(error.code).toBe('DISCOVERY_FAILED')
      expect(error.message).toContain('SIGKILL')
    })

    it('rejects with DISCOVERY_FAILED on failure, and retries (does not cache the rejection)', async () => {
      fake = await installFakeAgy()
      vi.stubEnv('FAKE_AGY_MODELS_SCENARIO', 'fail')
      const adapter = makeAdapter({ models: [] })
      const first = await expectLlmError(adapter.listModels('antigravity'))
      expect(first.code).toBe('DISCOVERY_FAILED')

      vi.stubEnv('FAKE_AGY_MODELS_SCENARIO', 'ok')
      await expect(adapter.listModels('antigravity')).resolves.toEqual([
        { provider: 'antigravity', id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)', inputModalities: ['text'] },
        { provider: 'antigravity', id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)', inputModalities: ['text'] },
      ])
    })

    it('reports DISCOVERY_FAILED naming the binary for a spawn failure', async () => {
      const adapter = new AntigravityAdapter({
        binaryPath: join(tmpdir(), 'dsh-agy-does-not-exist-xyz'),
        printTimeoutSeconds: 5,
        models: [],
        defaultContextWindow: 1048576,
        defaultMaxTokens: 65536,
      })
      const error = await expectLlmError(adapter.listModels('antigravity'))
      expect(error.code).toBe('DISCOVERY_FAILED')
    })

    it('serves the configured catalog directly without spawning discovery', async () => {
      fake = await installFakeAgy()
      vi.stubEnv('FAKE_AGY_MODELS_SCENARIO', 'fail')
      const adapter = makeAdapter({
        models: [{ id: 'custom-model', name: 'Custom', description: 'd', contextWindow: 1000, maxTokens: 100 }],
      })
      await expect(adapter.listModels('antigravity')).resolves.toEqual([
        { provider: 'antigravity', id: 'custom-model', name: 'Custom', description: 'd', inputModalities: ['text'] },
      ])
    })

    it('falls back to the id as the name, and omits description, for a bare configured entry', async () => {
      fake = await installFakeAgy()
      const adapter = makeAdapter({ models: [{ id: 'bare-model' }] })
      await expect(adapter.listModels('antigravity')).resolves.toEqual([
        { provider: 'antigravity', id: 'bare-model', name: 'bare-model', inputModalities: ['text'] },
      ])
    })
  })

  describe('resolveModel', () => {
    it('uses a configured entry\'s capacities and description', async () => {
      fake = await installFakeAgy()
      const adapter = makeAdapter({
        models: [{ id: 'custom-model', name: 'Custom', description: 'd', contextWindow: 2048, maxTokens: 256 }],
      })
      await expect(adapter.resolveModel('antigravity', 'custom-model')).resolves.toEqual({
        provider: 'antigravity',
        id: 'custom-model',
        name: 'Custom',
        description: 'd',
        inputModalities: ['text'],
        context: { contextWindow: 2048 },
        defaultMaxTokens: 256,
      })
    })

    it('falls back to adapter defaults for a configured entry missing capacities', async () => {
      fake = await installFakeAgy()
      const adapter = makeAdapter({
        models: [{ id: 'bare-model' }],
        defaultContextWindow: 4096,
        defaultMaxTokens: 512,
      })
      await expect(adapter.resolveModel('antigravity', 'bare-model')).resolves.toEqual({
        provider: 'antigravity',
        id: 'bare-model',
        name: 'bare-model',
        inputModalities: ['text'],
        context: { contextWindow: 4096 },
        defaultMaxTokens: 512,
      })
    })

    it('resolves an id absent from a non-empty catalog as a pass-through, without spawning discovery', async () => {
      fake = await installFakeAgy()
      vi.stubEnv('FAKE_AGY_MODELS_SCENARIO', 'fail')
      const adapter = makeAdapter({
        models: [{ id: 'custom-model' }],
        defaultContextWindow: 777,
        defaultMaxTokens: 88,
      })
      await expect(adapter.resolveModel('antigravity', 'unlisted')).resolves.toEqual({
        provider: 'antigravity',
        id: 'unlisted',
        name: 'unlisted',
        inputModalities: ['text'],
        context: { contextWindow: 777 },
        defaultMaxTokens: 88,
      })
    })

    it('resolves an unlisted pass-through id against the discovered name when the catalog is empty', async () => {
      fake = await installFakeAgy()
      vi.stubEnv('FAKE_AGY_MODELS_SCENARIO', 'ok')
      const adapter = makeAdapter({ models: [], defaultContextWindow: 999, defaultMaxTokens: 111 })
      await expect(adapter.resolveModel('antigravity', 'gemini-3.8-flash-low')).resolves.toEqual({
        provider: 'antigravity',
        id: 'gemini-3.8-flash-low',
        name: 'Gemini 3.8 Flash (Low)',
        inputModalities: ['text'],
        context: { contextWindow: 999 },
        defaultMaxTokens: 111,
      })
    })

    it('resolves an id absent from discovery as a text-only pass-through with default capacities', async () => {
      fake = await installFakeAgy()
      vi.stubEnv('FAKE_AGY_MODELS_SCENARIO', 'ok')
      const adapter = makeAdapter({ models: [], defaultContextWindow: 999, defaultMaxTokens: 111 })
      await expect(adapter.resolveModel('antigravity', 'unknown-model')).resolves.toEqual({
        provider: 'antigravity',
        id: 'unknown-model',
        name: 'unknown-model',
        inputModalities: ['text'],
        context: { contextWindow: 999 },
        defaultMaxTokens: 111,
      })
    })

    it('throws ABORTED for a pre-aborted signal without starting resolution', async () => {
      fake = await installFakeAgy()
      const adapter = makeAdapter()
      const controller = new AbortController()
      controller.abort()
      const error = await expectLlmError(adapter.resolveModel('antigravity', 'text-stream', controller.signal))
      expect(error.code).toBe('ABORTED')
    })
  })
})
