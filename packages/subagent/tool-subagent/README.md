# @deepseek-ai/dsh-tool-subagent

English | [中文](README.zh.md)

The model-facing delegation tool over one configured `ctx.subagents` provider. Changing the provider changes transport without changing the execution contract.

## Provider selection and lifecycle

Each plugin instance binds one `provider` to one `toolName`; the model receives no provider selector. Load another distinctly named instance to expose another transport. The tool registers only while its provider exists, avoiding sibling load-order and provider-reload dependencies. Its description follows `provider.inheritsParentContext`: fresh children require standalone prompts, while forked children already see completed parent turns.

A foreground call passes the execution signal through startup and execution, awaits `run.result`, and always awaits `run.dispose()` before returning. Only `completed` returns the canonical `{ kind: 'foreground', runId, output: JsonValue[], changedFiles?, usage? }`, rendered as the final text plus a "Files changed" note and a "Tokens used" note when the provider reported either (omitted entirely otherwise — a read-only run's common empty `changedFiles` adds no noise); abort, refusal, token limit, and other failures become errored tool results whose message appends the child's preserved partial text (the `SubagentResult.output` selection) after the stop-reason headline, so a truncated answer is never reported as success yet never silently lost. If result collection and disposal both reject, the errored result preserves both diagnostics.

`backgroundMode` selects both the background route and the omitted `run_in_background` default. `one-shot` waits in the foreground by default; an explicit `true` registers a plain parent-owned Task and returns canonical `{ kind: 'background', jobId }`, rendered as `started background subagent job <id>`, even when the provider supports continuable children. Generic task tools own its later status, collection, cancellation, and notices. `continuable` runs in the background when the argument is omitted or `true`; an explicit `false` waits for the result in the foreground. Its background route requires a provider with the `prepareContinuable` capability, calls `ctx.subagents.startContinuable()`, and returns `{ kind: 'continuable', subagentId }`, rendered as `started subagent <childId>`. The route resolves at inbox acceptance: the child owns its own turns from there, so this call neither waits for nor collects a result. The child's transcript by that id remains the source of its detailed output, and the optional global `send_message` tool sends it more work. The continuation service delivers one settlement notice whenever the child's Activation ends, containing its outcome and any final assistant message independently of `report`. Starting continuable work does not require `send_message` to be loaded. See the [background subagent Agent Note](../../../.agents/notes/implemented/feature/2026-07-08-background-subagent-tasks.md), the [continuable subagents Agent Note](../../../.agents/notes/implemented/feature/2026-07-28-continuable-subagent-conversations.md), and the [background-first delegation Agent Note](../../../.agents/notes/implemented/feature/2026-08-11-background-first-continuable-delegation.md).

`toolFilter` changes the child's global tool layer but is not a parent-derived authority ceiling. See the [agent-scope security non-goal](../../../.agents/notes/implemented/architecture/2026-07-08-agent-scope-contexts.md#security-and-authority-are-non-goals).

`permissionMode` fixes the child's permission scope for every delegation this tool instance starts; it is deployment configuration, never a model-facing tool argument — the model cannot request a wider scope for one call. Omitting the key leaves the provider's own default (`read-only` for every provider that has the capability); an explicit value requires the provider's `permissionMode` capability and fails the mount without it. See the [pinned-approval Agent Note](../../../.agents/notes/implemented/feature/2026-08-10-subagent-approval-pinned-never.md) and the [permission-scope Agent Note](../../../.agents/notes/implemented/feature/2026-08-17-subagent-delegation-permission-scope.md).

`timeoutSeconds` bounds a foreground call and a one-shot background call at this instance's own wall clock — both runs this tool owns start-to-finish, so its timer covers `ctx.subagents.start()` itself (a provider wedged during startup, not only a hung result) as well as the awaited result. On expiry the composed signal aborts exactly like a caller cancellation, but the foreground tool result reads as a timeout, not a cancellation, and a real caller cancellation racing an armed timer still reads as cancelled. Omitting the key preserves today's behavior: no cap. Configuring it together with `backgroundMode: 'continuable'` fails at load — a continuable child's turns belong to the continuation manager after inbox acceptance, not this tool, so there is no run here to stop. See the [wall-clock timeout Agent Note](../../../.agents/notes/implemented/feature/2026-08-17-subagent-delegation-timeout.md).

## Resume (opt-in)

`allowResume` is a deployment-only config key (default `false`); setting it `true` requires the configured provider's `resume` capability and fails the mount without it, and cannot be combined with `backgroundMode: 'continuable'` (rejected at load — the two mechanisms solve different problems on one tool row: a durable, harness-owned multi-turn child vs. a provider-native thread continued outside the harness's own turn model). This is a TWO-LAYER gate, unlike `permissionMode`: `allowResume` (deployment) decides whether the `resume`/`resume_id` tool parameters exist in the model-visible schema AT ALL; within that gate, the model's own per-call `resume: true` or `resume_id: "<id>"` argument is a legitimate request the model is positioned to make (continuing a specific prior run is not a scope-widening decision the way `permissionMode` is). A composition that never sets `allowResume` sees a byte-identical tool schema, result schema, and rendered text to a pre-PR5 subagent call — this feature adds nothing model-visible unless a deployment opts in.

