# memory/ — durable cross-session memory

English | [中文](README.zh.md)

The memory family gives an agent facts, preferences, and decisions that outlive one session: a host-plane singleton service over one flat durable table, and the model-facing tools plus runtime-context contribution that read and write it.

| Package | Role | ctx key |
|---|---|---|
| `memory/` | Host-plane singleton `MemoryService`: personal (`user`) and per-project (`project:<path>`) entries over `ctx.storageDomain`, shared by every session in the process | `memory` |
| `tool-memory/` | Model-facing `memory_remember`/`memory_recall`/`memory_list`/`memory_forget`/`memory_edit` tools plus the `tool:memory` runtime-context contribution | — |

Memory is process-wide, not session-scoped: a fact remembered in one session is readable by any later session over the same storage root, subject to scope. `memory/` owns the durable record and its recall ranking; `tool-memory/` owns every model-facing surface, including the runtime-context snapshot that acts on stored memory without an explicit recall call. Both packages require `ctx.storageDomain`, which only a composition mounting [`dsh-storage-domain`](../storage/storage-domain/README.md) provides.
