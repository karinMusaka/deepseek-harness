/**
 * Per-model picker visibility preference, stored in the Host user-settings
 * document. Shared by both plugin halves (mirrors `theme-settings.ts`): the
 * host half (`../index.ts`) registers the schema, and the browser half
 * (`./client/service.ts`) reads the durable value through `ctx.settingsScope`
 * — only the constants and the plain type, never the schema itself, so
 * `@deepseek-ai/schemastery` stays out of the browser bundle exactly as
 * `ThemeSettingsSchema` does.
 */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the model selection plugin. */
export const MODEL_VISIBILITY_SETTINGS_NAMESPACE = 'ui-model-selection'

/** Field carrying the per-provider hidden model id lists. */
export const HIDDEN_MODELS_FIELD = 'hiddenModels'

/**
 * Durable model-picker visibility section shared by the Host schema and the
 * browser scope. A provider absent from the dict hides nothing for it — the
 * default, unhidden state needs no stored entry.
 */
export interface ModelVisibilitySettings {
  /** Provider route id to the hidden model ids under that provider. */
  hiddenModels: Record<string, string[]>
}

/** Durable model-visibility schema; also the wire envelope the browser scope validates against. */
export const ModelVisibilitySettingsSchema: z<ModelVisibilitySettings> = z.object({
  [HIDDEN_MODELS_FIELD]: z.dict(z.array(z.string())).default({}),
})
