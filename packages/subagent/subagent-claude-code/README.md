# @deepseek-ai/dsh-subagent-claude-code

English | [中文](README.zh.md)

This package registers the fixed `claude-code` subagent provider. Each accepted run invokes the official Claude Agent SDK in the delegating Session's workspace, resolves the native `claude` executable through the shared subprocess service, submits one self-contained text task, and returns only the final answer through the shared [`dsh-subagent`](../subagent/README.md) result contract.

## Start and ownership

`start(request)` accepts only a non-empty sequence of text blocks and derives the child cwd from the parent Session. It creates one private `AbortController`, calls the official SDK `query()`, and publishes the run only after the SDK's `spawnClaudeCodeProcess` hook has supplied a live CLI handle owned by [`dsh-subprocess`](../../subprocess/subprocess/README.md). A failure or cancellation before publication closes the query, terminates any acquired process tree, waits for it to exit, and rejects `start()`.

The SDK receives the exact concatenated text task. The provider iterates the complete SDK message stream and accepts only a `result` message with `is_error: false` and a nonblank `result`, followed by normal iterator completion — classified from `is_error` directly, never the result message's own `subtype` (a real logged-out run reports `is_error: true` while `subtype` stays `"success"`; see Failure classification below). Every classified error, a missing answer, iterator failure, protocol failure, or process failure maps to `error`; the provider produces neither `max-tokens` nor `refusal`.

Local cancellation wins the result race and maps to `aborted`. `dispose()` is idempotent: it aborts the run, asks the SDK query to close, invokes the shared process-tree termination escalation, and waits for whole-tree exit. SDK graceful close expresses protocol intent; the subprocess handle remains the authority for process quiescence. Result failure and independent teardown failure remain separate.

### Changed files and usage

