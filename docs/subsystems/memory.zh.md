# 记忆

[English](memory.md) | 中文

[`@deepseek-ai/dsh-memory`](../../packages/memory/memory) 拥有持久的跨会话记忆：一个 host-plane 单例服务（`ctx.memory`），覆盖在 [存储 domain 形式](storage.md) 中一张扁平的 `entries` 表之上，同时承载个人（`scope: 'user'`）与逐项目（`scope: 'project:<path>'`）记录。[`@deepseek-ai/dsh-tool-memory`](../../packages/memory/tool-memory) 是唯一的消费方，把该服务的 `remember`／`recall`／`list`／`forget`／`edit`／`touch` API 转化为面向模型的工具与一个 runtime-context 快照。

源码：[`packages/memory/memory/src/types.ts`](../../packages/memory/memory/src/types.ts)、[`packages/memory/memory/src/spec.ts`](../../packages/memory/memory/src/spec.ts)、[`packages/memory/memory/src/index.ts`](../../packages/memory/memory/src/index.ts)

## 公开类型

`MemoryId` 是该包本地的带品牌字符串 id（`string & MemoryIdBrand`），由服务通过导出的 `MemoryId(id)` 品牌函数铸造；它没有独立的公开品牌工具类型。

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

`MemoryEntry`（`packages/memory/memory/src/spec.ts`）是服务直接从 `remember`／`recall`／`list`／`edit`／`get` 返回的、由 zod 推导出的持久行形状，每次从 domain 表读取时都会经 `memoryEntry` schema 校验：`id: MemoryId`、`scope: MemoryScope`、`kind: MemoryKind`、`content: string`、`tags: string[]`、`createdAt`／`updatedAt`／`lastAccessedAt`（ISO-8601 字符串），以及 `accessCount`（由 `touch` 递增的非负整数）。它是唯一的公开条目形状；不存在与持久行分离的另一套手写投影。

## 作用域、排名与持久性

一次项目作用域的 `recall` 也会带出 `user` 条目——个人记忆会跟随用户进入每个项目——而 `user` 作用域与 `list` 不遵循这条带出规则。`recall` 先按 `accessCount` 降序、再按 `updatedAt` 降序排名，并把 `text` 作为对 `content` 与 `tags` 的大小写不敏感子串来匹配；不存在语义检索。该服务会在持久写入之前先把每次变更发布到内存缓存，并在写入失败时回滚缓存，因此缓存与 `memory` domain 的 `entries` 表绝不会分叉；该包的 `./invariant` 配套插件会针对 `domain/changed` 检查这一关系。

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
