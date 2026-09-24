# @deepseek-ai/dsh-llm-antigravity

English | [中文](README.zh.md)

Antigravity CLI (`agy`) adapter for the harness LLM seam: spawns one `agy --input-format stream-json --output-format stream-json` turn per `stream()` call, translating its NDJSON output into the `StreamChunk` protocol. `agy` is itself a full coding agent with ~60 built-in tools, so this package's whole design is keeping it a pure completion backend: a fixed prompt preamble tells it never to use those tools, every turn runs inside a fresh untrusted temp directory so headless mode auto-denies any tool call it attempts anyway, and harness tool calling is implemented at the prompt level (agy has no native tool-calling flag this adapter can drive).

This package owns the `antigravity` provider route. Registering another adapter for `antigravity` throws `LlmError('DUPLICATE_ADAPTER')`. It is opt-in: no shipped bundle mounts it, because `agy` is a locally installed, separately licensed and separately authenticated CLI this harness cannot assume is present.

The package root exposes the Cordis plugin contract and `AntigravityAdapter`; prompt assembly, the tool-calling protocol parser, and subprocess framing are not part of that root contract.

## Config

```yaml
- id: llm-antigravity
  name: '@deepseek-ai/dsh-llm-antigravity'
  config:
    binaryPath: agy               # optional; PATH-resolved bare command; this is the default
    printTimeoutSeconds: 300      # optional positive integer; this is the default
    defaultContextWindow: 1048576 # optional positive integer fallback; this is the default
    defaultMaxTokens: 65536       # optional positive integer fallback; this is the default
    models:                       # optional; empty by default (discover via `agy models`)
      - id: gemini-3.8-flash-low
        name: Gemini 3.8 Flash (Low)
        contextWindow: 1048576
        maxTokens: 65536
```

Every field carries a default from the schema, so an empty `config: {}` is valid. `resolveAdapterOptions` is the one explicit resolve step from the schema-normalized config to validated adapter construction facts, re-checking bounds a bare object literal could still violate (programmatic construction bypasses Schemastery).

`binaryPath` is the executable `spawn()` receives directly (`PATH`-resolved when bare, exactly as a shell would). `printTimeoutSeconds` crosses the wire as `--print-timeout <n>s` on every invocation.

`models` is empty by default. An empty catalog means `listModels` discovers the catalog by spawning `agy models` and parsing its `<id>\t<display name>` lines (see "Model discovery" below); a non-empty catalog is served exactly as configured, with no discovery spawn. `resolveModel` uses a configured entry's own `contextWindow`/`maxTokens` when present, a discovered entry's display name when the catalog is empty, and `defaultContextWindow`/`defaultMaxTokens` as the fallback in every other case. Every model this adapter advertises declares `inputModalities: ['text']` — agy's turn protocol carries no image field this adapter can drive.

## Untrusted working directory

Every `stream()` call and every `agy models` discovery call runs agy inside a freshly created `mkdtemp(join(tmpdir(), 'dsh-agy-'))` directory, removed in a `finally` once the call ends (normally, on error, on caller abort, or on the consumer stopping early). agy's own settings list the harness checkout and the user's home directory as trusted workspaces, so agy would silently execute its own tools (reading or writing files, running commands) inside a trusted cwd. A directory this adapter creates fresh per call is never on that trusted list, so agy's headless print mode auto-denies every built-in tool action it attempts there — the fixed prompt preamble (below) is the first line of defense, and this cwd swap is the enforcement backstop for a model that ignores it.

## Prompt-level tool calling

`agy` exposes no `--tools`/`--json-schema` flag this adapter found reliable: probing showed the model ignoring `--json-schema` and running an extra turn against agy's own tools instead. Harness tool calling is therefore implemented entirely in the prompt, and only while `GenerateOptions.tools` is non-empty:

1. The fixed preamble below is always the first thing agy reads on stdin.
2. The request's `system` text, when present.
3. `[Available Tools]` followed by the JSON-serialized tool schemas, only when `GenerateOptions.tools` is non-empty.
4. The fixed tool-calling protocol text below, only when tools were included.
5. The message history, one `[ROLE]` section per message; a tool-call block renders as `[tool-call <id> <name>] <arguments>` and a tool-result block as `[tool-result <call id>] <content>` (`error` appended when `isError` is true).

