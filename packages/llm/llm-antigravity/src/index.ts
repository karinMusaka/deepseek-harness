/**
 * Register an {@link AntigravityAdapter} for the `antigravity` provider route
 * on `ctx.llm`, driving the local Antigravity CLI (`agy`) as a main chat
 * backend, including harness tool calls through a prompt-level protocol.
 * Opt-in only: no shipped bundle mounts this package, because `agy` is a
 * locally installed, separately licensed CLI this harness cannot assume is
 * present.
 * @module @deepseek-ai/dsh-llm-antigravity
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AntigravityAdapter } from './adapter.ts'
import type { AntigravityAdapterOptions } from './adapter.ts'
import type { AntigravityCatalogModel } from './types.ts'

export { AntigravityAdapter } from './adapter.ts'
export type { AntigravityAdapterOptions } from './adapter.ts'
export type * from './types.ts'

export const name = 'llm-antigravity'
export const inject = ['llm']

/** The single provider route this plugin owns. */
const PROVIDER = 'antigravity'

/**
 * Plugin config, fully defaulted by the schema below: every field always
 * carries a value by the time `apply` reads it, so no field is optional here
 * and `resolveAdapterOptions` validates rather than defaults.
 */
export interface Config {
  /** Path or bare command name resolved through `PATH` for the agy executable. */
  binaryPath: string
  /** `--print-timeout` value in whole seconds passed to every agy invocation. */
  printTimeoutSeconds: number
  /** Model catalog; empty means "discover via `agy models` at first use". */
  models: AntigravityCatalogModel[]
  /** Context-window fallback for a model without a configured or discovered capacity. */
  defaultContextWindow: number
  /** Output-token-cap fallback for a model without a configured capacity. */
  defaultMaxTokens: number
}

const catalogModel: z<AntigravityCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

export const Config: z<Config> = z.object({
  binaryPath: z.string().default('agy'),
  printTimeoutSeconds: z.number().step(1).min(1).default(300),
  models: z.array(catalogModel).default([]),
  defaultContextWindow: z.number().step(1).min(1).default(1048576),
  defaultMaxTokens: z.number().step(1).min(1).default(65536),
})

/** Validate and detach the configured model catalog. */
function resolveModels(models: readonly AntigravityCatalogModel[]): AntigravityCatalogModel[] {
  const seen = new Set<string>()
  return models.map((model) => {
    if (model.id.length === 0) throw new Error('llm-antigravity: catalog model ids must be non-empty')
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`llm-antigravity: catalog model "${model.id}" has an empty name`)
    }
    if (model.contextWindow !== undefined && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(`llm-antigravity: catalog model "${model.id}" contextWindow must be a positive integer`)
    }
    if (model.maxTokens !== undefined && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(`llm-antigravity: catalog model "${model.id}" maxTokens must be a positive integer`)
    }
    if (seen.has(model.id)) throw new Error(`llm-antigravity: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
    }
  })
}

/**
 * The one explicit resolve step from schema-normalized config to validated
 * adapter construction facts (repo "Explicit > implicit" rule). `config`
 * already carries every field's default when it arrives through the Loader;
 * this step re-validates bounds a bare object literal could still violate
 * (programmatic construction bypasses Schemastery) and detaches the catalog.
 * @param config - fully defaulted plugin config.
 * @returns validated adapter construction facts.
 */
export function resolveAdapterOptions(config: Config): AntigravityAdapterOptions {
  if (config.binaryPath.length === 0) throw new Error('llm-antigravity: binaryPath must be non-empty')
  if (!Number.isInteger(config.printTimeoutSeconds) || config.printTimeoutSeconds <= 0) {
    throw new Error('llm-antigravity: printTimeoutSeconds must be a positive integer')
  }
  if (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0) {
    throw new Error('llm-antigravity: defaultContextWindow must be a positive integer')
  }
  if (!Number.isInteger(config.defaultMaxTokens) || config.defaultMaxTokens <= 0) {
    throw new Error('llm-antigravity: defaultMaxTokens must be a positive integer')
  }
  return {
    binaryPath: config.binaryPath,
    printTimeoutSeconds: config.printTimeoutSeconds,
    models: resolveModels(config.models),
    defaultContextWindow: config.defaultContextWindow,
    defaultMaxTokens: config.defaultMaxTokens,
  }
}

export function apply(ctx: Context, config: Config): void {
  const adapter = new AntigravityAdapter(resolveAdapterOptions(config))
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], adapter))
}
