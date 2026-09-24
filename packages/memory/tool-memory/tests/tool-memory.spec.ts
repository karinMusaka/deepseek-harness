import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { PromptContext } from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import MemoryService from '@deepseek-ai/dsh-memory'
import * as ToolMemory from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** Boot the real storage/domain/memory/tool composition over an in-memory backend. */
async function harness(config: Partial<Config> = {}) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(MemoryService)

  const tools = new Map<string, ToolDefinition>()
  ctx.provide('tools', { register: (t: ToolDefinition) => {
    tools.set(t.name, t)
    return () => tools.delete(t.name)
  } } as never)

  const contexts: PromptContext[] = []
  ctx.provide('systemPrompt', { context: (c: PromptContext) => {
    contexts.push(c)
    return () => {}
  } } as never)

  await ctx.plugin(ToolMemory, { contextLimit: 10, maxRecallLimit: 50, ...config })
  return { ctx, tools, contexts }
}

/** A fake execution context for one tool call: `agent` in a project, or none. */
function execOf(cwd?: string): ToolRunContext {
  return (cwd === undefined
    ? { agent: undefined }
    : { agent: { session: { header: { cwd } } } as unknown as Agent }) as unknown as ToolRunContext
}

describe('memory_remember', () => {
  it('stores under the current project scope when run inside an agent', async () => {
    const { ctx, tools } = await harness()
    const result = await tools.get('memory_remember')!.execute(
      { content: 'writes tests first', kind: 'preference' }, execOf('/tmp/demo'),
    ) as { ok: boolean; id: string; scope: string; message: string }
    expect(result.ok).toBe(true)
    expect(result.scope).toBe('project:/tmp/demo')
    expect(result.message).toContain('in project:/tmp/demo')
    expect(ctx.memory.get(result.id as never)?.scope).toBe('project:/tmp/demo')
  })

  it('stores personal memory outside an agent context', async () => {
    const { tools } = await harness()
    const result = await tools.get('memory_remember')!.execute(
      { content: 'personal fact', kind: 'fact' }, execOf(),
    ) as { ok: boolean; scope: string; message: string }
    expect(result.scope).toBe('user')
    expect(result.message).toContain('(user)')
  })

  it('honors an explicit "user" scope even inside a project agent', async () => {
    const { tools } = await harness()
    const result = await tools.get('memory_remember')!.execute(
      { content: 'personal even in project', kind: 'fact', scope: 'user' }, execOf('/tmp/demo'),
    ) as { scope: string }
    expect(result.scope).toBe('user')
  })

  it('defaults tags to an empty array when omitted', async () => {
    const { ctx, tools } = await harness()
    const result = await tools.get('memory_remember')!.execute(
      { content: 'no tags given', kind: 'note' }, execOf(),
    ) as { id: string }
    expect(ctx.memory.get(result.id as never)?.tags).toEqual([])
  })

})

describe('memory_remember presentation and output', () => {
  it('renders a generic call view carrying the content', async () => {
    const { tools } = await harness()
    const tool = tools.get('memory_remember')!
    const view = tool.presentCall!({ content: 'hello', kind: 'note' })
    expect(view).toEqual({ card: 'generic', title: 'Remember', rawInput: 'hello' })
  })

  it('renders output as one JSON text block', async () => {
    const { tools } = await harness()
    const tool = tools.get('memory_remember')!
    const value = { ok: true, id: 'x', scope: 'user', message: 'Stored.' }
    expect(tool.output.render({ content: 'hello', kind: 'note' }, value)).toEqual([
      { type: 'text', text: JSON.stringify(value) },
    ])
  })
})

