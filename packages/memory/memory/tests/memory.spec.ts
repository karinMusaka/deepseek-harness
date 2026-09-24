import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import MemoryService, { MemoryId } from '../src/index.ts'

/** Boot the real storage/domain/memory composition over an in-memory backend. */
async function harness(pool: MemoryMediaPool = new MemoryMediaPool()) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(MemoryService)
  return { ctx, pool, fiber }
}

describe('MemoryId', () => {
  it('brands a plain string without transforming it', () => {
    expect(MemoryId('abc-123')).toBe('abc-123')
  })
})

describe('MemoryService lifecycle', () => {
  it('rejects a mutation attempted before the domain has opened', async () => {
    const service = new MemoryService(new Context())
    await expect(service.remember({ scope: 'user', kind: 'note', content: 'x' }))
      .rejects.toThrow(/not started yet/)
    const internals = service as unknown as { requireTable(): unknown }
    expect(() => internals.requireTable()).toThrow(/not started yet/)
  })

  it('persists entries across a reopened service over the same media', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const entry = await first.ctx.memory.remember({ scope: 'user', kind: 'fact', content: 'survives reopen' })
    // A project-scoped entry forces the durable schema to re-validate the
    // `project:<path>` scope branch (not just the `user` literal) on reopen.
    const project = await first.ctx.memory.remember({
      scope: 'project:/tmp/demo', kind: 'fact', content: 'project entry survives reopen',
    })
    await first.fiber.dispose()

    const second = await harness(pool)
    expect(second.ctx.memory.get(entry.id)?.content).toBe('survives reopen')
    expect(second.ctx.memory.get(project.id)?.scope).toBe('project:/tmp/demo')
    await second.fiber.dispose()
  })
})

describe('remember', () => {
  it('trims content and mints an entry with zeroed access counters', async () => {
    const { ctx, fiber } = await harness()
    const entry = await ctx.memory.remember({ scope: 'user', kind: 'note', content: '  hello  ', tags: ['a'] })
    expect(entry.content).toBe('hello')
    expect(entry.accessCount).toBe(0)
    expect(entry.tags).toEqual(['a'])
    expect(ctx.memory.has(entry.id)).toBe(true)
    await fiber.dispose()
  })

  it('defaults tags to an empty array when omitted', async () => {
    const { ctx, fiber } = await harness()
    const entry = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'no tags' })
    expect(entry.tags).toEqual([])
    await fiber.dispose()
  })

  it('rejects content that is empty after trimming', async () => {
    const { ctx, fiber } = await harness()
    await expect(ctx.memory.remember({ scope: 'user', kind: 'note', content: '   ' }))
      .rejects.toThrow(/empty/)
    await fiber.dispose()
  })

  it('rolls back the in-memory cache when the durable write rejects', async () => {
    const { ctx, pool, fiber } = await harness()
    pool.failNextWrites = 1
    await expect(ctx.memory.remember({ scope: 'user', kind: 'note', content: 'doomed' }))
      .rejects.toThrow(/injected write failure/)
    expect(ctx.memory.list('user').length).toBe(0)
    await fiber.dispose()
  })
})

describe('touch', () => {
  it('is a no-op for an absent id', async () => {
    const { ctx, fiber } = await harness()
    await expect(ctx.memory.touch(MemoryId('ghost'))).resolves.toBeUndefined()
    await fiber.dispose()
  })

  it('increments accessCount and refreshes lastAccessedAt', async () => {
    const { ctx, fiber } = await harness()
    const entry = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'touch me' })
    await ctx.memory.touch(entry.id)
    const touched = ctx.memory.get(entry.id)
    expect(touched?.accessCount).toBe(1)
    await fiber.dispose()
  })

  it('rolls back the in-memory cache when the durable write rejects', async () => {
    const { ctx, pool, fiber } = await harness()
    const entry = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'stable' })
    pool.failNextWrites = 1
    await expect(ctx.memory.touch(entry.id)).rejects.toThrow(/injected write failure/)
    expect(ctx.memory.get(entry.id)?.accessCount).toBe(0)
    await fiber.dispose()
  })
})

describe('forget', () => {
  it('returns false for an absent id', async () => {
    const { ctx, fiber } = await harness()
    await expect(ctx.memory.forget(MemoryId('ghost'))).resolves.toBe(false)
    await fiber.dispose()
  })

  it('deletes an existing entry and returns true', async () => {
    const { ctx, fiber } = await harness()
    const entry = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'bye' })
    await expect(ctx.memory.forget(entry.id)).resolves.toBe(true)
    expect(ctx.memory.has(entry.id)).toBe(false)
    await fiber.dispose()
  })

  it('restores the in-memory cache when the durable delete rejects', async () => {
    const { ctx, pool, fiber } = await harness()
    const entry = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'sticky' })
    pool.failNextWrites = 1
    await expect(ctx.memory.forget(entry.id)).rejects.toThrow(/injected write failure/)
    expect(ctx.memory.has(entry.id)).toBe(true)
    expect(ctx.memory.get(entry.id)?.content).toBe('sticky')
    await fiber.dispose()
  })
})

