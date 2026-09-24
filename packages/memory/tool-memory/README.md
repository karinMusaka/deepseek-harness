# @deepseek-ai/dsh-tool-memory

English | [中文](README.zh.md)

Model-facing tools over the durable cross-session [`ctx.memory`](../memory/README.md) service: `memory_remember`, `memory_recall`, `memory_list`, `memory_forget`, and `memory_edit`. A `tool:memory` runtime-context contribution also delivers the most relevant stored memory as a logged snapshot on its own, so a fact is acted on without an explicit recall call. A function/namespace plugin: it exports `name` / `inject` / `Config` / `apply` and no default export.

## Scope

A tool execution may read or modify two scopes: `user` (personal memory) and, when it runs under an agent, that agent's current project scope, `project:<agent.session.header.cwd ?? process.cwd()>`. `memory_remember` defaults to the current project scope (`user` only when the model asks for it or no project scope is available); `memory_recall` defaults to the current project scope too, which also surfaces `user` memory, and accepts an explicit `scope: 'user'` to search personal memory only. `memory_list` always lists the current project scope exactly (or `user` outside an agent), matching `ctx.memory.list()`'s narrower semantics — it does not also surface `user` entries. `memory_forget` and `memory_edit` accept any id but refuse to act on an entry whose scope is not one of the caller's two allowed scopes, returning `{ ok: false, message: 'That memory belongs to another project and cannot be … here.' }`; an unknown id reaches `ctx.memory` directly and comes back as ordinary not-found.

## Configuration

| key | default | meaning |
|---|---|---|
| `contextLimit` | `10` | Maximum entries the runtime-context snapshot lists. `0` disables the snapshot entirely — the tools remain registered, but no `tool:memory` context contribution is made. |
| `maxRecallLimit` | `50` | Upper bound applied to a model-requested `memory_recall` `limit`; the effective limit is `max(1, min(maxRecallLimit, limit))`. |

The web-app bundle mounts the `dsh-memory` service and ships this package as a dependency without mounting it. An agent preset's `agent.cordis.yml` opts an agent in with this row:

```yaml
- id: tool-memory
  name: '@deepseek-ai/dsh-tool-memory'
  config:
    contextLimit: 10
    maxRecallLimit: 50
```

## Runtime-context contribution

When `contextLimit` is nonzero, `apply` registers a `ctx.systemPrompt.context()` entry named `tool:memory`, order `117`, with `interpolate: false`. Its `text(context)` returns `''` outside an agent, and otherwise calls `ctx.memory.recall({ scope: projectScopeOf(agent), limit: contextLimit })` — a project-scope recall, which also surfaces `user` memory — and renders the header line followed by one `entryLine` per hit, or `''` when the recall is empty. `interpolate: false` is required because a stored memory entry is arbitrary user-authored text: a `{{…}}`-shaped substring inside a remembered fact must render as literal prose, never as a template reference. The agent loop turns that rendered text into a logged `user`-role runtime-context snapshot, re-emitted only when it differs from the retained snapshot or a prior snapshot was removed by compaction (see [`packages/core/agent-loop/src/runtime-context.ts`](../../core/agent-loop/src/runtime-context.ts) and [`dsh-system-prompt`](../../core/system-prompt/README.md)). This context provider does not call `touch`; only `memory_recall` does, so ranking inside the snapshot itself never changes from having been shown.

## Model Experience

### Runtime-context memory snapshot

#### What the model sees

When `contextLimit` is nonzero and the call runs under an agent, the top `contextLimit` entries of a project-scope recall (current project plus personal memory) render as a fixed header line followed by one line per entry, `- [<kind>] <scope>[ [tags]]: <content>  (id: <id>)`; an empty recall contributes nothing.

##### Header line

```markdown
Stored memory about the user and this project (act on it; update via memory_remember when it changes):
```

#### Token effect

Capped by `contextLimit`: at most that many entry lines plus the fixed header, or zero when the recall is empty or `contextLimit` is `0`.

#### KV Cache effect

Append-only: a new snapshot is logged as a fresh user-role message only when the rendered text changes from the retained one, so it never rewrites the system-prompt prefix. A `memory_recall` call `touch`ing a hit can reorder the top-`contextLimit` set on the next turn, which changes the rendered text and appends another snapshot; a `memory_remember`, `memory_edit`, or `memory_forget` affecting a top-ranked entry can do the same.

### Tool schemas

#### What the model sees

The generated [`memory_remember`, `memory_recall`, `memory_list`, `memory_forget`, and `memory_edit` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-memory).

#### Token effect

Fixed schema cost per visible tool, on every request where these tools are in scope.

#### KV Cache effect

Prefix-stable while the definitions and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from these schemas.

## Known Limitations and Deferred Work

- **Substring search only** — `memory_recall` inherits `ctx.memory.recall`'s case-insensitive substring matching; there is no semantic search, so a paraphrased query can miss a relevant memory.
- **Scope is keyed by a literal `cwd` string** — a project's scope is `project:<cwd>` for the exact working-directory string at call time; moving a project to a new path orphans its memory under the old key, and a subdirectory of a project is a distinct scope with no access to the parent's memory.
- **Requires `ctx.storageDomain`, mounted only by the web-app bundle** — headless and ACP compositions do not mount [`dsh-storage-domain`](../../storage/storage-domain/README.md), so this package's memory has no durable domain to open in those compositions.
- **`memory_recall` touches every hit it returns** — each call increments `accessCount` and refreshes `lastAccessedAt` for every returned entry, so repeated recalls of the same broad query keep raising those entries' rank regardless of whether the model acted on them.
- **No size cap on stored entries** — neither `ctx.memory` nor this package bounds entry count or aggregate content size; an unbounded `memory_remember` stream grows the runtime-context recall pool and the durable table without limit.
