/**
 * Public brand and vocabulary types for the memory domain. Brands carry no
 * runtime representation; they exist for compile-time projection only.
 * @module @deepseek-ai/dsh-memory/src/types
 */

/** Identifies one memory entry. */
export interface MemoryIdBrand {
  readonly __memoryId: unique symbol
}

/** Branded memory entry id (a stable UUID string). */
export type MemoryId = string & MemoryIdBrand

/** Durable scope of one memory entry. */
export type MemoryScope = 'user' | `project:${string}`

/** Durable kind of one memory entry. */
export type MemoryKind = 'fact' | 'preference' | 'decision' | 'note'

/** A structured query narrowing a recall over stored memory. */
export interface MemoryQuery {
  /** Substring searched against content and tags (case-insensitive). */
  text?: string
  /** Restrict to one scope; omission searches both `user` and the given project. */
  scope?: MemoryScope
  /** Restrict to one kind. */
  kind?: MemoryKind
  /** Restrict to entries carrying every tag. */
  tags?: string[]
  /** Maximum number of results (prompt-recall default 12). */
  limit?: number
}
