/**
 * Real-composition guard: the tool registry, the local filesystem, the local
 * attachment store, `llm-ollama`, and this package boot from a test-only
 * cordis.yml through the actual Loader + Include path, and one model-issued
 * `classify_image` call travels the complete production path — durable image
 * commit, the Ollama wire request carrying base64 image bytes, and the text
 * labels returned to the calling model. Only the Ollama HTTP endpoint is
 * mocked.
 *
 * The composition also proves the negative contract the tool exists for: after
 * a successful call the calling session's log holds no image content, so no
 * later request on a text-only route can replay one.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { CallId, LlmRuntime } from '@deepseek-ai/dsh-llm'
import * as LlmOllama from '@deepseek-ai/dsh-llm-ollama'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolClassifyImage from '../src/index.ts'
import { closeMockOllamaServers, mockOllamaServer } from './mock-ollama.ts'

/** 1x1 red PNG (valid signature, IHDR, IDAT, IEND). */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
)

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  await closeMockOllamaServers()
  vi.unstubAllEnvs()
})

/**
 * Boot the composition from a real cordis.yml.
 * @param options - the mock endpoint, the workspace, and the vision catalog's
 *   declared input modalities (`[text]` proves the modality gate is real).
 * @returns the booted context.
 */
async function boot(options: { baseURL: string; workspace: string; modalities: string }): Promise<Context> {
  const configPath = join(root!, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    '  config:',
    '    mode: native',
    "- name: '@deepseek-ai/dsh-fs-local'",
    '  config:',
    `    cwd: ${JSON.stringify(options.workspace)}`,
    "- name: '@deepseek-ai/dsh-attachment-local'",
    '  config:',
    `    dshHome: ${JSON.stringify(root!)}`,
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-llm-ollama'",
    '  config:',
    `    baseURL: ${JSON.stringify(options.baseURL)}`,
    '    models:',
    '      - id: minicpm-v:latest',
    `        inputModalities: ${options.modalities}`,
    "- name: '@deepseek-ai/dsh-tool-classify-image'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root!).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
    ['@deepseek-ai/dsh-attachment-local', LocalAttachmentStore],
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-llm-ollama', LlmOllama],
    ['@deepseek-ai/dsh-tool-classify-image', ToolClassifyImage],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

/** A calling agent whose real session records the pre-dispatch event. */
function agentIn(workspace: string): { id: SessionId; options: object; session: Session } {
  const id = SessionId('classify-composition')
  const header: SessionHeader = { version: 0, id, createdAt: Date.now(), cwd: workspace }
  const session = Session.create(id, undefined, header)
  return { id, options: {}, session }
}

async function workspaceWithImage(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-classify-composition-'))
  vi.stubEnv('DSH_HOME', root)
  const workspace = join(root, 'workspace')
  await rm(workspace, { recursive: true, force: true })
  await writeFile(join(root, 'placeholder'), '')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'subject.png'), PNG_1X1)
  return workspace
}

describe('tool-classify-image real Loader composition through cordis.yml', () => {
  it('relays one local image to Ollama and returns labels without logging the image', async () => {
    const workspace = await workspaceWithImage()
    const server = await mockOllamaServer([
      'This is a digital illustration drawn in an anime style.',
      'The character appears to be a young woman.',
    ])
    const ctx = await boot({ baseURL: server.url, workspace, modalities: '[text, image]' })
    const agent = agentIn(workspace)

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('composition-classify'),
      name: 'classify_image',
      arguments: { path: 'subject.png' },
      agent: agent as never,
    })

    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ type: 'illustration', gender: 'female' })

    // The real adapter resolved the durable attachment into base64 wire bytes
    // for both questions — the image reached the vision model.
    expect(server.requests).toHaveLength(2)
    expect(server.requests[0]!.model).toBe('minicpm-v:latest')
    expect(server.requests[0]!.messages[0]!.images).toEqual([PNG_1X1.toString('base64')])
    expect(server.requests[0]!.messages[0]!.content).toContain('real photograph')
    expect(server.requests[1]!.messages[0]!.content).toContain('apparent gender')

    // The only trace in the calling session is the log-only record; no message
    // event ever carried the image, so a later text-only request stays valid.
    expect(agent.session.events.map(event => event.type)).toEqual(['tool-classify-image/request'])
  }, 30_000)

  it('refuses when the composed catalog declares the vision model text-only', async () => {
    const workspace = await workspaceWithImage()
    const server = await mockOllamaServer([])
    const ctx = await boot({ baseURL: server.url, workspace, modalities: '[text]' })

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('composition-refusal'),
      name: 'classify_image',
      arguments: { path: 'subject.png' },
      agent: agentIn(workspace) as never,
    })

    expect(result.isError).toBe(true)
    expect(result.content.filter(block => block.type === 'text').map(block => block.text).join(''))
      .toContain('does not declare image input')
    expect(server.requests).toHaveLength(0)
  }, 30_000)

  it('fails loading when provider is configured without model', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-classify-composition-bad-'))
    vi.stubEnv('DSH_HOME', root)
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-fs-local'",
      "- name: '@deepseek-ai/dsh-attachment-local'",
      '  config:',
      `    dshHome: ${JSON.stringify(root)}`,
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-tool-classify-image'",
      '  config:',
      '    provider: ollama',
      '',
    ].join('\n'))

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
      ['@deepseek-ai/dsh-attachment-local', LocalAttachmentStore],
      ['@deepseek-ai/dsh-llm', LlmRuntime],
      ['@deepseek-ai/dsh-tool-classify-image', ToolClassifyImage],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    // The policy is self-contained, so misconfiguration fails at load: the
    // entry's apply rejects and boot never reaches a registered tool.
    await expect(ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } }))
      .rejects.toThrow('provider and model must be supplied together')
    expect(ctx.get('tools')?.get('classify_image')).toBeUndefined()
  }, 30_000)
})
