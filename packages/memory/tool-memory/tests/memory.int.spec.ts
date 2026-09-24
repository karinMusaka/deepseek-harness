import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import MemoryService from '@deepseek-ai/dsh-memory'
import * as ToolMemory from '@deepseek-ai/dsh-tool-memory'

/** Boot the real storage/domain/memory composition over an in-memory backend. */
async function harness() {
  const pool = new MemoryMediaPool()
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  return { ctx, pool }
}

describe('cross-session memory', () => {
  it('opens the domain and persists personal + project memory', async () => {
    const { ctx } = await harness()
    await ctx.plugin(MemoryService)
    expect(ctx.memory).toBeDefined()

    const personal = await ctx.memory.remember({
      scope: 'user', kind: 'preference', content: 'Always write tests first',
    })
    const proj = await ctx.memory.remember({
      scope: 'project:/tmp/demo', kind: 'fact', content: 'Uses pnpm workspace',
    })
    expect(personal.id).toBeTruthy()
    expect(proj.scope).toBe('project:/tmp/demo')

    // recall within a project scope surfaces the matching project + user memory
    const hits = ctx.memory.recall({ scope: 'project:/tmp/demo', text: 'tests' })
    expect(hits.some(h => h.content.includes('tests first'))).toBe(true)

    // list project scope
    expect(ctx.memory.list('project:/tmp/demo').length).toBe(1)

    // edit + forget
    await ctx.memory.edit(proj.id, { content: 'Uses pnpm + npm workspaces' })
    expect(ctx.memory.get(proj.id)?.content).toContain('npm')
    await ctx.memory.forget(proj.id)
    expect(ctx.memory.has(proj.id)).toBe(false)
  })

  it('registers the memory tools against a real memory service', async () => {
    const { ctx } = await harness()
    await ctx.plugin(MemoryService)
    const registered: string[] = []
    ctx.provide('tools', { register: (t: { name: string }) => { registered.push(t.name); return () => {} } })
    ctx.provide('systemPrompt', { context: () => () => {} })
    await ctx.plugin(ToolMemory, { contextLimit: 10, maxRecallLimit: 50 })
    expect(registered).toContain('memory_remember')
    expect(registered).toContain('memory_recall')
    expect(registered).toContain('memory_list')
    expect(registered).toContain('memory_forget')
    expect(registered).toContain('memory_edit')
  })

  it('project recall surfaces user + project memory without duplication', async () => {
    const { ctx } = await harness()
    await ctx.plugin(MemoryService)
    const user = await ctx.memory.remember({ scope: 'user', kind: 'preference', content: 'Prefers TypeScript' })
    await ctx.memory.remember({ scope: 'project:/tmp/demo', kind: 'fact', content: 'Uses pnpm' })

    // project recall includes the user entry exactly once
    const hits = ctx.memory.recall({ scope: 'project:/tmp/demo' })
    expect(hits.some(h => h.id === user.id)).toBe(true)
    expect(hits.filter(h => h.id === user.id).length).toBe(1)

    // user-only recall excludes project entries
    const personal = ctx.memory.recall({ scope: 'user' })
    expect(personal.every(h => h.scope === 'user')).toBe(true)
  })

  it('touch ranks a recalled entry higher on the next recall', async () => {
    const { ctx } = await harness()
    await ctx.plugin(MemoryService)
    const a = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'older note' })
    const b = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'frequently recalled' })
    expect(ctx.memory.get(a.id)?.accessCount).toBe(0)

    await ctx.memory.touch(b.id)
    await ctx.memory.touch(b.id)
    expect(ctx.memory.get(b.id)?.accessCount).toBe(2)

    // b (higher accessCount) ranks above a (newer but never touched)
    const ranked = ctx.memory.recall({ scope: 'user' })
    expect(ranked[0]?.id).toBe(b.id)
  })

  it('rejects empty-content writes so the domain can never be poisoned on reopen', async () => {
    const { ctx } = await harness()
    await ctx.plugin(MemoryService)
    await expect(ctx.memory.remember({
      scope: 'user', kind: 'note', content: '   ',
    })).rejects.toThrow(/empty/)

    const good = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'fine' })
    await expect(ctx.memory.edit(good.id, { content: '  ' })).rejects.toThrow(/empty/)
    // unchanged content survives an empty-tag edit
    await ctx.memory.edit(good.id, { tags: [] })
    expect(ctx.memory.get(good.id)?.content).toBe('fine')
  })

  it('forget/edit respect the caller project scope', async () => {
    const { ctx } = await harness()
    await ctx.plugin(MemoryService)
    // an entry owned by another project and one owned by the caller (no agent → user)
    const other = await ctx.memory.remember({ scope: 'project:/other', kind: 'note', content: 'foreign' })
    const mine = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'mine' })

    // register tools and capture the definitions so we can drive execute() directly
    const tools: Record<string, { execute(...args: unknown[]): Promise<{ ok: boolean; message: string }> }> = {}
    ctx.provide('tools', { register: (t: { name: string }) => {
      tools[t.name] = t as never
      return () => {}
    } })
    ctx.provide('systemPrompt', { context: () => () => {} })
    await ctx.plugin(ToolMemory, { contextLimit: 10, maxRecallLimit: 50 })

    const noAgent = { agent: undefined } as never
    const forget = tools.memory_forget!
    const edit = tools.memory_edit!
    // foreign project entry is out of the caller's scope → blocked
    expect((await forget.execute({ id: other.id }, noAgent)).ok).toBe(false)
    expect((await edit.execute({ id: other.id, content: 'tampered' }, noAgent)).ok).toBe(false)
    expect(ctx.memory.get(other.id)?.content).toBe('foreign')
    // own (user) entry is allowed
    expect((await forget.execute({ id: mine.id }, noAgent)).ok).toBe(true)
    expect(ctx.memory.has(mine.id)).toBe(false)
  })
})
