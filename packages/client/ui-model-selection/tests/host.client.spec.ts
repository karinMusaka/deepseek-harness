import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SettingsProvider, settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { apply, MODEL_VISIBILITY_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-client-ui-model-selection'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

describe('ui-model-selection host', () => {
  it('registers, validates, and disposes the durable model-visibility namespace with its fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    const ns = settingsNamespace(MODEL_VISIBILITY_SETTINGS_NAMESPACE)
    expect(ctx.settings.get(ns)).toEqual({ hiddenModels: {} })
    await ctx.settings.update(ns, { hiddenModels: { 'deepseek-official': ['deepseek-v4-pro'] } })
    expect(ctx.settings.get(ns)).toEqual({ hiddenModels: { 'deepseek-official': ['deepseek-v4-pro'] } })
    await expect(ctx.settings.update(ns, { hiddenModels: 'not-a-dict' })).rejects.toThrow()
    await fiber.dispose()
    expect(ctx.settings.describe().map(row => row.ns)).not.toContain(ns)
  })

  it('does nothing when no settings provider is composed', async () => {
    const ctx = new Context()
    await ctx.plugin({ apply }).await()
    expect(ctx.get('settings')).toBeUndefined()
  })
})