With `allowResume: true`: the schema gains `resume` (boolean) and `resume_id` (string) call arguments, and the foreground result schema gains `resumeId` (model-visible, rendered as `Resume id: <id>` appended to a successful result) and an internal `resumeCwd` field (NOT rendered — carries this call's resolved cwd to the tool's own `presentationMeta` alone). Setting `resume: true` starts a run with its provider-native thread/session kept alive; a successful result then reports `resumeId`, which the model can pass as `resume_id` on a LATER call to continue that exact run instead of starting fresh. `resume_id` is ignored on a `run_in_background: true` call (rejected as a caller error) — resume is meaningful only for a foreground call whose exact context the model can immediately continue.

A `resume_id` the model supplies is verified against this session's own durable log before it ever reaches the provider (see [`dsh-subagent`'s resume authorization](../subagent/README.md#resume-authorization)) — an id this session never issued, or one issued through a different tool row/`permissionMode`/cwd, is rejected with an indistinguishable `Error: subagent resume id was not issued in this scope by this harness session`, never reaching the provider. This tool is the one shipped consumer that WRITES the issuance record: `output.presentationMeta` stamps `tool/result.meta.subagentResume: { id, provider, permissionMode, cwd }` on every successful resumable result, gated on `allowResume` the same way the schema is (a composition that never opts in never stamps this `meta`, keeping `tool/result` byte-identical to a pre-PR5 call). All of PR1-PR4's existing behavior — permission-scope enforcement, wall-clock timeout, failure classification, `changedFiles`/`usage` reporting — applies identically to a resumed call: a resumed run is still one foreground `ctx.subagents.start()` call from this tool's own perspective, just one that happens to continue prior provider-side context. A resume attempt that fails PRE-publication (for example Codex rejecting an unrecognized `thread/resume` id before any thread exists) is classified and rendered through the same headline a post-publication failure gets, via `rethrowStartupFailure()`.

## Failure classification

When a delegation ends with `stopReason: 'error'` and the provider populated `SubagentResult.failure` ([`dsh-subagent-codex`](../subagent-codex/README.md), [`dsh-subagent-claude-code`](../subagent-claude-code/README.md); an in-process provider never does), the model sees a class-specific headline naming what kind of failure it was — authentication, usage limit, provider, or protocol — followed by the provider's own actionable text, screened for credential-shaped patterns (the same vocabulary `@deepseek-ai/dsh-subprocess`'s `scrubbedParentEnv` uses) before it reaches model-visible output and, through it, the session log. The classified failure also raises this package's own `SubagentError` (from `@deepseek-ai/dsh-subagent`) with a routable `SUBAGENT_AUTH`/`SUBAGENT_QUOTA`/`SUBAGENT_PROVIDER`/`SUBAGENT_PROTOCOL` code, reaching `ToolExecutionResult.error.info` through the existing [structured error taxonomy](../../../.agents/notes/implemented/architecture/2026-06-11-structured-error-taxonomy.md) rather than a new mechanism. An `'error'` result the provider could not classify keeps the prior unclassified `subagent run failed` headline and carries no routable code. See the [failure-classification Agent Note](../../../.agents/notes/implemented/feature/2026-08-17-subagent-delegation-failure-classification.md).

## Config