describe('memory_recall', () => {
  it('defaults scope to the current project, which also surfaces user memory', async () => {
    const { ctx, tools } = await harness()
    const user = await ctx.memory.remember({ scope: 'user', kind: 'fact', content: 'personal fact' })
    await ctx.memory.remember({ scope: 'project:/tmp/demo', kind: 'fact', content: 'project fact' })
    const result = await tools.get('memory_recall')!.execute({}, execOf('/tmp/demo')) as { memories: { id: string }[] }
    expect(result.memories.some(m => m.id === user.id)).toBe(true)
    expect(result.memories.length).toBe(2)
  })

  it('defaults scope to personal memory outside an agent context', async () => {
    const { ctx, tools } = await harness()
    await ctx.memory.remember({ scope: 'user', kind: 'fact', content: 'personal fact' })
    await ctx.memory.remember({ scope: 'project:/tmp/demo', kind: 'fact', content: 'project fact' })
    const result = await tools.get('memory_recall')!.execute({}, execOf()) as { memories: { content: string }[] }
    expect(result.memories.map(m => m.content)).toEqual(['personal fact'])
  })

  it('an explicit "user" scope excludes project memory even inside an agent', async () => {
    const { ctx, tools } = await harness()
    await ctx.memory.remember({ scope: 'user', kind: 'fact', content: 'personal fact' })
    await ctx.memory.remember({ scope: 'project:/tmp/demo', kind: 'fact', content: 'project fact' })
    const result = await tools.get('memory_recall')!.execute(
      { scope: 'user' }, execOf('/tmp/demo'),
    ) as { memories: { content: string }[] }
    expect(result.memories.map(m => m.content)).toEqual(['personal fact'])
  })

  it('filters by free text and by kind', async () => {
    const { ctx, tools } = await harness()
    await ctx.memory.remember({ scope: 'user', kind: 'fact', content: 'writes tests' })
    await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'writes docs' })
    const result = await tools.get('memory_recall')!.execute(
      { text: 'writes', kind: 'fact' }, execOf(),
    ) as { memories: { content: string }[] }
    expect(result.memories.map(m => m.content)).toEqual(['writes tests'])
  })

  it('clamps a negative model-supplied limit up to 1', async () => {
    const { ctx, tools } = await harness()
    await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'a' })
    await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'b' })
    const result = await tools.get('memory_recall')!.execute(
      { limit: -5 }, execOf(),
    ) as { memories: unknown[] }
    expect(result.memories.length).toBe(1)
  })

  it('clamps a model-supplied limit down to maxRecallLimit', async () => {
    const { ctx, tools } = await harness({ maxRecallLimit: 2 })
    await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'a' })
    await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'b' })
    await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'c' })
    const result = await tools.get('memory_recall')!.execute(
      { limit: 100 }, execOf(),
    ) as { memories: unknown[] }
    expect(result.memories.length).toBe(2)
  })

  it('passes a valid in-range limit through unclamped', async () => {
    const { ctx, tools } = await harness()
    await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'a' })
    await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'b' })
    await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'c' })
    const result = await tools.get('memory_recall')!.execute(
      { limit: 2 }, execOf(),
    ) as { memories: unknown[] }
    expect(result.memories.length).toBe(2)
  })

  it('touches every surfaced hit, raising its future rank', async () => {
    const { ctx, tools } = await harness()
    const entry = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'recall me' })
    expect(ctx.memory.get(entry.id)?.accessCount).toBe(0)
    await tools.get('memory_recall')!.execute({}, execOf())
    expect(ctx.memory.get(entry.id)?.accessCount).toBe(1)
  })

  it('presents the call with its search text as raw input', async () => {
    const { tools } = await harness()
    const view = tools.get('memory_recall')!.presentCall!({ text: 'foo' })
    expect(view).toEqual({ card: 'generic', title: 'Recall', rawInput: 'foo' })
  })

  it('presents a call with no search text without raw input', async () => {
    const { tools } = await harness()
    const view = tools.get('memory_recall')!.presentCall!({})
    expect(view).toEqual({ card: 'generic', title: 'Recall' })
  })

  it('renders output as one JSON text block', async () => {
    const { tools } = await harness()
    const value = { memories: [], total: 0 }
    expect(tools.get('memory_recall')!.output.render({}, value)).toEqual([
      { type: 'text', text: JSON.stringify(value) },
    ])
  })
})