While tools are offered, `stream()` buffers the whole response instead of streaming text deltas (block/delta streaming resumes if no tools are offered): after agy's terminal `result` event, the response is parsed tolerantly as either a ` ```json ` fenced block or the whole trimmed text, expecting `{"tool_calls":[{"name":"<tool>","arguments":{...}}]}` with at least one well-formed call. On a match, any non-JSON text surrounding the fence becomes a leading text block, then one `tool-call` block per call (a fresh `CallId`, its `arguments` re-stringified as JSON), then `usage`, then `finish {kind: 'tool-calls'}`. On any parse failure — invalid JSON, a missing/empty `tool_calls` array, a call missing a string `name` or object `arguments` — the entire response becomes one text block and `finish {kind: 'stop'}`, exactly as if no tools had been offered. The model ignoring the protocol and answering in plain prose therefore degrades to an ordinary text turn rather than failing the request.

## Model discovery (`agy models`)

`listModels` on an empty catalog spawns `agy models` inside a fresh untrusted temp directory and parses stdout: a line without a tab is banner or log noise and is skipped, and every `<id>\t<display name>` line becomes one `LlmModelInfo`. A successful discovery is cached for the adapter instance's lifetime — later `listModels`/`resolveModel` calls reuse it without spawning again. A failed discovery (spawn failure, non-zero exit) is NOT cached: it rejects with `LlmError('DISCOVERY_FAILED')` naming `binaryPath`, and the next call retries the spawn.

## Errors

`LlmError` codes this adapter throws, beyond the ones `dsh-llm` defines: `CONFIG` (agy binary not found — `ENOENT` — naming `binaryPath`), `TRANSPORT` (any other spawn failure, or a generic subprocess failure), `UNSUPPORTED_CONTENT` (an image or other non-text block anywhere in the request — agy's turn protocol is text-only), `UNSUPPORTED_OPTION` (`GenerateOptions.stop` — agy exposes no stop-sequence flag), `MALFORMED_RESPONSE` (a non-JSON NDJSON line), `STREAM_CLOSED` (agy exited 0 without ever emitting a `result` line), `SERVER` (agy's `result.status` was `ERROR`, or agy exited non-zero/died by signal before a `result` line, both carrying agy's stderr tail), `AGENT_TOOLS_DENIED` (agy's `result` was `SUCCESS` with an empty response and a non-empty `denied_actions` list — it tried its own built-in tools and headless mode denied every one), `DISCOVERY_FAILED` (`agy models` could not be spawned or exited non-zero). An empty response with no denied actions is not an error path: it ends the stream with `finish {kind: 'error', failure: {code: 'EMPTY_RESPONSE'}}`, dsh-llm's canonical code for a completed turn with no content.

`options.signal` aborting kills the child with `SIGTERM`; a stream already past its terminal event reports the underlying outcome, otherwise it throws `LlmError('ABORTED')`. A consumer that stops iterating early (a `for await` `break`, or the generator's own `return()`) reaches the same cleanup through `stream()`'s `finally`: the child is killed if still running and the temp directory is removed, with no reliance on the caller ever observing a terminal chunk.

## Model Experience

### Antigravity request

#### What the model sees

Every request opens with the fixed completion-backend preamble below, then the request's `system` text (when present), then — only when `GenerateOptions.tools` is non-empty — the tool schemas and the fixed tool-calling protocol text, then the rendered message history (one `[ROLE]` section per message; reasoning blocks render as `[reasoning] <text>` rather than being dropped, so a prior turn's reasoning still costs its tokens). `temperature` and `maxTokens` are accepted but not transmitted: the verified working `agy` invocation exposes no flag for either, so both remain silently unused.

##### Completion-backend preamble

```markdown
You are serving as a text completion backend for another agent runtime (DeepSeek Harness), not as an autonomous coding agent. Never invoke your own built-in tools (run_command, view_file, write_to_file, or any other native action) to answer this request. Read the system instructions and conversation below and reply with exactly the text — or, when a tool-calling protocol is described below, the JSON — that the runtime asks for.
```

