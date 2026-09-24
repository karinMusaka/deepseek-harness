/**
 * Memory entity registry (`ctx.memory`): durable cross-session memory records
 * over the domain data form. One flat `entries` table carries both the user's
 * personal memory (`scope: 'user'`) and per-project memory (`scope:
 * 'project:<path>'`); the service keeps an in-memory copy for fast recall and
 * persists every mutation through the storage domain's atomic KV backend.
 *
 * The service is host-plane and singleton: it opens the `memory` domain once
 * per process and shares one instance across every session, which is exactly
 * what makes it *cross-session* memory — anything any session remembers is
 * readable by any later session (subject to scope).
 * @module @deepseek-ai/dsh-memory
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { MemoryEntry } from './spec.ts'
import { memoryDomainSpec } from './spec.ts'
import type { MemoryId as MemoryIdType, MemoryKind, MemoryQuery, MemoryScope } from './types.ts'

export { memoryDomainSpec, memoryEntry, memoryScope, memoryKind } from './spec.ts'
export type { MemoryEntry } from './spec.ts'
export type { MemoryKind, MemoryQuery, MemoryScope } from './types.ts'
/** Branded id of one memory entry. */
export type MemoryId = MemoryIdType

/**
 * Brand a string as a {@link MemoryId}.
 * @param id - the raw string to brand.
 * @returns the same string, typed as a {@link MemoryId}.
 */
export function MemoryId(id: string): MemoryId {
  return id as MemoryId
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService
  }
}

/** A memory entry ready to be written; `id`/timestamps are minted by the service. */
export interface RememberInput {
  /** `user` or `project:<path>`. */
  scope: MemoryScope
  kind: MemoryKind
  /** Free-form memory text. */
  content: string
  /** Optional search tags. */
  tags?: string[]
}

/**
 * Durable cross-session memory. Host-plane singleton: opens the memory domain
 * once, serves every session, and persists through the domain's JSON backend.
 */
export class MemoryService extends Service {
  static inject = ['storageDomain']

  private table?: KvTable<MemoryId, MemoryEntry>

  /** Live in-memory view, rebuilt on open and mutated alongside each write. */
  private readonly entries = new Map<MemoryId, MemoryEntry>()

  constructor(ctx: Context) {
    super(ctx, 'memory')
  }

  /** Open the memory domain and cache its records. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(memoryDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'memory.domainClose')
    this.table = domain.table('entries')
    for (const [key, value] of this.table.entries()) {
      this.entries.set(key, value)
    }
  }

  private requireTable(): KvTable<MemoryId, MemoryEntry> {
    if (this.table === undefined) {
      throw new Error('memory service is not started yet')
    }
    return this.table
  }

  /**
   * Whether the cache holds an entry with this id (used by the invariant).
   * @param id - the entry id to look up.
   * @returns `true` if an entry with this id is in the in-memory cache.
   */
  has(id: MemoryId): boolean {
    return this.entries.has(id)
  }

  /**
   * Read one cached entry by id.
   * @param id - the entry id to look up.
   * @returns the cached entry, or `undefined` if no entry has this id.
   */
  get(id: MemoryId): MemoryEntry | undefined {
    return this.entries.get(id)
  }

  /**
   * Persist one memory entry. Returns the persisted entry; the caller may then
   * reference its id via `forget`/`touch`.
   * @param input - the scope, kind, content, and optional tags to store; `content`
   * is trimmed and rejected if empty after trimming.
   * @returns the stored entry, with a minted id and `createdAt`/`updatedAt`/
   * `lastAccessedAt` set to the current time and `accessCount` at `0`.
   */
  async remember(input: RememberInput): Promise<MemoryEntry> {
    const table = this.requireTable()
    const content = input.content.trim()
    if (content.length === 0) {
      throw new Error('memory content must not be empty after trimming')
    }
    const now = new Date().toISOString()
    const id = MemoryId(randomUUID())
    const entry: MemoryEntry = {
      id,
      scope: input.scope,
      kind: input.kind,
      content,
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      accessCount: 0,
    }
    // Publish to the cache before the durable write so a concurrent reader (or
    // the invariant) never observes a diverged view; roll the cache back if the
    // durable write fails.
    this.entries.set(id, entry)
    try {
      await table.put(id, entry)
    } catch (error) {
      this.entries.delete(id)
      throw error
    }
    return entry
  }

