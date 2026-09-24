/**
 * Real-composition guard: LlmRuntime and llm-antigravity boot from a
 * test-only cordis.yml through the actual Loader, and a request through
 * `ctx.llm.stream()` reaches the fake agy binary and comes back assembled.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmAntigravity from '../src/index.ts'
import { installFakeAgy } from './support/fake-agy.ts'
import type { FakeAgy } from './support/fake-agy.ts'

let root: string | undefined
let context: Context | undefined
let fake: FakeAgy | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  await fake?.cleanup()
  fake = undefined
})

async function loadComposition(binaryPath: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-llm-antigravity-composition-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: 'test-llm-service'",
    '- id: llm-antigravity',
    "  name: '@deepseek-ai/dsh-llm-antigravity'",
    '  config:',
    `    binaryPath: ${JSON.stringify(binaryPath)}`,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['@deepseek-ai/dsh-llm-antigravity', LlmAntigravity],
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
  return ctx
}

describe('llm-antigravity real composition', () => {
  it('boots from cordis.yml and answers a request through the fake agy binary', async () => {
    fake = await installFakeAgy()
    const ctx = await loadComposition(fake.binaryPath)

    expect(ctx.llm.listProviders()).toEqual([{ id: 'antigravity', name: 'Antigravity (agy)' }])

    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({
      provider: 'antigravity',
      model: 'text-stream',
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] })],
    })) assembler.push(chunk)

    expect(assembler.finish).toEqual({ kind: 'stop' })
    expect(assembler.message({ kind: 'model', provider: 'antigravity', model: 'text-stream' }).content).toEqual([
      { type: 'text', text: 'Hello, world!' },
    ])
  })
})
