/**
 * Cordis plugin registering the model-facing `classify_image` tool over an
 * auxiliary vision route on `ctx.llm`.
 *
 * The tool exists so an ordinary text-only session can classify a person image
 * without the image entering that session: a locally hosted vision model
 * answers two fixed questions and only the resulting text labels return to the
 * calling model. This package owns the route policy, the durable pre-dispatch
 * record, and the model-facing schema; it owns no provider and no transport.
 * @module @deepseek-ai/dsh-tool-classify-image
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-llm'
import { applyClassifyImageTool } from './classify.ts'
import type { ClassifyImagePolicy, ClassifyImageRequestEventData } from './classify.ts'

export {
  applyClassifyImageTool,
  CLASSIFY_IMAGE_PROMPTS,
  imageMediaTypeForPath,
} from './classify.ts'
export type { ClassifyImagePolicy, ClassifyImageRequestEventData, ClassifyImageValue } from './classify.ts'
export { normalizeImageGender, normalizeImageType } from './normalize.ts'
export type { ImageSubjectGender, ImageSubjectType } from './normalize.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only pre-dispatch record of one `classify_image` auxiliary vision request pair. */
    'tool-classify-image/request': ClassifyImageRequestEventData
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-classify-image'

/** Services the tool needs for its complete path: registration, route, bytes, and durable commit. */
export const inject = ['tools', 'llm', 'fs', 'attachments']

/** Provider route used when neither `provider` nor `model` is configured. */
export const DEFAULT_PROVIDER = 'ollama'

/**
 * Vision model used with {@link DEFAULT_PROVIDER}. `minicpm-v` is the model
 * verified against the two fixed questions; smaller local vision models read
 * illustrations as photographs.
 */
export const DEFAULT_MODEL = 'minicpm-v:latest'

/** Output-token cap per auxiliary request; each question asks for one sentence. */
export const DEFAULT_MAX_TOKENS = 128

/** Cooperative tool-call budget: two sequential local vision inferences. */
export const DEFAULT_TIMEOUT_MS = 120_000

/** Plugin config: the auxiliary vision route and the bounds each call runs under. */
export interface Config {
  /** Provider route carrying the vision model; must be supplied together with `model`. */
  provider?: string
  /** Exact vision model id; must be supplied together with `provider`. */
  model?: string
  /** Output-token cap for each of the two auxiliary requests. Defaults to 128. */
  maxTokens?: number
  /** Cooperative tool-call budget (ms) covering both requests. Defaults to 120000. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  provider: z.string(),
  model: z.string(),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  timeoutMs: z.number().step(1).min(1).default(DEFAULT_TIMEOUT_MS),
})

/** Complete configuration key set, used to reject unknown keys from direct construction. */
const CONFIG_KEYS: ReadonlySet<string> = new Set(['provider', 'model', 'maxTokens', 'timeoutMs'])

/** Validate one positive integer bound. */
function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`tool-classify-image: ${field} must be a positive integer`)
  }
}

/**
 * The one explicit resolve step from raw config to the validated policy a
 * registration runs under. `provider` and `model` are required together: a
 * provider supplied alone would inherit a model id that means nothing on it,
 * and a model supplied alone would run on whatever `ollama` happens to route.
 * @param config - untrusted plugin configuration.
 * @returns the validated route and generation policy.
 */
export function resolveClassifyImagePolicy(config: Config): ClassifyImagePolicy {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`tool-classify-image: unknown config key "${key}"`)
  }
  const { provider, model } = config
  if ((provider === undefined) !== (model === undefined)) {
    throw new Error('tool-classify-image: provider and model must be supplied together')
  }
  if (provider !== undefined && model !== undefined && (provider.length === 0 || model.length === 0)) {
    throw new Error('tool-classify-image: provider and model must be non-empty strings')
  }
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  assertPositiveInteger('maxTokens', maxTokens)
  assertPositiveInteger('timeoutMs', timeoutMs)
  return {
    provider: provider ?? DEFAULT_PROVIDER,
    model: model ?? DEFAULT_MODEL,
    maxTokens,
    timeoutMs,
  }
}

/**
 * Register `classify_image` under the resolved auxiliary vision policy.
 * @param ctx - context carrying the injected `tools`, `llm`, `fs`, and `attachments` services.
 * @param config - untrusted plugin configuration; invalid values fail at load.
 */
export function apply(ctx: Context, config: Config): void {
  applyClassifyImageTool(ctx, resolveClassifyImagePolicy(config))
}