A `completed` result also carries `changedFiles` (absolute paths, deduplicated) and `usage` (`{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`) when the run's own stream carried either — see [`dsh-subagent`](../subagent/README.md#one-shot-ownership-and-lifecycle) for the shared contract and inclusion rule. `changedFiles` collects `Write`/`Edit`/`NotebookEdit` `tool_use` blocks (`file_path`/`notebook_path` respectively — there is no `MultiEdit` tool in the pinned SDK) from assistant messages, but reports a candidate only once BOTH hold: a same-id `tool_result` in a later user message reports no error, AND the id is absent from the terminal result's own `permission_denials`. **A denied or failed tool call's `tool_use` block exists on the wire exactly like a successful one** (measured; a read-only run's denied `Write`/`Bash` both produced ordinary `tool_use` blocks) — collecting `tool_use` presence alone would misreport a read-only run as having written files, so positive success evidence is required, never absence-of-denial alone. **A relative `file_path`/`notebook_path` is resolved against the child's own cwd before reporting** — measured: the raw `tool_use.input.file_path` value can be relative (e.g. `"made.txt"`) despite the SDK's own type documentation calling it "The absolute path to the file to modify"; the real CLI resolves it internally before executing, but the value crossing the wire is the model's raw, unresolved string. `usage` reads the terminal result message's own `usage` field, normalized to the shared cache-inclusive `inputTokens` meaning (Claude's native `input_tokens` excludes both cache fields, so they are summed in). See the [changed-files-and-usage Agent Note](../../../.agents/notes/implemented/feature/2026-08-17-subagent-delegation-changed-files-and-usage.md) for the full measured evidence.

### Failure classification

An `error` stop reason carries a classified `SubagentResult.failure` (`auth`/`quota`/`provider`/`protocol`, see [`dsh-subagent`](../../../docs/subsystems/subagent.md#the-terminal-result-subagentresult)). The provider also consumes `assistant` messages (otherwise skipped) to retain the most specific `SDKAssistantMessageError` seen: `authentication_failed`/`oauth_org_not_allowed` classify `auth`; `rate_limit`/`billing_error`/`overloaded` classify `quota`; the remaining named values classify `provider`; `max_output_tokens` is a per-message truncation note, not a terminal-failure signal, and is not retained. At the terminal result, that retained cause wins; failing that, the result's own `api_error_status` (401 → `auth`, 429 → `quota`) decides; failing that, the cause classifies `provider`. `protocol` never applies here — the SDK abstracts its own wire transport entirely. An unrecognized future `SDKAssistantMessageError` value falls through to `provider` rather than failing closed. `SubagentResult.authMode` is `'api-key'` when `Config.env` sets a credential-shaped variable name, `'subscription'` otherwise — derived purely from that configuration, never by reading `~/.claude`.

## Native settings and permission scope

Every query sets `settingSources: []`. The official SDK therefore does **not** read the host's user, project, or local Claude settings, CLAUDE.md, or MCP server configuration — the child's world is fixed entirely at delegation, so the same delegation behaves identically regardless of drift in the host's own Claude configuration. Login/account state and network authentication remain native (this option controls filesystem settings, not authentication); the provider neither copies nor filters those files and does not create or modify login state.

Each query also sets `permissionMode: 'default'` and a fixed `canUseTool` enforcing `request.permissionMode` (absent means `read-only`, the seam's documented provider default): a default-deny allowlist of read-only tool names (`Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`) for `read-only`, extended with `Write`, `Edit`, `NotebookEdit`, and `Bash` for `workspace-write`. This is an allowlist, not a denylist — a tool this pin does not yet enumerate (a future SDK addition, or a version drift between the pinned SDK and the installed CLI) stays denied instead of failing open. `disallowedTools: ['AskUserQuestion']` remains unconditional in both modes.

Each query sets `persistSession: false`. It supplies no elicitation or dialog callback, so an unattended interaction outside the fixed allowlist fails through a `canUseTool` denial instead of waiting for a user interface this provider does not own.

## Capabilities and context

The provider advertises the `permissionMode` start-time capability (enforced as above) and no other optional capability; it reports `inheritsParentContext: false`. Claude Code receives the standalone text task, the parent Session cwd, and the fixed permission scope, but not the parent conversation, persona, tool filter, depth policy, or structured-output contract. Every run has an independent SDK query, cancellation controller, CLI process, and non-persisted product session.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `env` | `{}` | Explicit SDK/CLI environment layered over the shared credential-scrubbed parent environment. |
| `disposeGraceMs` | `3000` | Positive finite grace in milliseconds, no greater than [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md), between the shared process-tree owner's termination tiers; disposal then waits for whole-tree exit. |

Production resolves `claude` from the subprocess execution world's credential-scrubbed `PATH`, with explicit `env` entries applied, and passes the resulting path to the SDK as `pathToClaudeCodeExecutable`. On Windows, a resolved `.cmd` or `.bat` path is carried as a quoted, per-spawn environment value that `cmd.exe /v:off` expands once, so valid path metacharacters remain data. The pinned SDK's fixed flags then occupy cmd's command tail and contain no cmd metacharacters; they are not ordinary Windows argv. Native settings and authentication remain authoritative. The plugin does not install another CLI, select a model, create a product home, log in, or probe an account. Credential-shaped ambient variables are removed before the explicit `env` overlay is applied, so an API key or token intended for the child must be supplied there. Non-credential endpoint variables such as `ANTHROPIC_BASE_URL`, along with ordinary ambient values such as `PATH` and `HOME`, remain inherited unless overridden.

Shipped profiles load this provider once on the host and start no Claude process until a tool call. Full Agent Presets carry the tool row below with `disabled: true`; copy a preset and remove that field to expose `subagent_claude_code` only to agents composed from the copy. A custom host composition can still use both rows directly.

```yaml
- id: subagent-claude-code
  name: '@deepseek-ai/dsh-subagent-claude-code'
  config:
    env:
      ANTHROPIC_API_KEY: !!js process.env.ANTHROPIC_API_KEY

- id: tool-subagent-claude-code
  name: '@deepseek-ai/dsh-tool-subagent'
  disabled: true
  config:
    provider: claude-code
    toolName: subagent_claude_code
    enableRunInBackground: false
    maxDepth: provider-managed
```

## Product compatibility and evidence

The runtime dependency is pinned to `@anthropic-ai/claude-agent-sdk@0.3.220`. Production runs the native `claude` installation. The keyless real-product test uses the SDK-distributed Claude Code 2.1.220 CLI as a deterministic fixture, routed through the same native executable-resolution and Windows batch-shim path; it does not claim compatibility with every independently installed version. Loader composition proves that both product packages coexist without starting either product.

The project owner's identity-scoped distribution authorization covers the official SDK and the official CLI/platform payloads declared by each SDK version. [`THIRD_PARTY_NOTICES.md`](../../../THIRD_PARTY_NOTICES.md) discloses the current optional payload closure without classifying its declared terms as permissive; unrelated non-permissive runtime dependencies continue to fail the notices gate.

## Model Experience

### Child request

#### What the model sees

The Claude Code child receives the standalone text task as one fresh SDK query. Its workspace is the parent Session cwd and its permission scope is fixed at delegation (`read-only` unless the deployment configures `workspace-write`); its model, system instructions, and native authentication come from the SDK's own defaults and the host's product installation, not the host's filesystem settings (`settingSources: []`).

#### Token effect

The child pays for an independent Claude Code context and query. Child tokens do not enter the parent's context.

#### KV Cache effect

Independent of the parent request cache. Reuse depends only on Claude Code's own model, instructions, tools, native settings, and fresh query.

### Parent tool result, indirectly

#### What the model sees

Through `dsh-tool-subagent`, the parent sees only the strict final Claude Code answer, its `changedFiles`/`usage` when either was observed, or the consumer's exact error for a non-completed result. A classified `error` reaches the model as a class-specific headline (e.g. "subagent could not authenticate with its provider: …") plus Claude Code's own actionable text (e.g. `"Not logged in · Please run /login"`), screened for credential-shaped patterns. Claude Code reasoning, tool activity, intermediate messages, stderr, and product ids are not copied into the parent Session.

#### Token effect

Parent input grows only by the final answer or error retained in the tool result. This provider adds no parent tool schema by itself.

#### KV Cache effect

Append-only: the new tool result follows the reusable parent request prefix.

## Known Limitations and Deferred Work

- **One fresh query and process per run** — there is no continuation, resume, pooling, progress stream, or product-session persistence.
- **`workspace-write` is an allowlist broadening, not OS path confinement** — unlike the `codex` sibling's `sandbox: 'workspace-write'` (an OS-level seatbelt/landlock boundary), this provider's `workspace-write` only widens the fixed tool-name allowlist; a `Write`/`Edit`/`Bash` call the model issues can still target a path outside the child's own working directory if the real CLI's own tool implementation permits it. The seam's `permissionMode` JSDoc describes the confining case; here it is a closer approximation than a proof.
- **Product installation and account state remain native** — a missing or incompatible `claude`, configuration error, or authentication failure is surfaced as a startup or run error; the plugin provides no installer or login flow.
- **The SDK platform CLI remains in the install closure** — production ignores it in favor of the host `claude`, but the current SDK optional dependency is still installed and supplies the keyless compatibility fixture. Removing that payload belongs to the separate product installation-closure follow-up.
- **No human interaction path** — `AskUserQuestion` is disabled and other interactive callbacks are absent, so tasks requiring new approval or input fail instead of suspending.
- **Final text, changed files, and usage only** — reasoning, intermediate messages, tool traffic, and stderr remain product-local; only the final answer, `changedFiles`, and `usage` cross into the shared result (see "Changed files and usage" above).
- **A `Bash` write is invisible to `changedFiles`** — a shell command has no inspectable `file_path` argument this collector can read, so a change made through `Bash` (which PR1's `workspace-write` scope allows) is never reported, even though the file was actually written. A deployment relying on `changedFiles` for an audit trail under `workspace-write` cannot assume it enumerates every file the child touched; the `codex` sibling's OS-level sandbox captures an `apply_patch`-driven shell change as a `fileChange` item, but likewise misses a plain shell write (see that package's README) — the asymmetry is real but narrower than "Claude misses everything, Codex misses nothing."
- **`changedFiles`/`usage` are absent on an `aborted` or unclassified `error` result** — both are populated only on the success branch of `consumeClaudeQuery()`; a cancelled or unclassified-failure run carries no partial file or usage accounting (same gap as the shared package's own note).
- **No optional shared capability besides `permissionMode`** — output schemas, child personas, tool filtering, and harness depth enforcement are rejected by the shared service for this provider.
- **No wall-clock timeout or side-effect rollback** — the caller cancels long work, and files or external systems changed before cancellation are not restored.
- **`protocol` is unreachable for this provider** — the SDK owns its own wire transport end to end, so a shape deviation there never reaches this provider as a classifiable cause; a stream or process crash before any result message surfaces as an unclassified `error` instead.
- **Failure classification is best-effort against an external, open vocabulary** — `SDKAssistantMessageError` may grow in a future SDK release; an unrecognized value classifies as `provider` rather than failing closed.
- **`authMode` reports configuration, not live account state** — it never probes `~/.claude`, so a deployment that sets a credential-shaped `env` entry the child never actually uses (or vice versa) reports the configured intent, not a verified fact about which credential the child used for a given run.
