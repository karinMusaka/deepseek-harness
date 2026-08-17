# Agent Note: `codex` and `claude-code` subagents get a permission scope fixed at delegation

Status: implemented

English | [中文](2026-08-17-subagent-delegation-permission-scope.zh.md)

## Problem

The [approval-pinning Agent Note](2026-08-10-subagent-approval-pinned-never.md) states that "the child's whole permission story is its sandbox scope" and that `claude-code`, `codex`, and `dsh-sdk` children "run in external processes under their own composition" — but that composition was, in fact, the *host's* composition. `subagent-codex` omitted `sandbox`/`approvalPolicy` from `thread/start`, so a child inherited whatever `~/.codex/config.toml` the host happened to have. `subagent-claude-code` omitted `settingSources`, so the official SDK read the host's `~/.claude/settings.json`, project settings, CLAUDE.md, and MCP configuration. The same delegation call therefore produced different child behavior depending on host configuration drift the deployment did not control, and neither provider offered any way to guarantee a child could not write.

Closing this gap by adding a `permission_mode` tool argument (the shape suggested by an early brief) would let the delegating model choose its own child's permission scope per call — directly contradicting the pinned-approval Note's rule that "a widening decision always belongs to the parent side."

## Decision

`packages/subagent/subagent/src/types.ts` adds a closed `SubagentPermissionMode = 'read-only' | 'workspace-write'`, a `SubagentCapabilities.permissionMode: boolean` flag (one more entry in the existing start-time capability set alongside `outputSchema`/`depthLimit`/`toolFilter`/`persona`), and an optional `SubagentStartRequest.permissionMode` field gated by that capability exactly like the others. `NO_START_CAPABILITIES` and every provider's capability literal — `spawn`, `fork`, `acp`, `dsh-sdk` — set `permissionMode: false`: an in-process child already shares the parent's own Cordis authority and has no separate scope to fix; `subagent-acp` keeps its own explicit machine `permission` policy instead. Only `codex` and `claude-code` set `permissionMode: true`.

`dsh-tool-subagent`'s `Config.permissionMode?: SubagentPermissionMode` is a plain optional field with no Schemastery `.default(...)` — omission stays `undefined` through the Loader (the same idiom `persona` already uses), and `apply()` forwards it to the start request only when present (`...config.permissionMode !== undefined ? { permissionMode: config.permissionMode } : {}`), exactly like `persona`/`toolFilter`. Mount time rejects an explicitly configured `permissionMode` against a provider lacking the capability, mirroring the existing `backgroundMode: continuable` and numeric-`maxDepth` mount checks. The field is deployment configuration only; the model never sees it as a tool argument. "Absent means the provider's own default, which every provider defines as `read-only`" (the field's JSDoc) is enforced at the *provider*, not the tool: `CodexProvider.start()` and `ClaudeCodeProvider.start()` both resolve `request.permissionMode ?? 'read-only'` before building their run spec. A materialized tool-level default forwarded unconditionally to every provider would instead break every existing `spawn`/`fork` composition at mount time and make the "rejected for an unsupported provider" acceptance criterion vacuous (every use would fail, not just an explicit one) — the provider-level default is what "fail closed" buys without that regression.

`subagent-codex`'s `wire.ts` `startThread()` now sends `sandbox: permissionMode === 'workspace-write' ? 'workspace-write' : 'read-only'` and the literal `approvalPolicy: 'never'` on every `thread/start`, both non-experimental in app-server 0.147.0. Neither is read from `~/.codex/config.toml` — the same delegation now behaves identically regardless of host drift, and `approvalPolicy: 'never'` matches the pinned-approval Note's principle (approvals stay pinned to `'never'`) for the one provider family that Note had left to "their own composition."

`subagent-claude-code`'s `claudeQueryOptions()` sets `settingSources: []` unconditionally in both modes (isolating the child from the host's user/project/local Claude settings, CLAUDE.md, and MCP servers — not from account authentication, which is a separate concern) and `permissionMode: 'default'`, then supplies a fixed `canUseTool`: default-deny, allowing only a fixed tool-name allowlist verified against the pinned SDK's `sdk-tools.d.ts` (`Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch` for `read-only`; add `Write`, `Edit`, `NotebookEdit`, `Bash` for `workspace-write`). `disallowedTools: ['AskUserQuestion']` stays as before.

