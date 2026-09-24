# @deepseek-ai/dsh-memory

English | [中文](README.zh.md)

Durable cross-session memory. `MemoryService` registers `ctx.memory` as a host-plane singleton: it opens the `memory` storage domain once per process and serves every session from the same in-memory cache and durable table, which is exactly what makes stored memory cross-session rather than per-session. One flat `entries` table carries both the user's personal memory (`scope: 'user'`) and per-project memory (`scope: 'project:<path>'`); each entry also carries a `kind` (`fact` | `preference` | `decision` | `note`), free-form `content`, optional search `tags`, and access-tracking timestamps. `MemoryId` is a branded string id. The package has no `Config`; there is nothing to tune at the storage-domain layer.

## Service contract

`remember(input)` trims `content`, rejects it if empty after trimming, mints a `MemoryId` and timestamps, publishes the new entry to the in-memory cache before the durable write, and rolls the cache back if that write fails — a durable failure never leaves the cache pointing at an entry the table does not have. `edit(id, patch)` and `touch(id)` follow the same publish-then-persist-then-rollback-on-failure order; `forget(id)` deletes from the cache first and restores it on a failed durable delete.

`recall(query)` searches the in-memory cache: `text` matches case-insensitively against `content` and `tags`, `kind` and `tags` narrow further, and every given filter must match. Results are ranked by `accessCount` descending, then `updatedAt` descending, and truncated to `query.limit` (default `12`). Scope selection is asymmetric by design: querying a project scope also surfaces the user's personal memory (it travels with the user into every project), querying `user` returns personal memory only, and omitting scope searches everything. `touch(id)` increments `accessCount` and refreshes `lastAccessedAt`, raising that entry's rank in later `recall` calls; it is a no-op for an absent id. `list(scope?, kind?)` is a plain filtered, `updatedAt`-descending listing with no ranking and, unlike `recall`, does not also surface `user` entries for a project scope. `get(id)` and `has(id)` read the cache directly.

## Durability

The `memory` domain (`memoryDomainSpec`, version `1`) declares one `entries` table keyed by `MemoryId` over the `memoryEntry` zod schema; every stored record round-trips through that schema on open, so a malformed row is rejected before it can poison the rest of the table. A schema change to the durable shape must bump the version rather than silently reinterpret old records. The service requires `ctx.storageDomain` ([`dsh-storage-domain`](../../storage/storage-domain/README.md)) and closes its domain handle on disposal.

The `./invariant` companion checks the owned relationship between the in-memory cache and the durable table: on `domain/changed` for `memory`/`entries`, a `put` must already be visible in the cache and a `delete` must already be absent from it, catching a write path that bypassed `ctx.memory`.

## Model Experience

### Cross-session memory storage

#### What the model sees

Nothing directly. This service registers no tool, prompt section, or model-visible context of its own; [`@deepseek-ai/dsh-tool-memory`](../tool-memory/README.md) is the sole consumer that turns `ctx.memory.remember`/`recall`/`list`/`forget`/`edit` into tool calls and a runtime-context snapshot.

#### Token effect

None from this package. Every model-visible token from stored memory is accounted for in `dsh-tool-memory`'s Model Experience.

#### KV Cache effect

Independent. A `remember`, `edit`, `touch`, or `forget` call does not itself touch a model request prefix; any cache effect is a consequence of what a consumer renders from the updated state.

## Known Limitations and Deferred Work

- **Substring search only** — `recall`'s `text` filter is a case-insensitive substring match over `content` and `tags`; there is no semantic or fuzzy retrieval, so a paraphrased query can miss a relevant entry.
- **Project scope is keyed by a literal path string** — `project:<path>` uses the exact string a caller supplies; moving a project to a new path orphans its existing memory, and a subdirectory of that path is a distinct, unrelated scope.
- **No size cap on entries or the table** — neither entry count nor total stored bytes is bounded; an unbounded `remember` stream grows the durable table and the in-memory cache without limit.
- **Requires `ctx.storageDomain`, which is web-app-only** — the memory domain cannot open in a headless or ACP composition that does not mount [`dsh-storage-domain`](../../storage/storage-domain/README.md).
- **Ranking has no time decay** — `recall`'s ranking is `accessCount` descending, then `updatedAt` descending, so a heavily touched entry keeps outranking newer entries indefinitely; there is no aging or normalization of access counts.
