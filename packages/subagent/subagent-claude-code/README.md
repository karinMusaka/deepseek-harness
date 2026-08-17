# @deepseek-ai/dsh-subagent-claude-code

English | [中文](README.zh.md)

This package registers the fixed `claude-code` subagent provider. Each accepted run invokes the official Claude Agent SDK in the delegating Session's workspace, resolves the native `claude` executable through the shared subprocess service, submits one self-contained text task, and returns only the final answer through the shared [`dsh-subagent`](../subagent/README.md) result contract.

## Start and ownership

`start(request)` accepts only a non-empty sequence of text blocks and derives the child cwd from the parent Session. It creates one private `AbortController`, calls the official SDK `query()`, and publishes the run only after the SDK's `spawnClaudeCodeProcess` hook has supplied a live CLI handle owned by [`dsh-subprocess`](../../subprocess/subprocess/README.md). A failure or cancellation before publication closes the query, terminates any acquired process tree, waits for it to exit, and rejects `start()`.

The SDK receives the exact concatenated text task. The provider iterates the complete SDK message stream and accepts only a `result` message with `subtype: "success"`, `is_error: false`, and a nonblank `result`, followed by normal iterator completion. Every SDK error subtype, an error-marked success, a missing answer, iterator failure, protocol failure, or process failure maps to `error`; the provider produces neither `max-tokens` nor `refusal`.

Local cancellation wins the result race and maps to `aborted`. `dispose()` is idempotent: it aborts the run, asks the SDK query to close, invokes the shared process-tree termination escalation, and waits for whole-tree exit. SDK graceful close expresses protocol intent; the subprocess handle remains the authority for process quiescence. Result failure and independent teardown failure remain separate.

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

Through `dsh-tool-subagent`, the parent sees only the strict final Claude Code answer or the consumer's exact error for a non-completed result. Claude Code reasoning, tool activity, intermediate messages, stderr, workspace diffs, usage, and product ids are not copied into the parent Session.

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
- **Final text only** — reasoning, intermediate messages, tool traffic, usage, stderr, and workspace diffs remain product-local.
- **No optional shared capability besides `permissionMode`** — output schemas, child personas, tool filtering, and harness depth enforcement are rejected by the shared service for this provider.
- **No wall-clock timeout or side-effect rollback** — the caller cancels long work, and files or external systems changed before cancellation are not restored.