## Empirical basis (real Claude Code 2.1.220, measured before choosing the mechanism)

| Configuration | `canUseTool` invoked? | Write succeeds? |
|---|---|---|
| Default (prior shipped behavior) | — | **yes** |
| `disallowedTools: ['Write', 'Edit', 'NotebookEdit']` | — | **yes** |
| `permissionMode: 'plan'` | — | blocked, but writes to `~/.claude/plans/` (outside the workspace) |
| `canUseTool` deny, `settingSources` omitted | **never called** | **yes** |
| `canUseTool` deny **+ `settingSources: []`** | called | **blocked** |

A denied `Write` immediately routed around the denial through `Bash` (`printf ... > probe.txt`) in the same run. A denylist is fail-open against any tool it does not enumerate — `Task`, a future SDK addition, or a version drift between the pinned SDK (2.1.220) and an installed CLI (this repo's dev environment ran 2.1.233) — which is why the allowlist is the shape that ships, not a convenience.

## Alternatives considered

- **A model-facing `permission_mode` tool argument** — rejected outright: it lets the delegating model choose its own widened scope per call, contradicting the [pinned-approval Note](2026-08-10-subagent-approval-pinned-never.md)'s parent-owns-widening rule. Not attempted; excluded on the constraint alone.
- **`disallowedTools` denylist** — rejected: empirically ineffective (table above); the host's own pre-approvals meant no permission decision ran at all in the shipped default, and even a hardened denylist still failed open once `Bash` executed the denied intent by another route.
- **`permissionMode: 'plan'`** — rejected: blocked the direct write, but only by relocating it to `~/.claude/plans/`, a write outside the delegated workspace that a `read-only` scope must also forbid.
- **`canUseTool` without `settingSources: []`** — rejected: the host's ambient Claude settings pre-approve enough tools that the callback is never invoked, so the enforcement point does not exist without the isolation flag.
- **A tool-level default materialized and forwarded unconditionally (`z.union([...]).default('read-only')`, always set on the request)** — considered and rejected during implementation: it satisfies the literal English of "fail closed" but forwards `permissionMode` to every provider regardless of capability, so every existing `spawn`/`fork` composition (none of which set this field) would fail to mount, and the "rejected only when explicitly specified against an unsupported provider" acceptance criterion becomes vacuous. The shipped design keeps the field truly optional at the tool layer and moves the fail-closed default into the provider (see Decision).
- **Codex: leaving `sandbox`/`approvalPolicy` to `~/.codex/config.toml`** (the prior behavior) — rejected: this is precisely the host-drift problem the Note closes; an unrelated MCP server's OAuth error already observed leaking into an unrelated delegation's approval behavior in this environment.

## Consequences

- `spawn`, `fork`, `acp`, and `dsh-sdk` compositions are unaffected: none advertise the capability, none accept the field, and `tool-subagent` configurations that never set `permissionMode` behave exactly as before.
- Every `codex` or `claude-code` delegation is `read-only` unless the deployment explicitly configures `permissionMode: 'workspace-write'` on the `tool-subagent` instance that targets it; the delegating model cannot request a wider scope.
- The two providers' `workspace-write` are not equivalent: `codex`'s `sandbox: 'workspace-write'` is an OS-level seatbelt/landlock boundary confining writes to the child's cwd; `claude-code`'s `workspace-write` only widens the fixed tool-name allowlist and enforces no path confinement — a `Write`/`Edit`/`Bash` call can still target a path outside the child's cwd if the real CLI's own tool implementation permits it. Both READMEs document this asymmetry under Known Limitations.
- `subagent-claude-code`'s `settingSources: []` also means the child no longer reads the host's CLAUDE.md or MCP servers, reversing the package's previously documented "reads the host's normal user, project, and local Claude settings" behavior and removing the host-settings-driven context bloat that behavior produced.
- Real-product tests (`packages/subagent/subagent-codex/tests/real-product.spec.ts`, `packages/subagent/subagent-claude-code/tests/real-product.spec.ts`) prove both directions through each provider's own spawn path against a local fixture backend: a `read-only` child reads a file and cannot create one — including via a `Bash`/shell bypass attempt — and a `workspace-write` child can create a file in its own working directory. No live product subscription is required; the fixtures fake the model backend behind a fake API key.
