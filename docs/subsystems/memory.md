# Memory

English | [中文](memory.zh.md)

[`@deepseek-ai/dsh-memory`](../../packages/memory/memory) owns durable cross-session memory: a host-plane singleton service (`ctx.memory`) over one flat `entries` table in the [storage domain form](storage.md), holding both personal (`scope: 'user'`) and per-project (`scope: 'project:<path>'`) records. [`@deepseek-ai/dsh-tool-memory`](../../packages/memory/tool-memory) is the sole consumer, turning the service's `remember`/`recall`/`list`/`forget`/`edit`/`touch` API into model-facing tools and one runtime-context snapshot.

Source: [`packages/memory/memory/src/types.ts`](../../packages/memory/memory/src/types.ts), [`packages/memory/memory/src/spec.ts`](../../packages/memory/memory/src/spec.ts), [`packages/memory/memory/src/index.ts`](../../packages/memory/memory/src/index.ts)

## Public types

`MemoryId` is a branded string id local to this package (`string & MemoryIdBrand`), minted by the service through the exported `MemoryId(id)` brand function; it carries no separate public brand-utility type.

```ts type-equiv
/** Durable scope of one memory entry. */
type MemoryScope = 'user' | `project:${string}`
```

```ts type-equiv
/** Durable kind of one memory entry. */
type MemoryKind = 'fact' | 'preference' | 'decision' | 'note'
```

```ts type-equiv
/** A structured query narrowing a recall over stored memory. */
interface MemoryQuery {
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
```

```ts type-equiv
/** A memory entry ready to be written; `id`/timestamps are minted by the service. */
interface RememberInput {
  /** `user` or `project:<path>`. */
  scope: MemoryScope
  kind: MemoryKind
  /** Free-form memory text. */
  content: string
  /** Optional search tags. */
  tags?: string[]
}
```

`MemoryEntry` (`packages/memory/memory/src/spec.ts`) is the zod-inferred durable row shape the service returns directly from `remember`/`recall`/`list`/`edit`/`get`, validated by the `memoryEntry` schema on every read from the domain table: `id: MemoryId`, `scope: MemoryScope`, `kind: MemoryKind`, `content: string`, `tags: string[]`, `createdAt`/`updatedAt`/`lastAccessedAt` (ISO-8601 strings), and `accessCount` (a non-negative integer incremented by `touch`). It is the one public entry shape; there is no separate hand-written projection distinct from the durable row.

## Scope, ranking, and durability

A project-scope `recall` also surfaces `user` entries — personal memory travels with the user into every project — while `user`-scope and `list` do not carry that surfacing rule. `recall` ranks by `accessCount` descending, then `updatedAt` descending, and matches `text` as a case-insensitive substring over `content` and `tags`; there is no semantic retrieval. The service publishes every mutation to its in-memory cache before the durable write and rolls the cache back on a failed write, so the cache and the `memory` domain's `entries` table never diverge; the package's `./invariant` companion checks that relationship against `domain/changed`.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmemory--memoryservice"></a>

### `ctx.memory` — `MemoryService`

Durable cross-session memory. Host-plane singleton: opens the memory domain once, serves every session, and persists through the domain's JSON backend.

```ts cordis-catalog
/**
 * Whether the cache holds an entry with this id (used by the invariant).
 * @param id - the entry id to look up.
 * @returns `true` if an entry with this id is in the in-memory cache.
 */
has(id: MemoryId): boolean

/**
 * Read one cached entry by id.
 * @param id - the entry id to look up.
 * @returns the cached entry, or `undefined` if no entry has this id.
 */
get(id: MemoryId): MemoryEntry | undefined

/**
 * Persist one memory entry. Returns the persisted entry; the caller may then
 * reference its id via `forget`/`touch`.
 * @param input - the scope, kind, content, and optional tags to store; `content`
 * is trimmed and rejected if empty after trimming.
 * @returns the stored entry, with a minted id and `createdAt`/`updatedAt`/
 * `lastAccessedAt` set to the current time and `accessCount` at `0`.
 */
async remember(input: RememberInput): Promise<MemoryEntry>

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
recall(query: MemoryQuery = {}): MemoryEntry[]

/**
 * Touch one entry's recency/access counters after a recall surfaces it,
 * incrementing `accessCount` and setting `lastAccessedAt` to now. Raises
 * that entry's rank in future `recall` calls. A no-op if `id` is absent.
 * @param id - the entry id to touch.
 */
async touch(id: MemoryId): Promise<void>

/**
 * Delete one memory entry by id. Returns whether it existed.
 * @param id - the entry id to delete.
 * @returns `true` if an entry with this id was found and deleted, `false`
 * if no entry had this id (nothing was deleted).
 */
async forget(id: MemoryId): Promise<boolean>

/**
 * Update one entry's content and/or tags. Returns the updated entry, or `undefined` if absent.
 * @param id - the entry id to update.
 * @param patch - fields to overwrite; an omitted field keeps its current
 * value. `content`, if given, is trimmed and rejected if empty after
 * trimming; `tags`, if given, replaces the entry's tags wholesale.
 * @returns the updated entry with a refreshed `updatedAt`, or `undefined`
 * if no entry has this id (no write occurs).
 */
async edit(id: MemoryId, patch: { content?: string; tags?: string[] }): Promise<MemoryEntry | undefined>

/**
 * List entries in a scope (optionally filtered by kind), newest first.
 * @param scope - restrict to this exact scope value; omission lists every
 * scope. Unlike `recall`, a project scope does not also surface `user`
 * entries.
 * @param kind - restrict to this kind; omission lists every kind. Combines
 * with `scope` as an intersection (an entry must match both, when given).
 * @returns the matching entries ordered by `updatedAt` descending.
 */
list(scope?: MemoryScope, kind?: MemoryKind): MemoryEntry[]
```

Source: [`packages/memory/memory/src/index.ts:58`](../../packages/memory/memory/src/index.ts)
<!-- END GENERATED cordis-surface -->
