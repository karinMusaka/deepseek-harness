/**
 * `OllamaAdapter`: fetch + NDJSON against an Ollama server's `/api/chat`
 * route, emitting harness StreamChunks. The adapter is transport-only:
 * connection facts arrive through a thunk resolved once per operation, so the
 * registering plugin owns validation and layering. The route is
 * unauthenticated, so no credential resolution exists here at all.
 *
 * @module dsh-llm-ollama/adapter
 */

import { attributionHeaders, contentHasImage, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ModelModality,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { parseNdjson } from './ndjson.ts'
import { serializeRequest } from './serialize.ts'
import { translate } from './translate.ts'
import type { WireErrorBody } from './types.ts'

/** One model entry advertised by the adapter. */
export interface OllamaCatalogModel {
  /** Wire model id, exactly as `ollama list` reports it (for example `moondream:latest`). */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector detail for deployments with similar model variants. */
  description?: string
  /** Known combined request/response context capacity; omitted when the deployment does not state one. */
  contextWindow?: number
  /** Per-request output cap for this model; omission falls back to {@link OllamaConnectionOptions.maxTokens}. */
  maxTokens?: number
  /**
   * Request modalities this model accepts. An omitted or empty list means text
   * only: a deployment declares `image` for a vision model, and every
   * undeclared or uncatalogued model refuses image content instead of sending
   * bytes a text-only model would answer about blindly.
   */
  inputModalities?: ModelModality[]
}

/**
 * Validated connection facts for one operation. The plugin's
 * `resolveAdapterOptions` is the one explicit resolve step producing this
 * shape; the adapter trusts it and re-reads it per operation, which is what
 * makes a configuration change reach the next request without re-registration.
 */
export interface OllamaConnectionOptions {
  /** Endpoint base; `/api/chat` is appended. */
  baseURL: string
  /** Default per-request output cap; explicit request values win. */
  maxTokens: number
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow: number
  /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
  models: readonly OllamaCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
}

/** Constructor options for {@link OllamaAdapter}: the operation-local resolution hooks the plugin owns. */
export interface OllamaAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => OllamaConnectionOptions
  /**
   * Resolve the durable attachment service, consulted only for a request that
   * actually carries image content. Absent, or returning `undefined`, makes an
   * image request fail with `UNSUPPORTED_CONTENT` instead of silently dropping
   * the image.
   */
  resolveAttachments?: () => AttachmentStore | undefined
}

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default combined request/response context capacity, sized for the small local models this route serves. */
export const DEFAULT_CONTEXT_WINDOW = 4096
/** Default per-request output-token cap, sized for short local classification and description answers. */
export const DEFAULT_MAX_TOKENS = 2048
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'
const TEXT_ONLY: readonly ModelModality[] = ['text']

function modelInfo(provider: string, model: OllamaCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: [...model.inputModalities ?? TEXT_ONLY],
  }
}

/**
 * Map an HTTP status to a stable LlmError code. Ollama sends no `Retry-After`
 * and no request-id header, and it truncates an oversized prompt instead of
 * rejecting it, so neither retry hints nor a context-overflow class arise on
 * this route.
 * @param status - status of a non-2xx provider response.
 * @returns the normalized harness error code; a model the server has not pulled answers 404.
 */
