# @deepseek-ai/dsh-subagent-codex

English | [中文](README.zh.md)

This package registers the fixed `codex` subagent provider. Each accepted run starts the official `codex app-server --stdio` command in the delegating Session's workspace, creates one ephemeral Codex thread, submits one self-contained text task, and returns only the final answer through the shared [`dsh-subagent`](../subagent/README.md) result contract.

## Start and ownership

`start(request)` accepts only a non-empty sequence of text blocks and derives the child cwd from the parent Session. It then spawns the fixed command through [`dsh-subprocess`](../../subprocess/subprocess/README.md), performs `initialize` → `initialized` → `thread/start { cwd, ephemeral, sandbox, approvalPolicy: 'never' }` (`ephemeral: true` unless the call opted into resume — see "Resume (opt-in)" below), and publishes the run only after Codex returns a thread whose reported `ephemeral` matches what was requested. `sandbox` is `read-only` unless `request.permissionMode` is `workspace-write`; `approvalPolicy` is always the explicit literal `'never'`, never the host's own `~/.codex/config.toml`, so the same delegation behaves identically regardless of host configuration drift. A failure or cancellation before publication closes the wire, terminates the managed process tree, waits for it to exit, and rejects `start()`.

The published `run.result` starts exactly one turn. It accepts only notifications for that run's thread and turn, then waits for the authoritative `turn/completed` terminal notification. The latest `agentMessage` with `phase: "final_answer"` wins; when Codex emits no explicit final phase, the latest message with `phase: null` is the compatibility fallback. Commentary never replaces either answer, and a successful turn with no nonblank answer settles as an error.

For command and file approvals, the unattended provider selects a non-approval decision offered by the request, preferring `cancel`; the stable 0.147.0 request shape without an offered-decision list falls back to `decline`. It answers permission requests with an empty turn-scoped permission set, answers user-input requests with no answers, and declines MCP elicitation. A request with no legal unattended response, or any unknown server request, fails the run. In practice, `approvalPolicy: 'never'` means codex-core rejects a command that needs escalated permissions itself, as the function's own output, before ever sending this provider an approval request — so this unattended-decision path is exercised at the protocol level by this package's own tests, not by every real command Codex declines.

Local cancellation wins the result race and maps to `aborted`. A failed turn whose `codexErrorInfo` is `contextWindowExceeded` maps to `max-tokens`; every other remote interrupted or failed turn maps to `error`, and the provider produces no `refusal`. `dispose()` is idempotent: it requests a best-effort `turn/interrupt` with both current ids when they are known, closes the JSON-RPC wire, ends stdin, invokes the shared process-tree termination escalation, and waits for whole-tree exit. Result failure and independent teardown failure remain separate.

### Changed files and usage

A `completed` or `max-tokens` result also carries `changedFiles` (absolute paths, deduplicated) and `usage` (`{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`) when the wire observed either — see [`dsh-subagent`](../subagent/README.md#one-shot-ownership-and-lifecycle) for the shared contract and inclusion rule. `changedFiles` collects only `item/completed` `fileChange` items whose own `status` is `'completed'`; a `declined`/`failed`/`inProgress` item is silently skipped, never reported (measured; see the [Agent Note](../../../.agents/notes/implemented/feature/2026-08-17-subagent-delegation-changed-files-and-usage.md)). `thread/tokenUsage/updated` carries two distinct fields: `total` is the THREAD's lifetime-cumulative usage (measured: it never resets across a `thread/resume`, so a resumed call's first notification already carries the prior call's total baked in) and `last` is the individual model call's own usage, non-cumulative even within one turn. `usage` sums each notification's `last` field across the current turn only, never reading `total` — the only construction that reports THIS call's own usage correctly on both a fresh thread and a resumed one (measured; see the [resume Agent Note](../../../.agents/notes/implemented/feature/2026-08-18-subagent-delegation-resume.md)). `turn/diff/updated` (also observed on the real app-server) is deliberately not used: it carries an unstructured unified-diff blob for the whole turn, while `fileChange`'s per-item, per-path, status-qualified shape is what `changedFiles` needs.

**Measured: only `apply_patch`-driven writes produce a `fileChange` item.** A plain shell write (e.g. `printf WROTE > marker.txt` through `exec_command`/`shell_command`) creates the file but reports only a `commandExecution` item — never `fileChange` — so it is invisible to `changedFiles` exactly like a Claude `Bash` write is invisible to that provider's own collector (see that package's README). Codex's own system instructions tell the model to "Always use `apply_patch` for manual code edits," which keeps this gap narrow in practice but does not close it. A read-only child's `apply_patch` attempt is rejected by the OS sandbox before codex-core ever emits an item for it at all (not a `declined`-status item) — the empty-`changedFiles` outcome is the same either way.

