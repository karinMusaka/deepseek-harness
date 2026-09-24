# Agent Note: Cross-session memory as a storage-domain service plus a runtime-context tool consumer

Status: implemented

English | [中文](2026-09-24-cross-session-memory-service-and-tools.zh.md)

## Problem

Nothing in the harness lets an agent remember a fact, preference, or decision that outlives the session it was learned in. `dsh-goal` and `dsh-tool-todo` persist state, but that state lives in one session's own log and is invisible to any other session. [`examples/mcp-memory`](../../../../examples/mcp-memory/README.md) shows the only prior path to cross-session memory: a third-party MCP server running out of process, reached only when the model explicitly calls that server's own write/search tools.

An in-process alternative needs a durable store shared by every session in a process, a way to expose it to the model, and an answer to the existing invariant that anything model-visible must be reconstructable from the session log — a system-prompt section is rebuilt from live plugin state at each assembly and is not itself logged, so rendering recalled memory as a section would let the model see text no later replay can recover.

## Decision

`@deepseek-ai/dsh-memory` is a host-plane singleton `Service` (`ctx.memory`) over `ctx.storageDomain`: one `entries` table in the `memory` storage domain, opened once per process and shared by every session, holding personal (`scope: 'user'`) and per-project (`scope: 'project:<path>'`) entries. It is a plain service over an existing capability, not a capability seam: `storage-domain` already supplies the swappable backend underneath, and memory itself has exactly one implementation, so splitting Service Definition / Provider / Consumer roles here would add indirection with no current second provider to justify it. `@deepseek-ai/dsh-tool-memory` is the sole Consumer, registering `memory_remember`/`memory_recall`/`memory_list`/`memory_forget`/`memory_edit` plus one `tool:memory` runtime-context contribution.

The runtime-context contribution, not a system-prompt section, is what delivers recalled memory to the model without an explicit call. `ctx.systemPrompt.context()` entries are the one prompt-input kind the agent loop logs: [`RuntimeContextProjection`](../../../../packages/core/agent-loop/src/runtime-context.ts) commits the rendered text as a `user`-role session event whenever it differs from the retained snapshot, so the exact text the model saw is always reconstructable by replay. A section carries no such guarantee — its content is realized fresh at each assembly and only the fact of the agent's live configuration is durable, not the rendered text. Memory recall therefore had to be a context contribution to satisfy the model-visible-⟺-logged invariant, independent of memory's own storage design.

A stored memory entry is arbitrary user-authored text, so the rendered snapshot registers with `interpolate: false`. Without it, a remembered fact containing a `{{…}}`-shaped substring would either throw (an unknown reference) or silently substitute an unrelated value during `renderPrompt`'s strict interpolation. `interpolate` is a general field added to both `PromptSection` and `PromptContext` for exactly this class of problem — verbatim data mixed into an otherwise templated prompt input — and `dsh-tool-memory`'s context contribution is its first shipped consumer.

Scope is deliberately simple: a project's scope is `project:<cwd>` keyed by the literal current-working-directory string at call time, and a project-scope recall also surfaces `user` entries (personal memory travels with the user into every project) while `memory_list`'s narrower semantics do not. Recall ranks by `accessCount` descending then `updatedAt` descending and matches by case-insensitive substring only — no semantic retrieval, no embeddings, no size cap on stored entries.

Both packages require `ctx.storageDomain`, which only [`packages/bundle/web-app`](../../../../packages/bundle/web-app/README.md) mounts; `packages/bundle/headless` and the ACP composition do not, so memory is a web-app-only capability until another bundle mounts storage-domain.

### Relation to `examples/mcp-memory`

The MCP examples remain the out-of-process alternative: default-off, reached only through an explicit call to a vendor server's own write/search tools, storing data outside the harness's session and storage model entirely, with no session-log record of what was recalled. `dsh-memory`/`dsh-tool-memory` is in-process: the web-app bundle mounts the service by default, an agent preset mounts the tool Consumer per agent, and the Consumer surfaces recall automatically as a logged runtime-context snapshot in addition to the explicit `memory_recall` tool. The two mechanisms do not conflict; a deployment can run either or both, and neither depends on the other.

## Alternatives considered

**A system-prompt section for recalled memory.** Rejected: a section's live text is not logged, so replay could not reconstruct what the model actually saw, violating the model-visible-⟺-logged invariant that runtime-context snapshots already satisfy.

**A full capability seam (Service Definition / Provider / Consumer) for memory itself.** Rejected: `storage-domain` already provides the swappable persistence layer; memory has one implementation with no current second provider, so a seam split would add indirection without a present consumer that needs it.

**Per-character escaping of literal `{{…}}` sequences instead of `interpolate: false`.** Rejected: arbitrary remembered text can contain many brace-shaped substrings, and per-field opt-out already existed as the simpler, general mechanism once `interpolate` was added to `PromptSection`/`PromptContext`.

**Storing memory as ordinary session-log events, like `todo/write` or `goal/change`.** Rejected: those events are scoped to one session's own log; memory's whole purpose is visibility across every session sharing a process and storage root, which a per-session log cannot provide without a separate cross-session index.

## Consequences

Recalled memory is fully reconstructable from the session log: every rendered snapshot the model saw is a real logged event, not a live-recomputed artifact. The `interpolate: false` field lands its first real consumer, validating the mechanism against genuinely untrusted, brace-containing prompt data. Memory is unavailable in any composition that does not mount storage-domain, currently only the web-app bundle. The literal-`cwd` scope key means moving a project to a new path orphans its memory and a subdirectory is a distinct, unrelated project scope — an accepted limitation recorded in both package READMEs rather than solved here.

Coverage: package tests pin every source branch, a Loader composition test boots `dsh-tool-memory` over a real storage stack, and an agent-loop test proves a fact remembered in one session reaches the next session as a logged runtime-context snapshot that matches the model request. No keyless application snapshot pins the memory context: `dsh-tool-memory` is opt-in per agent preset and no shipped or example composition mounts it, so no existing transcript changes. The first composition that mounts it by default adds the snapshot, most likely under `apps/web/tests/snapshots/`.