describe('memory_list', () => {
  it('lists the current project scope when run inside an agent', async () => {
    const { ctx, tools } = await harness()
    await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'personal' })
    await ctx.memory.remember({ scope: 'project:/tmp/demo', kind: 'note', content: 'project' })
    const result = await tools.get('memory_list')!.execute({}, execOf('/tmp/demo')) as { memories: string[] }
    expect(result.memories.length).toBe(1)
    expect(result.memories[0]).toContain('project')
  })

  it('lists personal memory outside an agent context', async () => {
    const { ctx, tools } = await harness()
    await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'personal' })
    await ctx.memory.remember({ scope: 'project:/tmp/demo', kind: 'note', content: 'project' })
    const result = await tools.get('memory_list')!.execute({}, execOf()) as { memories: string[] }
    expect(result.memories.length).toBe(1)
    expect(result.memories[0]).toContain('personal')
  })

  it('restricts to a given kind', async () => {
    const { ctx, tools } = await harness()
    await ctx.memory.remember({ scope: 'user', kind: 'fact', content: 'a fact' })
    await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'a note' })
    const result = await tools.get('memory_list')!.execute({ kind: 'fact' }, execOf()) as { memories: string[] }
    expect(result.memories.length).toBe(1)
    expect(result.memories[0]).toContain('a fact')
  })

  it('presents the call with a fixed title', async () => {
    const { tools } = await harness()
    const view = tools.get('memory_list')!.presentCall!({})
    expect(view).toEqual({ card: 'generic', title: 'List memories' })
  })

  it('renders output as one JSON text block', async () => {
    const { tools } = await harness()
    const value = { memories: ['- line'] }
    expect(tools.get('memory_list')!.output.render({}, value)).toEqual([
      { type: 'text', text: JSON.stringify(value) },
    ])
  })
})

describe('memory_forget', () => {
  it('reports no memory for an unknown id', async () => {
    const { tools } = await harness()
    const result = await tools.get('memory_forget')!.execute({ id: 'ghost' }, execOf()) as { ok: boolean; message: string }
    expect(result).toEqual({ ok: false, message: 'No memory with that id.' })
  })

  it('deletes an entry within the caller scope', async () => {
    const { ctx, tools } = await harness()
    const entry = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'mine' })
    const result = await tools.get('memory_forget')!.execute({ id: entry.id }, execOf()) as { ok: boolean; message: string }
    expect(result).toEqual({ ok: true, message: 'Memory deleted.' })
    expect(ctx.memory.has(entry.id)).toBe(false)
  })

  it('blocks deleting an entry that belongs to another project', async () => {
    const { ctx, tools } = await harness()
    const other = await ctx.memory.remember({ scope: 'project:/other', kind: 'note', content: 'foreign' })
    const result = await tools.get('memory_forget')!.execute({ id: other.id }, execOf('/tmp/demo')) as { ok: boolean; message: string }
    expect(result.ok).toBe(false)
    expect(result.message).toContain('another project')
    expect(ctx.memory.has(other.id)).toBe(true)
  })

  it('presents the call with the target id as raw input', async () => {
    const { tools } = await harness()
    const view = tools.get('memory_forget')!.presentCall!({ id: 'abc' })
    expect(view).toEqual({ card: 'generic', title: 'Forget memory', rawInput: 'abc' })
  })

  it('renders output as one JSON text block', async () => {
    const { tools } = await harness()
    const value = { ok: true, message: 'Memory deleted.' }
    expect(tools.get('memory_forget')!.output.render({ id: 'x' }, value)).toEqual([
      { type: 'text', text: JSON.stringify(value) },
    ])
  })
})

describe('memory_edit', () => {
  it('reports no memory for an unknown id', async () => {
    const { tools } = await harness()
    const result = await tools.get('memory_edit')!.execute({ id: 'ghost' }, execOf()) as { ok: boolean; message: string }
    expect(result).toEqual({ ok: false, message: 'No memory with that id.' })
  })

  it('replaces content only', async () => {
    const { ctx, tools } = await harness()
    const entry = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'old', tags: ['keep'] })
    const result = await tools.get('memory_edit')!.execute(
      { id: entry.id, content: 'new' }, execOf(),
    ) as { ok: boolean; message: string }
    expect(result).toEqual({ ok: true, message: 'Memory updated.' })
    expect(ctx.memory.get(entry.id)).toMatchObject({ content: 'new', tags: ['keep'] })
  })

  it('replaces tags only', async () => {
    const { ctx, tools } = await harness()
    const entry = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'stable', tags: ['old'] })
    const result = await tools.get('memory_edit')!.execute(
      { id: entry.id, tags: ['new'] }, execOf(),
    ) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(ctx.memory.get(entry.id)).toMatchObject({ content: 'stable', tags: ['new'] })
  })

  it('blocks editing an entry that belongs to another project', async () => {
    const { ctx, tools } = await harness()
    const other = await ctx.memory.remember({ scope: 'project:/other', kind: 'note', content: 'foreign' })
    const result = await tools.get('memory_edit')!.execute(
      { id: other.id, content: 'tampered' }, execOf('/tmp/demo'),
    ) as { ok: boolean; message: string }
    expect(result.ok).toBe(false)
    expect(result.message).toContain('another project')
    expect(ctx.memory.get(other.id)?.content).toBe('foreign')
  })

  it('presents the call with the target id as raw input', async () => {
    const { tools } = await harness()
    const view = tools.get('memory_edit')!.presentCall!({ id: 'abc' })
    expect(view).toEqual({ card: 'generic', title: 'Edit memory', rawInput: 'abc' })
  })

  it('renders output as one JSON text block', async () => {
    const { tools } = await harness()
    const value = { ok: true, message: 'Memory updated.' }
    expect(tools.get('memory_edit')!.output.render({ id: 'x' }, value)).toEqual([
      { type: 'text', text: JSON.stringify(value) },
    ])
  })
})

