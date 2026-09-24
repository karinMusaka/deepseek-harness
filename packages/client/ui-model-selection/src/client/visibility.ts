/**
 * Pure model-picker visibility filtering. Consumed only by `ModelDirectory`,
 * which is the sole enforcement point: it removes hidden models from the
 * `groups` both selection entries render, while `session.selectModel` stays
 * untouched, so a hidden-but-current model keeps routing normally.
 */
import type { ModelProviderGroup, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'

/** Per-provider hidden model id lists, as stored under `hiddenModels`. */
export type HiddenModels = Record<string, readonly string[]>

/**
 * Whether one model is in the user's hidden set for its provider.
 * @param hidden - the durable hidden-model preference.
 * @param providerId - the model's owning provider route id.
 * @param modelId - the provider-owned model id.
 * @returns whether the model is hidden.
 */
export function isModelHidden(hidden: HiddenModels, providerId: string, modelId: string): boolean {
  return hidden[providerId]?.includes(modelId) ?? false
}

/**
 * Derive the shown provider groups from the raw catalog. A hidden model is
 * removed from its group unless it is the exact current provider/model pair
 * — the trigger must never fall back to "Select model" because of hiding — and
 * a group left with no models is dropped. Catalog failures are untouched;
 * this filters only `groups`.
 * @param groups - the raw (unfiltered) provider groups from the last good load.
 * @param hidden - the durable hidden-model preference; an empty object hides nothing.
 * @param current - the session's current selection, exempted from hiding.
 * @returns the shown groups, in the same order, minus the hidden entries.
 */
export function filterGroups(
  groups: readonly ModelProviderGroup[],
  hidden: HiddenModels,
  current: ModelSelection | null,
): ModelProviderGroup[] {
  return groups
    .map(group => ({
      ...group,
      models: group.models.filter(model =>
        !isModelHidden(hidden, group.id, model.id)
        || (current !== null && current.provider === group.id && current.model === model.id)),
    }))
    .filter(group => group.models.length > 0)
}
