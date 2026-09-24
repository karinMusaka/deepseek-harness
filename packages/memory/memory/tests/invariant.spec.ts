import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import MemoryService, { MemoryId } from '../src/index.ts'
import * as MemoryInvariant from '../src/invariant.ts'

/** Boot storage/domain/memory plus the invariant registry and this package's companion. */
async function harness() {
  const pool = new MemoryMediaPool()
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(MemoryService)
  await ctx.plugin(MemoryInvariant)
  return { ctx }
}

const invariantViolation: unknown = expect.objectContaining<Partial<InvariantError>>({
  code: 'INVARIANT',
  packageName: '@deepseek-ai/dsh-memory',
})

describe('memory invariant companion', () => {
  it('accepts every change emitted by real remember/touch/forget/edit writes', async () => {
    const { ctx } = await harness()
    const entry = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'consistent' })
    await ctx.memory.touch(entry.id)
    await ctx.memory.edit(entry.id, { content: 'updated' })
    await ctx.memory.forget(entry.id)
  })

  it('rejects a put event for a key absent from the service cache', async () => {
    const { ctx } = await harness()
    expect(() => { ctx.emit('domain/changed', {
      domain: 'memory', table: 'entries', key: MemoryId('ghost'), operation: 'put', value: {},
    }) }).toThrow(invariantViolation)
  })

  it('rejects a deletion event for a key still held in the service cache', async () => {
    const { ctx } = await harness()
    const entry = await ctx.memory.remember({ scope: 'user', kind: 'note', content: 'still cached' })
    expect(() => { ctx.emit('domain/changed', {
      domain: 'memory', table: 'entries', key: entry.id, operation: 'deleted',
    }) }).toThrow(invariantViolation)
  })

  it('ignores changes for other domains and tables', async () => {
    const { ctx } = await harness()
    expect(() => { ctx.emit('domain/changed', {
      domain: 'other', table: 'entries', key: 'x', operation: 'put', value: {},
    } as DomainChanged) }).not.toThrow()
    expect(() => { ctx.emit('domain/changed', {
      domain: 'memory', table: 'other-table', key: 'x', operation: 'put', value: {},
    } as DomainChanged) }).not.toThrow()
  })
})