| Key | Meaning |
|---|---|
| `provider` (required) | Provider name (`spawn`, `fork`, `acp`, ...). |
| `toolName` | Model-facing name, default `subagent`; distinct for every loaded instance. |
| `enableRunInBackground` | Exposes background mode, default `true`; disabling also rejects forced background calls. |
| `backgroundMode` | Background lifecycle policy, default `one-shot`. `one-shot` defaults calls to foreground; `continuable` defaults them to background, requires the provider's `prepareContinuable` capability, and returns a durable child id without requiring the follow-up tool. |
| `agentOptions` | Provider-specific child `provider`, `model`, and positive `maxTokens`; the in-process provider treats explicit values as overrides of inherited parent options. |
| `persona` | Per-child persona; requires provider `persona` capability. |
| `toolFilter` | Per-child global-tool restriction; requires `toolFilter` capability. |
| `maxDepth` | Absolute delegation-depth cap, default `3` (`0` forbids delegation); a numeric cap requires the `depthLimit` capability and fails the mount without it. `'provider-managed'` sends no cap for an out-of-process provider whose budget belongs to the child harness. The tool stays visible at the cap; each attempted start checks the calling agent's current depth and returns an errored tool result when rejected. |
| `permissionMode` | Fixed child permission scope (`'read-only'` \| `'workspace-write'`); requires the `permissionMode` capability and fails the mount without it. Omitted leaves the provider's own default (`read-only`). Never model-visible — a deployment-only choice. |
| `timeoutSeconds` | Wall-clock cap, in seconds, on this instance's own foreground and one-shot background runs; a positive finite number no greater than `MAX_TIMER_DELAY_MS` (`@deepseek-ai/dsh-timeout`) in milliseconds. Omitted leaves no cap (today's behavior); no Schemastery default is materialized, so existing `spawn`/`fork` compositions are unaffected until a deployment opts in. Fails at load together with `backgroundMode: 'continuable'`. |
| `allowResume` | Exposes the `resume`/`resume_id` tool arguments and `resumeId` result field, default `false`. Requires the `resume` capability and fails the mount without it. Fails at load together with `backgroundMode: 'continuable'`. See "Resume (opt-in)" above. |

## Concurrency

Foreground and background calls are concurrency-safe: sibling delegations in one assistant message overlap under the loop's rolling pool (`maxParallelToolCalls`), and results still commit in model order. Children work in their own sessions and a run never mutates the parent session; the one-shot background form's one parent-owned write — registering a Task — is a synchronous, commutative insertion that tolerates concurrent dispatch, so overlapping background calls acquire their job ids in dispatch-race order. Coordinating sibling workspace effects belongs to the model, exactly as it already does for background and continuable children. See the [parallel subagent Agent Note](../../../.agents/notes/implemented/feature/2026-08-09-parallel-subagent-delegations.md) and the [parallel tool-call Agent Note](../../../.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md).

## Model Experience

### Tool schema

#### What the model sees

The generated default [`subagent` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent) under this instance's configured name while its provider exists. Provider context inheritance changes the tool and prompt descriptions. Enabled background mode adds `run_in_background`: continuable mode documents its `true` default, runtime settlement notice, and explicit foreground override, while one-shot mode documents its `false` default and the job id collected with `job_output` or stopped with `job_kill`. While the tool is visible in an assembly's scope, a `tool:<toolName>` system-prompt section tells the model to start independent continuable delegations together, keep working while they run, and choose foreground only when its next action depends on the result; a tool restriction removes both its schema and this guidance.

#### Token effect

Fixed schema cost per parent request; each provider instance adds one schema, and each continuable instance adds one short system-prompt section.

#### KV Cache effect

Prefix-stable while provider instances, names, descriptions, and schemas are unchanged. Provider registration lifecycle may invalidate parent reuse from the first changed tool definition.

### Foreground result

#### What the model sees

