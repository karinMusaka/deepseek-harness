/**
 * `AntigravityAdapter` drives the local Antigravity CLI (`agy`) as a harness
 * LLM route: it spawns one `agy` turn per `stream()` call inside a fresh
 * untrusted temp directory (agy's own built-in tools are only denied when its
 * headless mode does not trust the working directory — see the package
 * README), translates its `stream-json` NDJSON output into `StreamChunk`s,
 * and implements harness tool calling through a prompt-level protocol agy
 * itself has no native support for.
 * @module @deepseek-ai/dsh-llm-antigravity/adapter
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CallId, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ModelModality,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { type AgyProcessHandle, spawnAgy } from './agy-process.ts'
import { buildPrompt } from './prompt.ts'
import { parseToolCallResponse } from './tool-protocol.ts'
import type { AgyDiscoveredModel, AgyOutputEvent, AgyResultEvent, AgyTokenUsage, AntigravityCatalogModel } from './types.ts'

/** agy serves text only; every model this adapter advertises declares the same fixed modality. */
const TEXT_ONLY: readonly ModelModality[] = ['text']

/** Validated construction facts for {@link AntigravityAdapter}, produced by `resolveAdapterOptions` in `index.ts`. */
export interface AntigravityAdapterOptions {
  /** Path or bare command name resolved through `PATH` for the agy executable. */
  binaryPath: string
  /** `--print-timeout` value in whole seconds. */
  printTimeoutSeconds: number
  /** Configured model catalog; empty means "discover via `agy models`". */
  models: readonly AntigravityCatalogModel[]
  /** Context-window fallback for a model without a configured or discovered capacity. */
  defaultContextWindow: number
  /** Output-token-cap fallback for a model without a configured capacity. */
  defaultMaxTokens: number
}

/** Map agy's usage fields onto the harness vocabulary. */
function toTokenUsage(usage: AgyTokenUsage): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...usage.cache_read_tokens !== undefined ? { cacheReadTokens: usage.cache_read_tokens } : {},
    ...usage.thinking_tokens !== undefined ? { reasoningTokens: usage.thinking_tokens } : {},
  }
}

/** Parse one `agy models` output line (`<id>\t<display name>`); a line without a tab is banner/log noise. */
function parseAgyModelLine(line: string): AgyDiscoveredModel | undefined {
  const tabIndex = line.indexOf('\t')
  if (tabIndex < 0) return undefined
  const id = line.slice(0, tabIndex).trim()
  const name = line.slice(tabIndex + 1).trim()
  if (id.length === 0 || name.length === 0) return undefined
  return { id, name }
}

/** Create a fresh untrusted temp directory, run `fn` with it, and always remove it afterward. */
async function withUntrustedTempDir<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-agy-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Provider route implementation over the local Antigravity CLI (`agy`).
 * Spawns one agy process per `stream()` call and per uncached model-discovery
 * lookup; see the package README for the untrusted-cwd and prompt-level
 * tool-calling design this class implements.
 */
export class AntigravityAdapter extends LlmAdapter {
  /** Cached in-flight/successful discovery; cleared on rejection so the next call retries. */
  private discovery: Promise<readonly LlmModelInfo[]> | undefined