### Resume (opt-in)

This provider advertises the `resume` start-time capability. A caller that sets `request.requestResume: true` starts a PERSISTENT thread (`thread/start { ephemeral: false, ... }`) instead of the default ephemeral one; a successful `completed`/`max-tokens` result then carries `resumeId: thread.id`. A later call that sets `request.resumeId` to a value the caller already holds resumes that exact thread instead of starting fresh: `thread/resume { threadId, sandbox, approvalPolicy: 'never' }` (the wire's own field is camelCase `threadId` — the Rust source's `thread_id` fails the app-server's own field-name validation) re-pins `sandbox`/`approvalPolicy` on every resume exactly as `thread/start` does, so a resumed child's permission scope is never wider than what THIS call's `request.permissionMode` grants, regardless of what scope the thread happened to run under previously. An unrecognized or already-resumed-elsewhere thread id rejects `thread/resume` before any thread is ever (re-)published; this provider classifies that rejection the same way a post-publication native failure is classified (`SubagentFailureDetail { code: 'provider', ... }`), never an unclassified crash. Resuming into a mismatched thread (the app-server returns a thread whose reported id differs from the one requested) is rejected as a defensive integrity check, not classified as a native provider failure. This capability is deployment-gated one layer up, in [`dsh-tool-subagent`](../tool-subagent/README.md#resume-opt-in)'s `allowResume` config key — a model can request resume only when the deployment has opted in.

### Failure classification

An `error` stop reason carries a classified `SubagentResult.failure` (`auth`/`quota`/`provider`/`protocol`, see [`dsh-subagent`](../../../docs/subsystems/subagent.md#the-terminal-result-subagentresult)) whenever the wire can classify the cause. The app-server's own intermediate `error` notifications — which `turn/completed` does not repeat — carry the useful structured cause; a real unauthenticated run degrades the terminal turn's own `codexErrorInfo` to the literal `"other"`, so this provider retains the most specific cause seen across the turn's `error` notifications instead of trusting the terminal one alone (measured; see the [failure-classification Agent Note](../../../.agents/notes/implemented/feature/2026-08-17-subagent-delegation-failure-classification.md)). `httpStatusCode === 401` or `codexErrorInfo === 'unauthorized'` classifies `auth`; `httpStatusCode === 429` or `'usageLimitExceeded'`/`'serverOverloaded'` classifies `quota`; any other native cause classifies `provider`; a JSON-RPC shape deviation this wire's own validators reject classifies `protocol`. An unrecognized future `codexErrorInfo` value falls through to `provider` rather than failing closed. `SubagentResult.authMode` is `'api-key'` when `Config.env` sets a credential-shaped variable name, `'subscription'` otherwise — derived purely from that configuration, never by reading `~/.codex`.

## Capabilities and context

The provider advertises the `permissionMode` and `resume` start-time capabilities (`sandbox` on `thread/start`/`thread/resume`, and provider-native thread continuation, both above) and no other optional capability; it reports `inheritsParentContext: false`. Codex receives the standalone text task, the parent Session cwd, and the fixed permission scope, but not the parent conversation, persona, tool filter, depth policy, or structured-output contract. The Codex thread id and turn id stay private to this run and are never persisted in the parent Session directly — a resumable run's thread id is exposed ONLY as `SubagentResult.resumeId`, and only `dsh-tool-subagent`'s own opt-in `allowResume` logging (not this package) writes it into the durable Session log.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `env` | `{}` | Explicit child environment layered over the subprocess seam's credential-scrubbed parent environment. |
| `disposeGraceMs` | `3000` | Positive finite grace in milliseconds, no greater than [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md), between the shared process-tree owner's termination tiers; disposal then waits for whole-tree exit. |

Production resolves `codex` from `PATH` and uses the host's native Codex configuration and authentication. The plugin does not install Codex, select a model, create `CODEX_HOME`, log in, or probe a version. Credential-shaped ambient variables are removed by the subprocess seam, so an API key intended for the child must be supplied explicitly in `env`; ordinary ambient values such as `PATH` and `HOME` remain available unless overridden.

Production `dsh` does not install or mount this optional provider. A Profile that opts in must install `@deepseek-ai/dsh-subagent-codex` and mount it once on the host plane; loading the provider starts no Codex process until a tool call. Full Agent Presets carry a matching product tool row with `disabled: true`; copy a preset and remove that field to expose `subagent_codex` only to agents composed from the copy. Its `one-shot` policy keeps omitted or `false` `run_in_background` calls in the foreground, while explicit `true` returns a parent-owned Job id for `job_output` or `job_kill`. The base host and full presets already provide the generic Job registry and controls.

The standalone composition below shows the complete explicit capability. A Profile based on `@deepseek-ai/dsh-base` keeps its existing Job rows, adds the product provider row, and enables the preset tool row instead of mounting duplicate Job services.

```yaml
- id: subagent-codex
  name: '@deepseek-ai/dsh-subagent-codex'
  config:
    env:
      OPENAI_API_KEY: !!js process.env.OPENAI_API_KEY

- id: jobs
  name: '@deepseek-ai/dsh-jobs-local'

- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'

- id: tool-subagent-codex
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: codex
    toolName: subagent_codex
    backgroundMode: one-shot
    maxDepth: provider-managed
```

## Product compatibility and evidence

The production wire intentionally implements only the app-server methods required by this one-shot contract. Development evidence is pinned to `@openai/codex@0.147.0` / `codex-cli 0.147.0`; the npm package is a test-only dependency, and deployments still supply `codex` on `PATH`.

## Model Experience

### Child request

#### What the model sees

The Codex child receives the standalone text blocks as one turn in a fresh ephemeral thread. Its workspace is the parent Session cwd, its sandbox and approval policy are fixed at delegation (`read-only`/`never` unless the deployment configures `workspace-write`), and its model, system instructions, tools, and authentication come from the native Codex installation and configuration.

#### Token effect

The child pays for an independent Codex context and turn. Child tokens do not enter the parent's context.

#### KV Cache effect

Independent of the parent request cache. Reuse depends only on Codex's own provider, model, instructions, tools, and ephemeral-thread request.

### Parent scheduling and results, indirectly

#### What the model sees

Through `dsh-tool-subagent`, a foreground call gives the parent the selected final Codex answer, its `changedFiles`/`usage` when either was observed, or the consumer's exact error for a non-completed result; a background call first returns a Job id, and the generic job controls later deliver a completion notice, expose the final answer and status through `job_output`, and let `job_kill` request cancellation — `job_output` never carries `changedFiles`/`usage`, which reach the model only on a foreground call. A classified `error` reaches the model as a class-specific headline (e.g. "subagent could not authenticate with its provider: …") plus Codex's own actionable text, screened for credential-shaped patterns. Codex commentary, reasoning, tool activity, stderr, workspace diffs, and product ids are not copied into the parent Session.

#### Token effect

Foreground input grows by the retained final answer or error. Background input also includes the start acknowledgement, completion notice, and any `job_output`, `job_kill`, or later status results; child tokens still do not enter the parent context. This provider adds no parent tool schema by itself.

#### KV Cache effect

Append-only: foreground adds one result after the reusable parent prefix, while background appends the Job acknowledgement, notice, and later control or collection results. Background scheduling can add a notice-driven turn, but none of these messages rewrites the earlier prefix.

## Known Limitations and Deferred Work

- **One fresh process and turn per run; thread continuation is opt-in only** — there is no pooling or progress stream, and resume (see "Resume (opt-in)" above) keeps only the app-server's own thread state, never this process — a resumed call still spawns a fresh `codex app-server` process that reattaches to the persisted thread by id.
- **Host-managed product installation and account state** — a missing or incompatible `codex`, configuration error, or authentication failure is surfaced as a startup or run error; the plugin provides no installer, login flow, or runtime version gate.
- **Compatibility is pinned by development evidence** — upgrading from the verified 0.147.0 protocol baseline requires regenerating upstream schema evidence and rerunning handshake, answer-selection, approval, cancellation, keyless real-product, and credentialed DeepSeek nonce tests.
- **No human approval path** — `approvalPolicy` is always the fixed literal `'never'`; known unattended approval requests are denied and unknown server requests fail closed; deployments cannot configure an allow policy through this package.
- **Final text, changed files, and usage cross via a foreground call only** — reasoning, commentary, intermediate messages not selected as the answer, tool traffic, stderr, and the raw unified-diff text of `turn/diff/updated` remain product-local; only the final answer, `changedFiles`, and `usage` cross into the shared result on a foreground call (see "Changed files and usage" above), while a background call's Job id, completion notice, and status come from the shared job runtime, not this provider.
- **No optional shared capability besides `permissionMode` and `resume`** — output schemas, child personas, tool filtering, and harness depth enforcement are rejected by the shared service for this provider.
- **No wall-clock timeout or side-effect rollback** — the caller cancels long work, and files or external systems changed before cancellation are not restored.
- **Failure classification is best-effort against an external, open vocabulary** — `codexErrorInfo`'s enum may grow in a future app-server release; an unrecognized value classifies as `provider` rather than failing closed, so a new native cause is never misreported as `auth`/`quota` but may initially classify more coarsely than a later update of this package would.
- **`authMode` reports configuration, not live account state** — it never probes `~/.codex`, so a deployment that sets a credential-shaped `env` entry the child never actually uses (or vice versa) reports the configured intent, not a verified fact about which credential the child used for a given run.
- **A plain shell write is invisible to `changedFiles`** — only `apply_patch`-driven changes are reported (measured; see "Changed files and usage" above). A deployment relying on `changedFiles` for an audit trail under `workspace-write` cannot assume it enumerates every file the child touched.
- **`changedFiles`/`usage` are absent on an `aborted` or unclassified `error` result** — both are populated only where `wire.runTurn()` directly constructs a `completed`/`max-tokens` result; a cancelled or unclassified-failure run carries no partial file or usage accounting (same gap as the shared package's own note).
- **Host-configured hooks fire during a delegated run** — `hook/started`/`hook/completed` notifications were observed on the real app-server during a delegated turn, sourced from the host's own Codex configuration rather than this provider's fixed `thread/start` parameters (`sandbox`/`approvalPolicy`). Unlike sandbox and approval policy, hooks are not currently pinned by this package; a host hook could observe or affect a delegated child's turn. Out of this package's scope to close.
- **A persistent (resumed) thread is stored in the host's own `~/.codex` conversation history** — unlike an ephemeral thread, which the app-server never persists past process exit, `ephemeral: false` writes the thread into the same on-disk store the user's own interactive `codex` sessions use. A deployment that opts into `allowResume` should treat this as a durable, host-visible side effect, not an internal implementation detail.