describe('edit', () => {
  it('returns undefined for an absent id', async () => {
    const { ctx, fiber } = await harness()
    await expect(ctx.memory.edit(MemoryId('ghost'), { content: 'new' })).resolves.toBeUndefined()
    await fiber.dispose()
  })

  it('rejects content that is empty after trimming', async () => {
    const { ctx, fiber } = await harness()
    const entry = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'fine' })
    await expect(ctx.memory.edit(entry.id, { content: '   ' })).rejects.toThrow(/empty/)
    await fiber.dispose()
  })

  it('replaces tags only, leaving content and unspecified fields untouched', async () => {
    const { ctx, fiber } = await harness()
    const entry = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'unchanged', tags: ['old'] })
    const updated = await ctx.memory.edit(entry.id, { tags: ['new'] })
    expect(updated?.content).toBe('unchanged')
    expect(updated?.tags).toEqual(['new'])
    await fiber.dispose()
  })

  it('replaces content only, leaving tags untouched', async () => {
    const { ctx, fiber } = await harness()
    const entry = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'old text', tags: ['kept'] })
    const updated = await ctx.memory.edit(entry.id, { content: 'new text' })
    expect(updated?.content).toBe('new text')
    expect(updated?.tags).toEqual(['kept'])
    await fiber.dispose()
  })

  it('rolls back the in-memory cache when the durable write rejects', async () => {
    const { ctx, pool, fiber } = await harness()
    const entry = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'original' })
    pool.failNextWrites = 1
    await expect(ctx.memory.edit(entry.id, { content: 'changed' })).rejects.toThrow(/injected write failure/)
    expect(ctx.memory.get(entry.id)?.content).toBe('original')
    await fiber.dispose()
  })
})

