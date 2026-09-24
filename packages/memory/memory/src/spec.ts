/**
 * The memory domain declaration: record schemas and the `defineDomain` spec
 * the memory service opens. The zod schema is the durable-boundary validator;
 * every stored record round-trips through it on open, so a bad write is
 * rejected before it can poison the whole medium.
 * @module @deepseek-ai/dsh-memory/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { MemoryId, MemoryScope } from './types.ts'

/** Memory-id schema at the durable boundary; branding has no runtime representation. */
const memoryId = z.string().transform(value => value as MemoryId)

/**
 * Durable scope of one memory entry. `user` is the personal, cross-project
 * memory any session may read; `project:<path>` is a workspace-specific memory
 * read only while working under that project path.
 */
export const memoryScope = z.union([
  z.literal('user'),
  z.string().refine(value => value.startsWith('project:'), {
    message: 'project scope must start with "project:"',
  }),
]) as z.ZodType<MemoryScope>

/**
 * Durable kind of one memory entry, describing how the model should treat it.
 * `fact` is a standing fact about the user or project; `preference` is a
 * durable choice (e.g. "always write tests"); `decision` records a made
 * decision and its rationale; `note` is a general working note.
 */
export const memoryKind = z.enum(['fact', 'preference', 'decision', 'note'])

/**
 * Durable shape of one memory entry. `id` is the stable key; `scope`
 * distinguishes personal from project memory; `tags` are free-form search
 * labels. Timestamps are ISO-8601 strings. `accessCount`/`lastAccessedAt`
 * drive prompt-recall ranking so the most useful entries surface first.
 */
export const memoryEntry = z.object({
  id: memoryId,
  scope: memoryScope,
  kind: memoryKind,
  content: z.string().min(1),
  tags: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastAccessedAt: z.string(),
  accessCount: z.number().int().min(0).default(0),
})

/** One stored memory entry, inferred from {@link memoryEntry}. */
export type MemoryEntry = z.infer<typeof memoryEntry>

/**
 * The memory domain spec: one `entries` table keyed by {@link MemoryId}.
 * Entries carry their own scope/kind, so one flat table serves both the
 * personal (user) and per-project memory spaces. Version 1; a schema change
 * must bump it and reject stale media rather than silently corrupt.
 */
export const memoryDomainSpec = defineDomain({
  name: 'memory',
  version: 1,
  tables: {
    entries: domainTable<MemoryId, MemoryEntry>(memoryEntry),
  },
})
