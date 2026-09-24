// REAL-composition coverage: a test-only cordis.yml boots the storage stack,
// cross-session memory service, and dsh-tool-memory through the vendored
// Loader, and the assertions observe durable/model-visible output — the five
// registered memory tools, an assembled prompt context reflecting a stored
// memory entry, the `contextLimit: 0` opt-out, and that disabling the
// tool-memory entry removes both its tools and its `tool:memory` prompt
// context again (HMR safety).
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Inbox, assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import MemoryService from '@deepseek-ai/dsh-memory'
import * as ToolMemory from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  // maxRetries absorbs a straggling debounced config-file write triggered by
  // disabling the tool-memory entry below (Loader persistence, not this
  // package's) racing the temp-dir removal.
  if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  root = undefined
})

/** A hand-registered Agent with a real project-scoped session, mirroring the loop's own registration. */
function agent(ctx: Context, cwd: string): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId(`tool-memory-loader-agent-${cwd}`)
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd })
  const value: Agent = {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: scope.ctx,
    followup: () => {},
    steer: () => {},
    inject: () => {},
    send: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

/** Boot a cordis.yml carrying storage + cross-session memory + tool-memory with the given contextLimit. */
async function boot(contextLimit: number): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-tool-memory-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-sqlite'",
    '  config:',
    "    path: ':memory:'",
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: sqlite',
    "- name: '@deepseek-ai/dsh-memory'",
    "- name: '@deepseek-ai/dsh-tool-memory'",
    '  config:',
    `    contextLimit: ${contextLimit}`,
    '    maxRecallLimit: 50',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-sqlite', StorageSqlite],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-memory', MemoryService],
    ['@deepseek-ai/dsh-tool-memory', ToolMemory],
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

describe('tool-memory real Loader composition through cordis.yml', () => {
  it('registers the five memory tools and mounts the cross-session memory service', async () => {
    const ctx = await boot(10)
    expect(ctx.memory).toBeDefined()
    const names = ctx.tools.schemas().map(schema => schema.name).sort()
    expect(names).toEqual(['memory_edit', 'memory_forget', 'memory_list', 'memory_recall', 'memory_remember'])
  }, 30_000)

  it('assembles a stored project memory entry into the runtime-context snapshot for an agent', async () => {
    const ctx = await boot(10)
    const owner = agent(ctx, join(root!, 'project'))
    await ctx.memory.remember({
      scope: `project:${owner.session.header.cwd}`,
      kind: 'preference',
      content: 'Prefers pnpm over npm',
      tags: ['tooling'],
    })

    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(owner))
    const memoryContext = assembly.contexts.find(entry => entry.name === 'tool:memory')
    expect(memoryContext).toBeDefined()
    expect(memoryContext!.interpolate).toBe(false)
    expect(memoryContext!.text).toContain('Stored memory about the user and this project')
    expect(memoryContext!.text).toContain('Prefers pnpm over npm')
  }, 30_000)

  it('registers no runtime-context contribution when contextLimit is 0', async () => {
    const ctx = await boot(0)
    const owner = agent(ctx, join(root!, 'project'))
    await ctx.memory.remember({
      scope: `project:${owner.session.header.cwd}`,
      kind: 'note',
      content: 'should never surface',
    })

    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(owner))
    expect(assembly.contexts.find(entry => entry.name === 'tool:memory')).toBeUndefined()
  }, 30_000)

  it('HMR safety: disabling the tool-memory entry removes its tools and prompt context', async () => {
    const ctx = await boot(10)
    const owner = agent(ctx, join(root!, 'project'))
    await ctx.memory.remember({
      scope: `project:${owner.session.header.cwd}`,
      kind: 'fact',
      content: 'HMR probe entry',
    })

    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('memory_remember')
    const before = await ctx.systemPrompt.assemble(assembleContextFor(owner))
    expect(before.contexts.some(entry => entry.name === 'tool:memory')).toBe(true)

    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === '@deepseek-ai/dsh-tool-memory')
    expect(entry).toBeDefined()
    await entry!.fiber!.dispose()

    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).not.toContain('memory_remember')
    expect(names).not.toContain('memory_recall')
    expect(names).not.toContain('memory_list')
    expect(names).not.toContain('memory_forget')
    expect(names).not.toContain('memory_edit')

    const after = await ctx.systemPrompt.assemble(assembleContextFor(owner))
    expect(after.contexts.some(entryContext => entryContext.name === 'tool:memory')).toBe(false)

    // The underlying cross-session memory service is untouched by disposing
    // its model-facing Consumer — only the tool/context registrations unwind.
    expect(ctx.memory.recall({ scope: `project:${owner.session.header.cwd}` }).some(hit => hit.content === 'HMR probe entry')).toBe(true)
  }, 30_000)
})
