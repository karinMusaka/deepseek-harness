# Agent Note: a configured `permissionMode` is stated in the `tool-subagent` description

Status: implemented

English | [中文](2026-08-18-subagent-delegation-scope-description.zh.md)

## Problem

The [permission-scope Agent Note](2026-08-17-subagent-delegation-permission-scope.md) let one deployment mount two `dsh-tool-subagent` rows against the SAME provider — one `permissionMode: 'read-only'`, one `permissionMode: 'workspace-write'` — under distinct `toolName`s. `providerWording()` derived the tool `description` only from `SubagentProvider.inheritsParentContext`, so both rows produced a byte-identical description; the only observable difference was the tool name itself (for example `codex_delegate` vs. `codex_delegate_write`). A model choosing between them had no way to tell which one could write without relying on a naming convention no schema enforces — a scope the model cannot see in the contract is a scope it cannot honor, and the repository's own rule requires model-facing contracts to state exactly this kind of task-relevant fact.

## Decision

`packages/subagent/tool-subagent/src/index.ts` adds `permissionScopeWording(permissionMode: SubagentPermissionMode | undefined): string`, composed into the description at the mount site as `wording.description + permissionScopeWording(config.permissionMode) + (backgroundEnabled ? ... : ...)` — inserted between the base capability description and the scheduling suffix so the sentence order reads capability-then-scheduling. It returns `''` when `config.permissionMode` is `undefined`, one sentence for `'read-only'`, and one for `'workspace-write'`, closed over `SubagentPermissionMode`'s two variants with the existing `assertNever` exhaustiveness pattern (mirroring `failureClassPresentation`).

The tool layer states ONLY what the deployment explicitly configured, never the provider's own default: `Config.permissionMode` has no Schemastery `.default(...)` (the permission-scope Note's own reasoning — a materialized tool-level default would forward the field unconditionally to every provider and break every `spawn`/`fork` composition at mount time), and `permissionScopeWording(undefined)` correctly stays silent rather than guessing at a default this package does not own. This means `spawn`/`fork`/`acp`/`dsh-sdk` rows — which never set `permissionMode` at all — see no change to their description, and a `codex`/`claude-code` row that leaves the field at the provider's own `read-only` default (by omission) ALSO states nothing, exactly like an unconfigured row; only an EXPLICIT value changes the description. Two rows against the same provider differing only by an explicit `permissionMode` are now distinguishable by their description alone.

The wording states the grant and the negative guarantee, not a config key or enforcement mechanism: `'read-only'` renders as "This subagent cannot write, edit, or otherwise change anything; it can only read and investigate." `'workspace-write'` renders as "This subagent can create, edit, and delete files in its own working directory." The `workspace-write` sentence states the GRANT (what the child can do, and where) without asserting an exclusivity PROMISE ("only within", "confined to") that neither shipped provider uniformly enforces: the permission-scope Note's own Consequences document that the two providers' `workspace-write` are not equivalent — Codex's is an OS-level sandbox boundary, while Claude Code's only widens a tool-name allowlist with no path confinement of its own, so a `claude-code` child's `Write`/`Edit`/`Bash` call CAN still target a path outside its working directory. A sentence asserting the child is confined there would be false for that provider.

## Alternatives considered

- **Naming the literal config values (`'read-only'`/`'workspace-write'`) in the sentence** — rejected: those are configuration vocabulary, not task-relevant concepts: the repository's model-facing-contract rule asks for what the child can and cannot do, not which config key or enum value produced that fact.
- **Stating the provider's own default when `permissionMode` is omitted** — rejected outright by the field's own design: the tool layer deliberately does not know the provider's default (that knowledge lives in each provider's `start()`, per the permission-scope Note), so stating it here would require the tool to duplicate or query provider-owned knowledge it should not have.
- **An exclusivity promise for `workspace-write`** (e.g. "but only within its own working directory") — rejected: false for `claude-code`, whose allowlist widening enforces no path confinement (measured in the permission-scope Note); a `claude-code` child's `Write`/`Edit`/`Bash` call can still target a path outside its cwd. Stating a guarantee neither provider uniformly holds would mislead the model about the ACTUAL, weaker guarantee `claude-code` provides. The shipped sentence states only where the grant applies (its own working directory), never that writes are confined there.

## Consequences

- `spawn`, `fork`, `acp`, `dsh-sdk` rows, and any `codex`/`claude-code` row that never sets `permissionMode`, see no description change at all — confirmed by the unchanged keyless snapshot suite (no shipped composition configures this field).
- A deployment that explicitly configures `permissionMode` on two rows against the same provider now gives the model a description-level basis to choose the correct one, independent of tool naming.
- `docs/config-catalog.md` and `packages/subagent/tool-subagent/README.md`/`.zh.md` move to reflect that an explicit `permissionMode` is no longer "never model-visible" — it is never a tool ARGUMENT, but it is now stated in the tool description.

## Tests

- `packages/subagent/tool-subagent/tests/tool-subagent.spec.ts`: an explicit `'read-only'` row's description contains the read-only sentence; an explicit `'workspace-write'` row's description contains the workspace-write sentence; a row that omits `permissionMode` against a `permissionMode`-capable provider states nothing about scope. All three assert the base wording (`'does not see this conversation'`) survives alongside the appended sentence, proving append rather than rewrite.