  /**
   * Search stored memory. Results are ranked by accessCount descending, then
   * `updatedAt` descending, and truncated to `query.limit` (default 12).
   * Scope semantics: searching a project scope also surfaces user memory
   * (personal facts travel with the user into every project); searching the
   * `user` scope returns personal memory only; omitting scope searches all.
   * `text` matches case-insensitively against content and tags; `kind` and
   * `tags` narrow further, and an entry must satisfy every given filter.
   * @param query - the scope/kind/text/tags filters and result limit; every
   * field is optional and an empty query matches all cached entries.
   * @returns the matching entries in ranked order, at most `query.limit` (or 12).
   */
  recall(query: MemoryQuery = {}): MemoryEntry[] {
    const text = (query.text ?? '').toLowerCase()
    const tags = query.tags ?? []
    const scope = query.scope
    const inScope = (entry: MemoryEntry): boolean => {
      if (scope === undefined) return true
      if (scope === 'user') return entry.scope === 'user'
      // project scope: that project's entries plus the user's personal memory
      return entry.scope === scope || entry.scope === 'user'
    }
    const matches = [...this.entries.values()].filter((entry) => {
      if (!inScope(entry)) return false
      if (query.kind !== undefined && entry.kind !== query.kind) return false
      if (text.length > 0) {
        const haystack = `${entry.content} ${entry.tags.join(' ')}`.toLowerCase()
        if (!haystack.includes(text)) return false
      }
      if (tags.length > 0 && !tags.every(tag => entry.tags.includes(tag))) return false
      return true
    })
    matches.sort((a, b) =>
      b.accessCount - a.accessCount || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    return matches.slice(0, query.limit ?? 12)
  }

  /**
   * Touch one entry's recency/access counters after a recall surfaces it,
   * incrementing `accessCount` and setting `lastAccessedAt` to now. Raises
   * that entry's rank in future `recall` calls. A no-op if `id` is absent.
   * @param id - the entry id to touch.
   */
  async touch(id: MemoryId): Promise<void> {
    const table = this.requireTable()
    const entry = this.entries.get(id)
    if (entry === undefined) return
    const next: MemoryEntry = {
      ...entry,
      accessCount: entry.accessCount + 1,
      lastAccessedAt: new Date().toISOString(),
    }
    this.entries.set(id, next)
    try {
      await table.put(id, next)
    } catch (error) {
      this.entries.set(id, entry)
      throw error
    }
  }

  /**
   * Delete one memory entry by id. Returns whether it existed.
   * @param id - the entry id to delete.
   * @returns `true` if an entry with this id was found and deleted, `false`
   * if no entry had this id (nothing was deleted).
   */
  async forget(id: MemoryId): Promise<boolean> {
    const table = this.requireTable()
    const previous = this.entries.get(id)
    if (previous === undefined) return false
    this.entries.delete(id)
    try {
      await table.delete(id)
    } catch (error) {
      this.entries.set(id, previous)
      throw error
    }
    return true
  }

  /**
   * Update one entry's content and/or tags. Returns the updated entry, or `undefined` if absent.
   * @param id - the entry id to update.
   * @param patch - fields to overwrite; an omitted field keeps its current
   * value. `content`, if given, is trimmed and rejected if empty after
   * trimming; `tags`, if given, replaces the entry's tags wholesale.
   * @returns the updated entry with a refreshed `updatedAt`, or `undefined`
   * if no entry has this id (no write occurs).
   */
  async edit(id: MemoryId, patch: { content?: string; tags?: string[] }): Promise<MemoryEntry | undefined> {
    const table = this.requireTable()
    const current = this.entries.get(id)
    if (current === undefined) return undefined
    const content = patch.content === undefined ? current.content : patch.content.trim()
    if (patch.content !== undefined && content.length === 0) {
      throw new Error('memory content must not be empty after trimming')
    }
    const next: MemoryEntry = {
      ...current,
      content,
      ...patch.tags === undefined ? {} : { tags: patch.tags },
      updatedAt: new Date().toISOString(),
    }
    this.entries.set(id, next)
    try {
      await table.put(id, next)
    } catch (error) {
      this.entries.set(id, current)
      throw error
    }
    return next
  }

  /**
   * List entries in a scope (optionally filtered by kind), newest first.
   * @param scope - restrict to this exact scope value; omission lists every
   * scope. Unlike `recall`, a project scope does not also surface `user`
   * entries.
   * @param kind - restrict to this kind; omission lists every kind. Combines
   * with `scope` as an intersection (an entry must match both, when given).
   * @returns the matching entries ordered by `updatedAt` descending.
   */
  list(scope?: MemoryScope, kind?: MemoryKind): MemoryEntry[] {
    const rows = [...this.entries.values()]
      .filter(entry => scope === undefined || entry.scope === scope)
      .filter(entry => kind === undefined || entry.kind === kind)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    return rows
  }
}

export default MemoryService
