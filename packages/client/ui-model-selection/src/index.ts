/**
 * Model selection plugin, node half. The plugin exists in the host
 * cordis.yml / Loader mainly so the browser half ships via
 * exports["./client"] (discovered through the package.json dsh.client
 * declaration); it also registers the durable model-picker visibility
 * preference — the settings namespace the browser half's ModelDirectory
 * filters the advisory catalog against — following the ui-theme pattern.
 */
import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MODEL_VISIBILITY_SETTINGS_NAMESPACE, ModelVisibilitySettingsSchema } from './model-visibility-settings.ts'

export {
  HIDDEN_MODELS_FIELD, MODEL_VISIBILITY_SETTINGS_NAMESPACE,
  type ModelVisibilitySettings,
} from './model-visibility-settings.ts'

const VISIBILITY_NAMESPACE = settingsNamespace(MODEL_VISIBILITY_SETTINGS_NAMESPACE)

/**
 * Host plugin body: register the durable model-visibility section when the
 * optional settings service is composed.
 * @param ctx - host context that may acquire the settings service.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(VISIBILITY_NAMESPACE, ModelVisibilitySettingsSchema)
  })
}