describe('recall', () => {
  it('restricts to an exact kind', async () => {
    const { ctx, fiber } = await harness()
    await ctx.memory.remember({ scope: 'user', kind: 'fact', content: 'a fact' })
    await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'a note' })
    const hits = ctx.memory.recall({ kind: 'fact' })
    expect(hits.map(h => h.kind)).toEqual(['fact'])
    await fiber.dispose()
  })

  it('matches free text against content and against tags', async () => {
    const { ctx, fiber } = await harness()
    await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'writes tests first' })
    await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'unrelated', tags: ['pytest'] })
    await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'nothing matches here' })
    const hits = ctx.memory.recall({ text: 'test' })
    expect(hits.length).toBe(2)
    await fiber.dispose()
  })

  it('requires every given tag to match', async () => {
    const { ctx, fiber } = await harness()
    await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'both', tags: ['x', 'y'] })
    await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'one only', tags: ['x'] })
    const hits = ctx.memory.recall({ tags: ['x', 'y'] })
    expect(hits.map(h => h.content)).toEqual(['both'])
    await fiber.dispose()
  })

  it('an omitted scope searches every scope', async () => {
    const { ctx, fiber } = await harness()
    await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'personal' })
    await ctx.memory.remember({ scope: 'project:/tmp/demo', kind: 'note', content: 'project' })
    const hits = ctx.memory.recall({})
    expect(hits.length).toBe(2)
    await fiber.dispose()
  })

  it('the user scope excludes project entries', async () => {
    const { ctx, fiber } = await harness()
    await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'personal' })
    await ctx.memory.remember({ scope: 'project:/tmp/demo', kind: 'note', content: 'project' })
    const hits = ctx.memory.recall({ scope: 'user' })
    expect(hits.map(h => h.content)).toEqual(['personal'])
    await fiber.dispose()
  })

  it('a project scope also surfaces user memory without duplication', async () => {
    const { ctx, fiber } = await harness()
    const user = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'personal' })
    await ctx.memory.remember({ scope: 'project:/tmp/demo', kind: 'note', content: 'project a' })
    await ctx.memory.remember({ scope: 'project:/other', kind: 'note', content: 'project b' })
    const hits = ctx.memory.recall({ scope: 'project:/tmp/demo' })
    expect(hits.filter(h => h.id === user.id).length).toBe(1)
    expect(hits.some(h => h.content === 'project b')).toBe(false)
    await fiber.dispose()
  })

  it('defaults the result limit to 12', async () => {
    const { ctx, fiber } = await harness()
    for (let i = 0; i < 15; i++) {
      await ctx.memory.remember({ scope: 'user', kind: 'note', content: `entry ${i}` })
    }
    expect(ctx.memory.recall({}).length).toBe(12)
    await fiber.dispose()
  })

  it('ranks a higher accessCount above a lower one regardless of recency', async () => {
    const { ctx, fiber } = await harness()
    const older = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'older, frequent' })
    await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'newer, untouched' })
    await ctx.memory.touch(older.id)
    const ranked = ctx.memory.recall({})
    expect(ranked[0]?.id).toBe(older.id)
    await fiber.dispose()
  })

  it('breaks an accessCount tie by updatedAt, newest first, for entries inserted in chronological order', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, fiber } = await harness()
      vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
      const a = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'a' })
      vi.setSystemTime(new Date('2024-01-01T00:00:01.000Z'))
      const b = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'b' })

      const ranked = ctx.memory.recall({})
      expect(ranked[0]?.id).toBe(b.id)
      expect(ranked[1]?.id).toBe(a.id)
      await fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('breaks an accessCount tie by updatedAt for an entry edited out of chronological order', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, fiber } = await harness()
      vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
      const a = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'a' })
      vi.setSystemTime(new Date('2024-01-01T00:00:01.000Z'))
      const b = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'b' })

      // a was inserted first but edited last, so its cache slot (still first
      // in Map iteration order) now holds the newer timestamp: this forces
      // the comparator's other inequality branch, unlike the chronological-
      // insertion case above.
      vi.setSystemTime(new Date('2024-01-01T00:00:02.000Z'))
      await ctx.memory.edit(a.id, { content: 'a edited' })

      const ranked = ctx.memory.recall({})
      expect(ranked[0]?.id).toBe(a.id)
      expect(ranked[1]?.id).toBe(b.id)
      await fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats an exact updatedAt tie as equal rank', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, fiber } = await harness()
      vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
      const a = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'a' })
      const b = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'b' })
      expect(a.updatedAt).toBe(b.updatedAt)

      const ranked = ctx.memory.recall({})
      expect(ranked.map(h => h.id).sort()).toEqual([a.id, b.id].sort())
      await fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('list', () => {
  it('restricts to an exact scope', async () => {
    const { ctx, fiber } = await harness()
    await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'personal' })
    await ctx.memory.remember({ scope: 'project:/tmp/demo', kind: 'note', content: 'project' })
    const rows = ctx.memory.list('project:/tmp/demo')
    expect(rows.map(r => r.content)).toEqual(['project'])
    await fiber.dispose()
  })

  it('unlike recall, a project scope does not also surface user memory', async () => {
    const { ctx, fiber } = await harness()
    await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'personal' })
    await ctx.memory.remember({ scope: 'project:/tmp/demo', kind: 'note', content: 'project' })
    const rows = ctx.memory.list('project:/tmp/demo')
    expect(rows.length).toBe(1)
    await fiber.dispose()
  })

  it('restricts to an exact kind', async () => {
    const { ctx, fiber } = await harness()
    await ctx.memory.remember({ scope: 'user', kind: 'fact', content: 'a fact' })
    await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'a note' })
    const rows = ctx.memory.list(undefined, 'fact')
    expect(rows.map(r => r.kind)).toEqual(['fact'])
    await fiber.dispose()
  })

  it('an omitted scope and kind lists every entry', async () => {
    const { ctx, fiber } = await harness()
    await ctx.memory.remember({ scope: 'user', kind: 'fact', content: 'a' })
    await ctx.memory.remember({ scope: 'project:/tmp/demo', kind: 'note', content: 'b' })
    expect(ctx.memory.list().length).toBe(2)
    await fiber.dispose()
  })

  it('orders results by updatedAt descending, breaking a tie both ways', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, fiber } = await harness()
      vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
      const a = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'a' })
      vi.setSystemTime(new Date('2024-01-01T00:00:01.000Z'))
      const b = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'b' })

      let rows = ctx.memory.list('user')
      expect(rows.map(r => r.id)).toEqual([b.id, a.id])

      // Force the reverse comparator branch: edit a so its cache slot (first
      // in Map iteration order) now carries the newest updatedAt.
      vi.setSystemTime(new Date('2024-01-01T00:00:02.000Z'))
      await ctx.memory.edit(a.id, { content: 'a edited' })
      rows = ctx.memory.list('user')
      expect(rows.map(r => r.id)).toEqual([a.id, b.id])

      // Exact tie: same timestamp for both entries at once.
      vi.setSystemTime(new Date('2024-01-01T00:00:03.000Z'))
      const c = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'c' })
      const d = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'd' })
      expect(c.updatedAt).toBe(d.updatedAt)
      const ids = ctx.memory.list('user').map(r => r.id)
      expect(new Set(ids)).toEqual(new Set([a.id, b.id, c.id, d.id]))
      await fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