  constructor(private readonly options: AntigravityAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Antigravity (agy)' }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    if (this.options.models.length > 0) {
      return this.options.models.map(model => ({
        provider,
        id: model.id,
        name: model.name ?? model.id,
        ...model.description !== undefined ? { description: model.description } : {},
        inputModalities: TEXT_ONLY,
      }))
    }
    this.discovery ??= this.discoverModels(provider).catch((error: unknown) => {
      this.discovery = undefined
      throw error
    })
    return this.discovery
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted === true) {
      throw new LlmError('Antigravity model resolution aborted by caller', 'ABORTED')
    }
    const configured = this.options.models.find(entry => entry.id === model)
    if (configured !== undefined) {
      return {
        provider,
        id: model,
        name: configured.name ?? model,
        ...configured.description !== undefined ? { description: configured.description } : {},
        inputModalities: TEXT_ONLY,
        context: { contextWindow: configured.contextWindow ?? this.options.defaultContextWindow },
        defaultMaxTokens: configured.maxTokens ?? this.options.defaultMaxTokens,
      }
    }
    const discovered = this.options.models.length === 0
      ? (await this.listModels(provider)).find(entry => entry.id === model)
      : undefined
    return {
      provider,
      id: model,
      name: discovered?.name ?? model,
      inputModalities: TEXT_ONLY,
      context: { contextWindow: this.options.defaultContextWindow },
      defaultMaxTokens: this.options.defaultMaxTokens,
    }
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.signal?.aborted === true) {
      throw new LlmError('Antigravity request aborted by caller', 'ABORTED')
    }
    if (options.stop !== undefined && options.stop.length > 0) {
      throw new LlmError('Antigravity (agy) exposes no stop-sequence flag', 'UNSUPPORTED_OPTION')
    }

    const { text: promptText, toolsRequested } = buildPrompt(options)
    const dir = await mkdtemp(join(tmpdir(), 'dsh-agy-'))
    const args = [
      '--model', options.model,
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--print=',
      '--disable-slash-commands',
      '--print-timeout', `${this.options.printTimeoutSeconds}s`,
    ]
    const input = `${JSON.stringify({
      event: 'user',
      message: { content: [{ type: 'text', text: promptText }] },
    })}\n`
    const handle = spawnAgy({ binaryPath: this.options.binaryPath, args, cwd: dir, input })
    const onAbort = (): void => { handle.kill() }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    let exhausted = false
    try {
      yield* this.consume(handle, options, toolsRequested)
      exhausted = true
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
      if (!exhausted) handle.kill()
      await rm(dir, { recursive: true, force: true })
    }
  }

  /** Consume one process's event stream and translate it into `StreamChunk`s. */
  private async * consume(
    handle: AgyProcessHandle,
    options: GenerateOptions,
    toolsRequested: boolean,
  ): AsyncGenerator<StreamChunk, void, void> {
    let accumulatedText = ''
    let blockStarted = false
    let lastUsage: TokenUsage | undefined
    let resultEvent: AgyResultEvent['result'] | undefined
    let exitCode: number | null = null
    let exitSignal: NodeJS.Signals | null = null

    // handle.events never rejects (spawnAgy reports every failure as a typed
    // event, never a thrown/rejected transport error), so the only throw
    // sources below are the two explicit `throw` sites, both already
    // well-formed LlmErrors: no generic catch-and-rewrap is needed here. A
    // caller abort that raced a genuine failure is still classified as
    // ABORTED by the post-loop check below, since `options.signal.aborted`
    // is what actually matters to the caller, not which branch noticed it.
    for await (const event of handle.events) {
      if (event.kind === 'spawn-error') throw this.spawnErrorToLlmError(event.error)
      if (event.kind === 'exit') {
        exitCode = event.code
        exitSignal = event.signal
        continue
      }
      const trimmed = event.line.trim()
      if (trimmed.length === 0) continue
      const parsed = this.parseLine(trimmed)
      if (parsed.event === 'step_update' && 'step_update' in parsed) {
        const update = parsed.step_update
        if (update.text_delta !== undefined && update.text_delta.length > 0) {
          accumulatedText += update.text_delta
          if (!toolsRequested) {
            if (!blockStarted) {
              yield { type: 'block-start', index: 0, blockType: 'text' }
              blockStarted = true
            }
            yield { type: 'text-delta', index: 0, text: update.text_delta }
          }
        }
        if (update.usage !== undefined) lastUsage = toTokenUsage(update.usage)
      } else if (parsed.event === 'result' && 'result' in parsed) {
        resultEvent = parsed.result
        if (resultEvent.usage !== undefined) lastUsage = toTokenUsage(resultEvent.usage)
      }
    }

    if (options.signal?.aborted === true) {
      throw new LlmError('Antigravity request aborted by caller', 'ABORTED')
    }

    if (resultEvent === undefined) {
      if (exitCode !== 0) {
        throw new LlmError(
          `agy exited with code ${String(exitCode)}${exitSignal !== null ? ` (signal ${exitSignal})` : ''} before emitting a result: ${handle.stderrTail()}`,
          'SERVER',
        )
      }
      throw new LlmError('agy exited without emitting a result event', 'STREAM_CLOSED')
    }

    if (resultEvent.status === 'ERROR') {
      throw new LlmError(resultEvent.error ?? 'Antigravity execution failed', 'SERVER')
    }

    const finalText = resultEvent.response ?? accumulatedText
    if (finalText.trim().length === 0) {
      const denied = resultEvent.denied_actions ?? []
      if (denied.length > 0) {
        throw new LlmError(
          `Antigravity (agy) attempted to use its own built-in tools, which headless mode denies: ${denied.map(action => action.display_name).join(', ')}`,
          'AGENT_TOOLS_DENIED',
        )
      }
      if (lastUsage !== undefined) yield { type: 'usage', usage: lastUsage }
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: 'agy completed with no response content', code: EMPTY_RESPONSE_CODE } },
      }
      return
    }

    if (toolsRequested) {
      yield* emitToolCallResult(finalText, lastUsage)
      return
    }

    if (!blockStarted) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: finalText }
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: finalText } }
    if (lastUsage !== undefined) yield { type: 'usage', usage: lastUsage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  /** Parse one non-blank NDJSON line, or throw `MALFORMED_RESPONSE`. */
  private parseLine(trimmed: string): AgyOutputEvent {
    try {
      return JSON.parse(trimmed) as AgyOutputEvent
    } catch (cause) {
      throw new LlmError(
        `Antigravity emitted a malformed NDJSON line: ${trimmed.slice(0, 200)}`,
        'MALFORMED_RESPONSE',
        { cause },
      )
    }
  }

  private spawnErrorToLlmError(error: Error): LlmError {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return new LlmError(
        `Antigravity binary "${this.options.binaryPath}" was not found; set Config.binaryPath to the agy executable`,
        'CONFIG',
        { cause: error },
      )
    }
    return new LlmError(
      `Antigravity binary "${this.options.binaryPath}" could not be started: ${error.message}`,
      'TRANSPORT',
      { cause: error },
    )
  }

  /** Run `agy models` in a fresh untrusted temp directory and parse its output. */
  private async discoverModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return withUntrustedTempDir(async (cwd) => {
      const handle = spawnAgy({ binaryPath: this.options.binaryPath, args: ['models'], cwd, input: '' })
      const lines: string[] = []
      let exitCode: number | null = null
      let exitSignal: NodeJS.Signals | null = null
      // handle.events never rejects; the one throw source below is already a
      // well-formed LlmError, so no generic catch-and-rewrap is needed here
      // (see the matching note in `consume()`).
      for await (const event of handle.events) {
        if (event.kind === 'line') lines.push(event.line)
        else if (event.kind === 'exit') { exitCode = event.code; exitSignal = event.signal }
        else throw this.spawnErrorToDiscoveryError(event.error)
      }
      if (exitCode !== 0) {
        throw new LlmError(
          `Antigravity model discovery ("${this.options.binaryPath} models") exited with code ${String(exitCode)}${exitSignal !== null ? ` (signal ${exitSignal})` : ''}: ${handle.stderrTail()}`,
          'DISCOVERY_FAILED',
        )
      }
      const models = lines
        .map(parseAgyModelLine)
        .filter((model): model is AgyDiscoveredModel => model !== undefined)
      return models.map(model => ({ provider, id: model.id, name: model.name, inputModalities: TEXT_ONLY }))
    })
  }

  private spawnErrorToDiscoveryError(error: Error): LlmError {
    return new LlmError(
      `Antigravity model discovery could not start "${this.options.binaryPath}": ${error.message}`,
      'DISCOVERY_FAILED',
      { cause: error },
    )
  }
}

/** Emit the tool-call (or text fallback) chunks for a buffered tool-mode response. */
function* emitToolCallResult(responseText: string, usage: TokenUsage | undefined): Generator<StreamChunk, void, void> {
  const parsed = parseToolCallResponse(responseText)
  if (parsed === undefined) {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: responseText }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: responseText } }
    if (usage !== undefined) yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
    return
  }

  let index = 0
  if (parsed.prose.length > 0) {
    yield { type: 'block-start', index, blockType: 'text' }
    yield { type: 'text-delta', index, text: parsed.prose }
    yield { type: 'block-end', index, block: { type: 'text', text: parsed.prose } }
    index += 1
  }
  for (const call of parsed.calls) {
    const id = CallId(crypto.randomUUID())
    const args = JSON.stringify(call.arguments)
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: args }
    yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: args } }
    index += 1
  }
  if (usage !== undefined) yield { type: 'usage', usage }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
