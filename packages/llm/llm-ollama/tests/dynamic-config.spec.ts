import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import * as LlmOllama from '@deepseek-ai/dsh-llm-ollama'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textLines } from './mock-server.ts'

const NS = settingsNamespace('llm-ollama')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  await closeMockServers()
  vi.unstubAllEnvs()
})

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-ollama-dynamic-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

interface Harness {
  ctx: Context
  settingsFiber: { dispose(): Promise<void> }
}

/**
 * Real dynamic composition: llm + settings-file + llm-ollama over one temp
 * harness home. `watch: false` keeps every change flowing through the
 * in-process write path, which is deterministic; external file watching is the
 * provider's own covered concern.
 */
async function boot(dir: string, config: object): Promise<Harness> {
  vi.stubEnv('DSH_HOME', dir)
  const ctx = new Context()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
  })
  await ctx.plugin(LlmRuntime)
  const settingsFiber = ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
  await settingsFiber
  await ctx.plugin(LlmOllama, config)
  return { ctx, settingsFiber }
}

function prompt(ctx: Context) {
  return assemble(ctx, { model: 'moondream:latest', messages: [] })
}

describe('request-level dynamic configuration', () => {
  it('routes the next request with the freshly resolved base URL', async () => {
    const dir = await home()
    const serverA = await mockServer([{ kind: 'ndjson', lines: textLines }])
    const serverB = await mockServer([{ kind: 'ndjson', lines: textLines }])
    const { ctx } = await boot(dir, { baseURL: serverA.url })

    await prompt(ctx)
    expect(serverA.requests).toHaveLength(1)

    await ctx.settings.update(NS, { baseURL: serverB.url })

    await prompt(ctx)
    // No restart, no re-registration: the next request resolved the new endpoint.
    expect(serverA.requests).toHaveLength(1)
    expect(serverB.requests).toHaveLength(1)
  })

  it('advertises a live settings catalog without re-registration', async () => {
    const dir = await home()
    const { ctx } = await boot(dir, { baseURL: 'http://127.0.0.1:1' })

    await expect(ctx.llm.listModels('ollama')).resolves.toEqual([])
    await ctx.settings.update(NS, {
      models: [{ id: 'moondream:latest', name: 'Moondream', inputModalities: ['text', 'image'] }],
    })
    await expect(ctx.llm.listModels('ollama')).resolves.toEqual([{
      provider: 'ollama',
      id: 'moondream:latest',
      name: 'Moondream',
      inputModalities: ['text', 'image'],
    }])
  })

  it('re-registers the route in place when the captured retry policy changes, without an empty-registry window', async () => {
    const dir = await home()
    const { ctx } = await boot(dir, { baseURL: 'http://127.0.0.1:1' })

    // Observing the topology event, not just the end state: disposing and
    // re-registering also lands on the right final registry, but publishes an
    // empty route set in between, so an observer sees the provider disappear.
    const observed: string[][] = []
    ctx.on('llm/adapters-updated', () => {
      observed.push(ctx.llm.listProviders().map(provider => provider.id))
    })

    await ctx.settings.update(NS, {
      retryPolicy: { mode: 'always', backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 } },
    })
    expect(ctx.llm.providerRetryPolicy('ollama')).toEqual({
      mode: 'always',
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0.2,
    })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'ollama', name: 'Ollama' }])
    expect(observed).toEqual([['ollama']])
  })

  it('keeps the whole last-good snapshot when a rejected one changed the URL', async () => {
    const dir = await home()
    const good = await mockServer([{ kind: 'ndjson', lines: textLines }])
    const rejected = await mockServer([{ kind: 'ndjson', lines: textLines }])
    const { ctx } = await boot(dir, { baseURL: good.url })

    // Schema-valid but resolver-invalid: duplicate catalog ids pass the array
    // schema and fail the explicit resolve step, so the whole generation loses.
    await ctx.settings.update(NS, {
      baseURL: rejected.url,
      models: [{ id: 'dup' }, { id: 'dup' }],
    })

    await prompt(ctx)
    expect(rejected.requests).toHaveLength(0)
    expect(good.requests).toHaveLength(1)
    await expect(ctx.llm.listModels('ollama')).resolves.toEqual([])

    await ctx.settings.update(NS, { models: [{ id: 'recovered' }] })
    await expect(ctx.llm.listModels('ollama')).resolves.toEqual([
      { provider: 'ollama', id: 'recovered', name: 'recovered', inputModalities: ['text'] },
    ])
  })

  it('falls back to the composition entry when settings detach', async () => {
    const dir = await home()
    const serverA = await mockServer([{ kind: 'ndjson', lines: textLines }])
    const serverB = await mockServer([{ kind: 'ndjson', lines: textLines }])
    const { ctx, settingsFiber } = await boot(dir, { baseURL: serverA.url })

    await ctx.settings.update(NS, { baseURL: serverB.url })
    await prompt(ctx)
    expect(serverB.requests).toHaveLength(1)

    await settingsFiber.dispose()
    await prompt(ctx)
    expect(serverA.requests).toHaveLength(1)
  })
})
