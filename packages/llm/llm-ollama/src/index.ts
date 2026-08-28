/**
 * Register an {@link OllamaAdapter} for the `ollama` provider route on
 * `ctx.llm`, with connection facts resolved per request instead of frozen at
 * load: the plugin layers its `cordis.yml` entry config under the optional
 * `llm-ollama` user-settings section (`ctx.settings`), so a changed base URL
 * or catalog reaches the very next request without restarting anything, while
 * an in-flight stream keeps the facts it started with. The one
 * registration-captured fact — the retry policy — re-registers the route in
 * place when it changes.
 *
 * The route is unauthenticated: an Ollama server accepts requests without a
 * credential, so this plugin has no credential reference, no key resolution,
 * and no request identity beyond the shared attribution header.
 * @module @deepseek-ai/dsh-llm-ollama
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { ModelModality, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { launchEnvironmentOf, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  OllamaAdapter,
} from './adapter.ts'
import type { OllamaCatalogModel, OllamaConnectionOptions } from './adapter.ts'

export {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  OllamaAdapter,
} from './adapter.ts'
export type { OllamaAdapterOptions, OllamaCatalogModel, OllamaConnectionOptions } from './adapter.ts'
export type * from './types.ts'

export const name = 'llm-ollama'
export const inject = ['llm']

const NS = settingsNamespace('llm-ollama')
/** The single provider route this plugin owns. */
const PROVIDER = 'ollama'
/** The request modalities a catalog entry may declare. */
const MODALITIES: readonly ModelModality[] = ['text', 'image']

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-ollama` settings-section shape. Every field is optional in yml:
 * an omitted endpoint resolves through `$OLLAMA_BASE_URL` and then the
 * server's default local address, and an omitted catalog advertises no model
 * while every request id still passes through as a text-only model.
 */
export interface Config {
  /** Endpoint base; falls back to $OLLAMA_BASE_URL from a trusted environment layer, then the default local server. */
  baseURL?: string
  /** Default per-request output cap (default 2,048); a model's own cap and explicit request values win. */
  maxTokens?: number
  /** Positive context capacity used when the selected model has no exact value (default 4,096). */
  defaultContextWindow?: number
  /** Advisory models shown by discovery consumers, and the one place a model's image support is declared. */
  models?: OllamaCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
}

const catalogModel: z<OllamaCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(['text', 'image'])),
})

export const Config: z<Config> = z.object({
  baseURL: z.string(),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default([]),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
})

/** The address `ollama serve` listens on by default. */
export const DEFAULT_BASE_URL = 'http://localhost:11434'

/** Environment variable naming this provider's endpoint, honored only from trusted layers. */
const BASE_URL_ENV = 'OLLAMA_BASE_URL'

/** One resolution's complete request facts. */
export type ResolvedOllamaOptions = OllamaConnectionOptions

/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models: readonly OllamaCatalogModel[] | undefined): OllamaCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? []).map((model) => {
    if (model.id.length === 0) throw new Error('llm-ollama: catalog model ids must be non-empty')
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`llm-ollama: catalog model "${model.id}" has an empty name`)
    }
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(
        `llm-ollama: catalog model "${model.id}" contextWindow must be a positive integer`,
      )
    }
    if (model.maxTokens !== undefined
      && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(
        `llm-ollama: catalog model "${model.id}" maxTokens must be a positive integer`,
      )
    }
    // Schemastery normalizes an omitted array member to `[]`, so an empty list
    // and an absent one are the same statement: text only.
    const modalities = model.inputModalities ?? []
    for (const modality of modalities) {
      if (!MODALITIES.includes(modality)) {
        throw new Error(
          `llm-ollama: catalog model "${model.id}" declares unknown input modality "${modality}"`,
        )
      }
    }
    if (seen.has(model.id)) throw new Error(`llm-ollama: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      ...modalities.length === 0 ? {} : { inputModalities: [...modalities] },
    }
  })
}

/**
 * The one explicit resolve step from raw config to validated connection facts.
 * Programmatic construction may bypass Schemastery normalization, so every
 * default and bound is re-judged here — for the composition entry at load
 * (fail loud) and for each settings snapshot at its first use.
 * @param config - raw plugin config or resolved settings snapshot.
 * @param environment - this run's environment layers, or `undefined` outside
 * the product CLI. Every layer may supply an endpoint, so a checkout can point
 * its own agent at the Ollama host that checkout is meant to use.
 * @returns validated connection facts.
 */
export function resolveAdapterOptions(
  config: Config,
  environment?: LaunchEnvironmentSnapshot,
): ResolvedOllamaOptions {
  if (config.defaultContextWindow !== undefined
    && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('llm-ollama: defaultContextWindow must be a positive integer')
  }
  if (config.maxTokens !== undefined
    && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error('llm-ollama: maxTokens must be a positive safe integer')
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-ollama: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  return {
    baseURL: config.baseURL
      ?? environment?.get(BASE_URL_ENV)?.value
      ?? DEFAULT_BASE_URL,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-ollama: retryPolicy'),
  }
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: ResolvedOllamaOptions | undefined
  const options = (): ResolvedOllamaOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw, launchEnvironmentOf(ctx))
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing a beyond-schema bound:
      // keep serving the last good facts and say so once per bad snapshot.
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-ollama: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const adapter = new OllamaAdapter({
    options,
    resolveAttachments: () => ctx.get('attachments'),
  })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Ollama', settingsNs: NS, settingsPath: [] },
  ])
  // Route effects bind to this apply fiber via the stable `ctx` reference,
  // even when a swap runs inside the scoped settings callback below.
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy
    if (deepEqualJson(policy, registeredPolicy)) return
    // The registry captures the retry policy at registration, so it is the one
    // fact per-request resolution cannot refresh. `replace` re-reads it in one
    // synchronous registry section: disposing and re-registering instead would
    // publish an empty route set between the two, and an observer that reacted
    // to it would see this provider disappear and come back.
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: ensureRegistrationFacts,
  })
}