describe('runtime-context contribution', () => {
  it('registers a context named tool:memory when contextLimit is nonzero', async () => {
    const { contexts } = await harness()
    expect(contexts).toHaveLength(1)
    expect(contexts[0]).toMatchObject({ name: 'tool:memory', order: 117, interpolate: false })
  })

  it('registers no context contribution when contextLimit is 0', async () => {
    const { contexts } = await harness({ contextLimit: 0 })
    expect(contexts).toHaveLength(0)
  })

  it('renders empty without an agent', async () => {
    const { contexts } = await harness()
    const text = contexts[0]!.text as (context: { agent?: Agent }) => string
    expect(text({})).toBe('')
  })

  it('renders empty with an agent but no stored memory', async () => {
    const { contexts } = await harness()
    const text = contexts[0]!.text as (context: { agent?: Agent }) => string
    const agent = { session: { header: { cwd: '/tmp/demo' } } } as unknown as Agent
    expect(text({ agent })).toBe('')
  })

  it('renders entry lines with tags and the entry id when memory exists', async () => {
    const { ctx, contexts } = await harness()
    await ctx.memory.remember({ scope: 'project:/tmp/demo', kind: 'preference', content: 'writes tests', tags: ['tdd'] })
    const text = contexts[0]!.text as (context: { agent?: Agent }) => string
    const agent = { session: { header: { cwd: '/tmp/demo' } } } as unknown as Agent
    const rendered = text({ agent })
    expect(rendered).toContain('Stored memory about the user and this project')
    expect(rendered).toMatch(/- \[preference] project:\/tmp\/demo \[tdd]: writes tests {2}\(id: .+\)/)
  })

  it('renders an entry line without a tag bracket when the entry has no tags', async () => {
    const { ctx, contexts } = await harness()
    await ctx.memory.remember({ scope: 'project:/tmp/demo', kind: 'note', content: 'no tags here' })
    const text = contexts[0]!.text as (context: { agent?: Agent }) => string
    const agent = { session: { header: { cwd: '/tmp/demo' } } } as unknown as Agent
    const rendered = text({ agent })
    expect(rendered).toMatch(/- \[note] project:\/tmp\/demo: no tags here {2}\(id: .+\)/)
  })

  it('respects contextLimit when more memories are stored than fit', async () => {
    const { ctx, contexts } = await harness({ contextLimit: 1 })
    await ctx.memory.remember({ scope: 'project:/tmp/demo', kind: 'note', content: 'first' })
    await ctx.memory.remember({ scope: 'project:/tmp/demo', kind: 'note', content: 'second' })
    const text = contexts[0]!.text as (context: { agent?: Agent }) => string
    const agent = { session: { header: { cwd: '/tmp/demo' } } } as unknown as Agent
    const rendered = text({ agent })
    const lines = rendered.split('\n').filter(line => line.startsWith('- '))
    expect(lines).toHaveLength(1)
  })
})

describe('project scope fallback', () => {
  it('falls back to process.cwd() when the agent session has no cwd', async () => {
    const { tools } = await harness()
    const exec = { agent: { session: { header: {} } } as unknown as Agent } as unknown as ToolRunContext
    const result = await tools.get('memory_remember')!.execute(
      { content: 'no explicit cwd', kind: 'note' }, exec,
    ) as { scope: string }
    expect(result.scope).toBe(`project:${process.cwd()}`)
  })
})