The call retains the description and prompt. Success contains the child's final text, followed by a "Files changed:" list of absolute paths, a "Tokens used: … in, … out" line, and — only when `allowResume` is configured and the provider reported one — a "Resume id: <id>" line; each present only when the underlying field is reported at all, an in-process provider or a read-only run adding none of the three. Other outcomes become `Error: <message>`. Intermediate child steps stay out of the parent. A configured `timeoutSeconds` that stops the run reads as `Error: subagent run hit its <N>s time limit before finishing` (plus any preserved partial text) — distinct from `Error: subagent run was cancelled`, the caller-cancellation message, so the model never confuses the two. A classified native failure (see Failure classification above) reads as `Error: subagent could not authenticate with its provider: <provider's own text>` or the matching line for a usage-limit, provider, or protocol failure. A rejected resume (`resume_id` not issued in this scope) reads as `Error: subagent resume id was not issued in this scope by this harness session`, indistinguishable whether the id was never issued at all or issued under a different scope.

#### Token effect

The prompt and result remain in parent history until compaction; child working context remains in the child.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Background result

#### What the model sees

Start returns exactly `started subagent <childId>` in configured continuable mode, or `started background subagent job <id>` in configured one-shot mode. In one-shot mode the generic task surface provides later status, final output, cancellation responses, and notices. In continuable mode this tool returns no result of its own; the child's settlement reaches the parent as a [service-owned notice](../subagent/README.md#settlement-notice), an independently loaded `send_message` tool delivers follow-ups, and the child's transcript by its id is the source of its detailed output.

#### Token effect

The acknowledgement is retained; a one-shot final output enters parent history only when collected or injected, while a continuable child's output never returns through this tool — its settlement notice arrives independently of any tool result.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Background runs expose no result through this tool** — a one-shot task's final output is collected through the generic task surface, and a continuable child's output stays in its own session, read by its subagent id. The settlement notice states how that child ended and carries any final assistant message, but it is not this call's return value and cannot be awaited here.
- **Duplicate names across waiting one-shot instances are detected late** (`TODO(subagent-dup-toolname)`) — continuable instances reserve their prompt-section name during plugin application, but preventing provider-registration rollback for waiting one-shot instances requires a registry of intended names.
- **Child policy is fixed per instance** — another model, persona, tool filter, or depth cap requires another distinctly named tool.
- **A one-shot background run's timeout is invisible to the generic task surface** — `job_output`/the settlement notice reports a timed-out one-shot child exactly like a `job_kill`ed one (`[status: killed]`); only the foreground path's tool result names the timeout distinctly. Widening the shared `JobOutcome` for this is deferred; see the [wall-clock timeout Agent Note](../../../.agents/notes/implemented/feature/2026-08-17-subagent-delegation-timeout.md).
- **Redaction is pattern-based, not exhaustive** — `redactCredentialShapedText` masks a credential-shaped label immediately followed by `:`/`=` and a value; a leaked secret in a different shape (no adjacent label, or a shape neither `KEY`/`PASSWORD`/`SECRET`/`TOKEN` names) is not caught. This is the same vocabulary `scrubbedParentEnv` uses to keep a credential out of a spawned child's own environment, not a general secret scanner.
- **`changedFiles` never includes a `Bash`/shell-driven write on either provider** — see [`dsh-subagent-claude-code`](../subagent-claude-code/README.md#known-limitations-and-deferred-work) and [`dsh-subagent-codex`](../subagent-codex/README.md#known-limitations-and-deferred-work). A deployment cannot treat this tool's `changedFiles` note as a complete audit of every file a `workspace-write` child touched.
- **`changedFiles`/`usage` never reach a one-shot background run's `job_output`** — both fields exist only on the foreground `ForegroundToolResult` this tool builds directly; the one-shot background path's `JobOutcome` (`dsh-jobs`) is unchanged by this feature, same scope cut as the existing background-timeout limitation above.
- **Resume never reaches a background run's `job_output` either, and is rejected outright for `run_in_background: true`** — same scope cut as `changedFiles`/`usage` above; `resume_id` is meaningful only for a foreground call this tool directly awaits and can immediately continue.
- **A resumed run's provider-native thread/session becomes visible in the host's own product history** — `codex`'s persistent thread is stored in `~/.codex`'s conversation history exactly like the user's own interactive sessions; Claude's resumed session is stored in `~/.claude/projects/`, cwd-keyed, and appears in the user's own `claude --resume` picker. A deployment that opts into `allowResume` should treat this as a durable, host-visible side effect of the feature, not an internal implementation detail — see each provider's own README ([`dsh-subagent-codex`](../subagent-codex/README.md#known-limitations-and-deferred-work), [`dsh-subagent-claude-code`](../subagent-claude-code/README.md#known-limitations-and-deferred-work)).
- **A resumed child's own internal state is not reconstructable from the parent's Session log** — see [`dsh-subagent`'s own note](../subagent/README.md#known-limitations-and-deferred-work); this tool's log still faithfully records the resume id, the request, and the result, but not what the child's own persisted thread/session now contains.