##### Tool-calling protocol text

```markdown
To call one or more of the tools listed above, reply with ONLY a single JSON object of the exact form {"tool_calls":[{"name":"<tool name>","arguments":{<arguments object>}}]}. A ```json fenced code block wrapping that exact object is also accepted. Emit nothing else: no prose before or after it, and no additional keys. Do not invoke your own built-in tools under any circumstance. If none of the listed tools are needed to answer, reply with plain text instead — do not emit tool_calls JSON in that case.
```

#### Token effect

Every request carries roughly 14k input tokens of agy's own system prompt on top of the harness-authored preamble, system text, tool schemas, and transcript above — a fixed per-request overhead this adapter cannot reduce or disable, since agy assembles it internally before this adapter's stdin payload is even read.

#### KV Cache effect

None: each `stream()` call is a brand-new agy process running a brand-new conversation (a single `event: user` stdin message, one response, then exit). agy reports no cache metric and this adapter's own `TokenUsage` carries no cache fields, because there is no cross-call cache to report — not this session's history, not agy's own ~14k system-prompt overhead, is ever reused between calls.

### Antigravity response

#### What the model sees

Without tools offered, agy's `step_update` `text_delta` fields stream live as harness `text-delta` chunks, closed by one `block-end` carrying the full text (agy's terminal `result.response` when present, otherwise the concatenated deltas). With tools offered, nothing streams live; the terminal response is parsed under the protocol above into an optional leading text block and one `tool-call` block per parsed call, or the whole response as one text block on any parse failure.

#### Token effect

Generated tokens follow whatever cap agy applies internally; `maxTokens` is accepted but not sent (see above), so this adapter reports no adapter-imposed ceiling. `TokenUsage` maps agy's `output_tokens`/`input_tokens`/`cache_read_tokens`/`thinking_tokens` onto the harness fields of the same meaning; only loop-retained blocks affect a later request's input.

#### KV Cache effect

Loop-retained response blocks append to the next request's rendered transcript exactly like any other harness history entry; because this route replays no adapter-private state across calls (no cache to invalidate in the first place), nothing about a prior response's content ever changes what the *next* call's ~14k agy overhead costs.

## Known Limitations and Deferred Work

- **No streaming while tools are offered** — the buffer-then-parse design that makes prompt-level tool calling possible means a tool-mode turn's text never streams live, even for the prose parts of the eventual reply.
- **The prompt-level tool protocol is advisory, not enforced** — a model that ignores the instructions and free-writes prose is treated as a valid non-tool answer (`finish {kind: 'stop'}`), not a protocol violation; a model that emits well-formed JSON that happens not to be a tool call (e.g. answering a question with a JSON-shaped fact) would be misread as a tool call. Neither case is detectable from outside the model's own compliance.
- **agy's own built-in tools are fenced by headless auto-deny plus an untrusted temp cwd, not by a hard sandboxing guarantee** — both defenses rely on agy's own headless permission logic and trusted-workspace list; a future agy version that changes either behavior would need this package to be revalidated, not just this README updated.
- **Text-only** — any image (or other non-text) content block anywhere in the request throws `UNSUPPORTED_CONTENT` before any subprocess spawns; agy's turn protocol has no field this adapter could use to send one.
- **`temperature` and `maxTokens` are accepted but not transmitted** — the verified working `agy` invocation exposes neither knob; a future `agy` release that adds them would need this adapter to start sending them.
- **~14k-token fixed overhead per request** — agy assembles its own system prompt internally before this adapter's stdin is read, so no adapter-side change can reduce it.
- **No cross-call KV cache reuse** — each request is a brand-new agy process and conversation; there is no session or prompt-prefix reuse for this adapter to report or exploit.
- **Quota is entirely agy's own** — this adapter neither reads nor reports the underlying subscription's remaining quota; a quota exhaustion surfaces only as whatever `result.status: 'ERROR'` text agy itself produces.
- **`agy models` discovery is cached for the adapter instance's lifetime on success** — a model added to the underlying account after the first successful discovery is not picked up without restarting the harness process (recreating the adapter instance).
