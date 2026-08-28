/**
 * Real-composition guard for this adapter: LlmRuntime, settings-file, and
 * llm-ollama boot from a test-only cordis.yml through the actual Loader +
 * Include path, an external edit of settings.yaml hot-publishes through its
 * provider, and the very next request carries the fresh base URL. The same
 * adapter composition without a settings entry keeps entry-config behavior —
 * the documented optional-inject fallback.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import * as LlmOllama from '@deepseek-ai/dsh-llm-ollama'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textLines } from './mock-server.ts'

const NS = settingsNamespace('llm-ollama')

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  await closeMockServers()
  vi.unstubAllEnvs()
})

async function loadComposition(
  options: { withSettings: boolean; baseURL: string },
): Promise<{ ctx: Context; settingsPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-llm-ollama-composition-'))
  vi.stubEnv('DSH_HOME', root)
  const settingsPath = join(root, 'settings.yaml')
  if (options.withSettings) await writeFile(settingsPath, '# personal settings\n')

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: 'test-llm-service'",
    ...options.withSettings
      ? [
        '- id: settings',
        "  name: '@deepseek-ai/dsh-settings-file'",
        '  config:',
        `    path: ${JSON.stringify(settingsPath)}`,
        '    debounceMs: 10',
      ]
      : [],
    '- id: llm-ollama',
    "  name: '@deepseek-ai/dsh-llm-ollama'",
    '  config:',
    `    baseURL: ${JSON.stringify(options.baseURL)}`,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['@deepseek-ai/dsh-settings-file', FileSettingsProvider],
    ['@deepseek-ai/dsh-llm-ollama', LlmOllama],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return { ctx, settingsPath }
}

describe('llm-ollama real dynamic composition', () => {
  it('boots from cordis.yml and routes the next request after an external settings edit', async () => {
    const serverA = await mockServer([{ kind: 'ndjson', lines: textLines }])
    const serverB = await mockServer([{ kind: 'ndjson', lines: textLines }])
    const { ctx, settingsPath } = await loadComposition({ withSettings: true, baseURL: serverA.url })

    expect(ctx.get('settings')!.describe().map(entry => entry.ns)).toEqual([NS])
    expect(ctx.llm.listProviders()).toEqual([{ id: 'ollama', name: 'Ollama' }])
    const first = await assemble(ctx, { model: 'moondream:latest', messages: [] })
    expect(first.finish).toEqual({ kind: 'stop' })

    // An external edit, exactly as a user or the web UI would leave it on disk.
    await writeFile(settingsPath, `llm-ollama:\n  baseURL: ${serverB.url}\n`)
    await vi.waitFor(() => {
      expect((ctx.get('settings')!.get(NS) as { baseURL?: string }).baseURL).toBe(serverB.url)
    }, { timeout: 5000 })

    await assemble(ctx, { model: 'moondream:latest', messages: [] })
    expect(serverA.requests).toHaveLength(1)
    expect(serverB.requests).toHaveLength(1)
  })

  it('boots the same adapter on entry config alone', async () => {
    const server = await mockServer([{ kind: 'ndjson', lines: textLines }])
    const { ctx } = await loadComposition({ withSettings: false, baseURL: server.url })

    expect(ctx.get('settings')).toBeUndefined()
    expect(ctx.get('attachments')).toBeUndefined()
    const result = await assemble(ctx, { model: 'moondream:latest', messages: [] })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
  })
})