export function httpErrorCode(status: number): string {
  if (status === 404) return 'UNKNOWN_MODEL'
  if (status === 400) return 'INVALID_REQUEST'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * Direct-fetch adapter for a local or self-hosted Ollama server. One instance
 * serves every model name it was registered under (the harness model name IS
 * the wire model name).
 *
 * One stable signal reaches both initial fetch and body reads. Caller aborts
 * map to `ABORTED`; the configured per-read idle watchdog maps to `TIMEOUT`.
 */
export class OllamaAdapter extends LlmAdapter {
  constructor(private readonly config: OllamaAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Ollama' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.config.options().models.map(model => modelInfo(provider, model)))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.config.options()
    const configured = connection.models.find(entry => entry.id === model)
    return Promise.resolve({
      // An uncatalogued pass-through id declares the same text-only capability
      // an entry without `inputModalities` does: "unknown" here would let the
      // host accept and persist images the request must then refuse.
      ...configured === undefined
        ? { provider, id: model, name: model, inputModalities: [...TEXT_ONLY] }
        : modelInfo(provider, configured),
      context: { contextWindow: configured?.contextWindow ?? connection.defaultContextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // One resolution per stream call: connection facts freeze here and hold
    // for this whole request, so an in-flight stream never observes a
    // configuration change and the next call re-resolves.
    const connection = this.config.options()
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = this.request(
      options,
      watchdog.signal,
      connection,
      () => { watchdog.pulse() },
    )[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `Ollama stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('Ollama request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`Ollama API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('Ollama stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination; a return-time abort cannot add a second outcome.
        }
      }
    }
  }

  /**
   * Resolve the byte source for a request carrying images, refusing before any
   * I/O when the selected model or the composition cannot serve one.
   * @returns the attachment service for an image request, or `undefined` when the request has no image.
   */
  private imageSourceFor(
    options: GenerateOptions,
    connection: OllamaConnectionOptions,
  ): AttachmentStore | undefined {
    if (!options.messages.some(message => contentHasImage(message.content))) return undefined
    const modalities = connection.models.find(entry => entry.id === options.model)?.inputModalities ?? TEXT_ONLY
    if (!modalities.includes('image')) {
      throw new LlmError(
        `Ollama model "${options.model}" is not declared for image input;`
        + ' add it to models with inputModalities: [text, image]',
        'UNSUPPORTED_CONTENT',
      )
    }
    const attachments = this.config.resolveAttachments?.()
    if (attachments === undefined) {
      throw new LlmError('Ollama image input requires the durable attachment service.', 'UNSUPPORTED_CONTENT')
    }
    return attachments
  }

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: OllamaConnectionOptions,
    onLine: () => void,
  ): AsyncIterable<StreamChunk> {
    const attachments = this.imageSourceFor(options, connection)
    const body = await serializeRequest(options, attachments)
    // Prepared outside the try so the TRANSPORT label below covers exactly the
    // transport boundary, never a serialization failure.
    const payload = JSON.stringify(body)
    const headers = {
      'content-type': 'application/json',
      'accept': 'application/x-ndjson',
      ...attributionHeaders(),
    }

    let response: Response
    try {
      response = await fetch(`${connection.baseURL}/api/chat`, {
        method: 'POST',
        headers,
        body: payload,
        signal,
      })
    } catch (error: unknown) {
      // The outer stream distinguishes caller cancellation and watchdog expiry.
      if (signal.aborted) throw error
      // fetch wraps every transport failure (a server that is not running,
      // DNS, refused connection) in a bare `TypeError: fetch failed` whose
      // actionable detail lives on `cause`. Wrapping with the endpoint and
      // chaining the cause lets `errorChain` render the full diagnosis at
      // every reporting boundary.
      throw new LlmError(
        `Ollama API request to ${connection.baseURL} failed`,
        'TRANSPORT',
        { cause: error },
      )
    }

    if (!response.ok) {
      let message = `Ollama API error (HTTP ${response.status})`
      try {
        const parsed = await response.json() as WireErrorBody
        if (parsed.error !== undefined && parsed.error.length > 0) message = parsed.error
      } catch {
        // Only swallow error-body parsing: the HTTP status still identifies the
        // failure, so a malformed body must not mask it.
      }
      throw new LlmError(message, httpErrorCode(response.status), { status: response.status })
    }
    if (!response.body) {
      throw new LlmError('Ollama API returned no response body', 'EMPTY_RESPONSE')
    }

    yield* translate(parseNdjson(response.body, onLine))
  }
}
