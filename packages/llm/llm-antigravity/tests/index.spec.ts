import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmAntigravity from '../src/index.ts'
import { Config, resolveAdapterOptions } from '../src/index.ts'
import type { Config as ConfigType } from '../src/index.ts'

/**
 * The exported `Config` schema's TypeScript call signature requires the
 * already-fully-defaulted `Config` shape (no field is optional there, by
 * design), while these tests deliberately exercise the RUNTIME schema with
 * partial or invalid raw input — exactly the case Schemastery normalizes or
 * rejects. This cast documents that gap; it changes nothing at runtime.
 */
const raw = (data: Partial<ConfigType>): ConfigType => data as ConfigType

describe('Config', () => {
  it('fills every field with its documented default when given an empty object', () => {
    expect(Config(raw({}))).toEqual({
      binaryPath: 'agy',
      printTimeoutSeconds: 300,
      models: [],
      defaultContextWindow: 1048576,
      defaultMaxTokens: 65536,
    })
  })

  it('normalizes a fully specified config unchanged', () => {
    expect(Config({
      binaryPath: '/opt/agy/bin/agy',
      printTimeoutSeconds: 60,
      defaultContextWindow: 2048,
      defaultMaxTokens: 256,
      models: [{ id: 'm', name: 'M', description: 'd', contextWindow: 100, maxTokens: 10 }],
    })).toEqual({
      binaryPath: '/opt/agy/bin/agy',
      printTimeoutSeconds: 60,
      defaultContextWindow: 2048,
      defaultMaxTokens: 256,
      models: [{ id: 'm', name: 'M', description: 'd', contextWindow: 100, maxTokens: 10 }],
    })
  })

  it('rejects a non-positive printTimeoutSeconds at the schema boundary', () => {
    expect(() => Config(raw({ printTimeoutSeconds: 0 }))).toThrow()
  })

  it('requires a catalog model id', () => {
    expect(() => Config(raw({ models: [{ name: 'no id' } as ConfigType['models'][number]] }))).toThrow()
  })
})

describe('resolveAdapterOptions', () => {
  // A plain object literal, not `Config()`'s return value: spreading the
  // schema's own return risks losing internal Schemastery prototype state,
  // so these tests build their override base independently.
  const defaults: ConfigType = {
    binaryPath: 'agy',
    printTimeoutSeconds: 300,
    models: [],
    defaultContextWindow: 1048576,
    defaultMaxTokens: 65536,
  }

  it('passes a schema-defaulted config through unchanged', () => {
    expect(resolveAdapterOptions(Config(raw({})))).toEqual(defaults)
  })

  // Object.assign (not `{ ...defaults, override }`) so each test's override
  // is the only thing that varies; `defaults` itself is never mutated.
  const withOverride = (override: Partial<ConfigType>): ConfigType => Object.assign({}, defaults, override)

  it('rejects an empty binaryPath', () => {
    expect(() => resolveAdapterOptions(withOverride({ binaryPath: '' }))).toThrow(/binaryPath/)
  })

  it('rejects a non-integer printTimeoutSeconds', () => {
    expect(() => resolveAdapterOptions(withOverride({ printTimeoutSeconds: 1.5 }))).toThrow(/printTimeoutSeconds/)
  })

  it('rejects a non-positive defaultContextWindow', () => {
    expect(() => resolveAdapterOptions(withOverride({ defaultContextWindow: 0 }))).toThrow(/defaultContextWindow/)
  })

  it('rejects a non-positive defaultMaxTokens', () => {
    expect(() => resolveAdapterOptions(withOverride({ defaultMaxTokens: -1 }))).toThrow(/defaultMaxTokens/)
  })

  it('rejects an empty catalog model id', () => {
    expect(() => resolveAdapterOptions(withOverride({ models: [{ id: '' }] }))).toThrow(/non-empty/)
  })

  it('rejects an empty catalog model name', () => {
    expect(() => resolveAdapterOptions(withOverride({ models: [{ id: 'm', name: '' }] }))).toThrow(/empty name/)
  })

  it('rejects a non-positive catalog contextWindow', () => {
    expect(() => resolveAdapterOptions(withOverride({ models: [{ id: 'm', contextWindow: 0 }] }))).toThrow(/contextWindow/)
  })

  it('rejects a non-positive catalog maxTokens', () => {
    expect(() => resolveAdapterOptions(withOverride({ models: [{ id: 'm', maxTokens: 0 }] }))).toThrow(/maxTokens/)
  })

  it('rejects a duplicate catalog model id', () => {
    expect(() => resolveAdapterOptions(withOverride({ models: [{ id: 'm' }, { id: 'm' }] }))).toThrow(/duplicate/)
  })

  it('detaches an omitted-field model entry to only its declared keys', () => {
    expect(resolveAdapterOptions(withOverride({ models: [{ id: 'm' }] })).models).toEqual([{ id: 'm' }])
  })

  it('detaches a fully specified model entry with every field intact', () => {
    const models = resolveAdapterOptions(withOverride({
      models: [{ id: 'm', name: 'M', description: 'd', contextWindow: 100, maxTokens: 10 }],
    })).models
    expect(models).toEqual([{ id: 'm', name: 'M', description: 'd', contextWindow: 100, maxTokens: 10 }])
  })
})

describe('plugin registration', () => {
  it('registers the antigravity provider and unregisters on dispose (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const fiber = await ctx.plugin(LlmAntigravity, raw({}))
    expect(ctx.llm.listProviders()).toEqual([{ id: 'antigravity', name: 'Antigravity (agy)' }])
    await fiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('keeps internal helpers off the package root', () => {
    for (const helper of ['buildPrompt', 'parseToolCallResponse', 'spawnAgy']) {
      expect(LlmAntigravity).not.toHaveProperty(helper)
    }
  })
})
