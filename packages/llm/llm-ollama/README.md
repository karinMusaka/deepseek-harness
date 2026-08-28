# @deepseek-ai/dsh-llm-ollama

English | [中文](README.zh.md)

Ollama adapter for the harness LLM seam: direct `fetch` + NDJSON against a local or self-hosted server's `POST {baseURL}/api/chat`, translating that route's wire format into the `StreamChunk` protocol. The route is unauthenticated, so this package has no credential reference, no key resolution, and no request identity beyond the shared attribution header.

This package owns the `ollama` provider route. Registering another adapter for `ollama` throws `LlmError('DUPLICATE_ADAPTER')`.

The package root exposes the Cordis plugin contract and `OllamaAdapter`; wire serialization, NDJSON framing, and chunk translation helpers are not part of that root contract.

## Config

```yaml
- id: llm-ollama
  name: '@deepseek-ai/dsh-llm-ollama'
  config:
    baseURL: http://localhost:11434 # optional; $OLLAMA_BASE_URL then the default local server when omitted
    maxTokens: 2048           # optional positive per-request output cap; this is the default
    defaultContextWindow: 4096 # optional positive-integer fallback; this is the default
    streamIdleTimeoutMs: 300000 # optional; positive finite Node timer delay; five-minute default
    retryPolicy:              # optional; omission uses bounded normal defaults
      mode: always            # normal | always
      backoff:
        initialDelayMs: 500
        maxDelayMs: 10000
        jitterRatio: 0.1
    models:                   # optional; empty by default
      - id: moondream:latest
        name: Moondream
        contextWindow: 2048
        inputModalities: [text, image]
      - id: qwen3:8b
        contextWindow: 40960
```

The plugin registers the single provider route `ollama` together with its resolved `retryPolicy`. A request selects it with `provider: ollama`; its `model` is passed through as the wire `model` string, exactly as `ollama list` reports it (tag included), so pulling a new model does not require lifecycle-time registration. Catalog entries are exposed through `ctx.llm.listModels('ollama')` for clients such as ACP editors and the Web selector, but remain advisory: unlisted model ids still pass through unchanged. An omitted entry name defaults to its id.

`models` is empty by default: which models a server has pulled is deployment state this package cannot know, and naming one would advertise a model the server may not have. An empty catalog therefore advertises nothing while every request id still resolves as a text-only pass-through.

`contextWindow` is optional per configured model. `ctx.llm.resolveModelInfo('ollama', model).context` returns an exact model value first, then `defaultContextWindow` for an entry without capacity or an unlisted pass-through id. The 4,096-token default is deliberately modest — the models this route serves are small, and `ollama show` reports each one's real `context_length` for a deployment that wants the exact value.

`maxTokens` is the adapter-configured output cap and defaults to 2,048. A catalog entry may carry its own `maxTokens`, which wins for that model. Exact-model resolution exposes the winner as `defaultMaxTokens`; `LlmRuntime` materializes that value into `GenerateOptions.maxTokens` before the agent loop writes `request/header`, so the wire request remains reconstructable. An explicit request or `AgentOptions.maxTokens` value wins and is serialized as `options.num_predict`. The adapter does not clamp this budget against `contextWindow`.

`streamIdleTimeoutMs` bounds each outstanding provider read, including the initial `fetch`, without counting time the consumer spends between chunks. Every NDJSON line rearms an outstanding read, including a line whose content delta is empty and therefore yields no `StreamChunk`. One stable abort signal reaches the request and body reader for the whole call; expiry stops the transport and throws `LlmError('TIMEOUT')`, while an earlier caller abort throws `LlmError('ABORTED')`. The adapter makes exactly one provider request per `stream()` call; it registers the configured policy as provider metadata, and `dsh-llm-retry` separately executes it at durable agent-step boundaries.

## Image input

Image support is declared, never detected: a model accepts image blocks only when a catalog entry names `image` in its `inputModalities`. An omitted or empty list means text only, and so does an unlisted pass-through id, so a request carrying an image for any undeclared model fails with `LlmError('UNSUPPORTED_CONTENT')` before any network I/O. A misconfigured deployment therefore refuses the image instead of sending bytes a text-only model would answer about blindly.

A declared image request reads its bytes through the optional `ctx.attachments` service and sends them base64-encoded in the wire message's `images` array, beside that message's joined text. Without a mounted attachment service the same request fails with `UNSUPPORTED_CONTENT` rather than dropping the image.

## Dynamic configuration (settings)

Connection facts are not frozen at load. `resolveAdapterOptions` is the one explicit resolve step from raw config to validated facts, and the adapter re-reads them through a thunk **once per operation**: base URL, catalog, output cap, and idle budget all take effect on the next request, while an in-flight stream keeps the facts it started with.

The plugin registers the `llm-ollama` namespace with this same `Config` schema and its `cordis.yml` entry as the composition `base`, so a `llm-ollama:` section in the user settings document overrides any field without a restart. Without a mounted settings service the entry config alone drives the adapter, unchanged. A live settings snapshot that passes the schema but fails a beyond-schema bound (a duplicate catalog id, an unknown input modality) keeps the last good facts and logs the failure; the entry config itself still fails plugin load.

The one registration-captured fact is the retry policy: when its resolved value changes, the plugin re-registers the route in place (same adapter instance, one synchronous section), so `ctx.llm.providerRetryPolicy('ollama')` always reports the current policy.

The plugin also declares its route in the configurable-provider directory (`ctx.llm.listConfigurableProviders()`): provider `ollama`, settings namespace `llm-ollama`, empty settings path — the whole section is the profile.

## App attribution

Every request carries the shared attribution header from dsh-llm's `attributionHeaders()` — the mandatory `User-Agent` baseline identifying the harness (see [dsh-llm § App attribution](../llm/README.md#app-attribution-attributionts)). Nothing else is added: an Ollama server needs no credential, and this adapter sends no user, session, or purpose header.

## Wire-format notes

Measured against `ollama serve` 0.33.1.

- Streaming only. `POST /api/chat` with `stream: true` answers raw NDJSON — one complete JSON object per `\n`-terminated line, no `data:` prefix, no out-of-band terminator.
- Termination is the `"done": true` field on the last line, not a sentinel string. That line also carries `done_reason` and the token counts, so `block-end`, `usage`, and `finish` are all deferred to it: `usage` always precedes `finish`, and nothing follows `finish`.
- Token accounting: `inputTokens` ← `prompt_eval_count`, `outputTokens` ← `eval_count`. Ollama reports no cache metric, and its prompt count carries no cache split to subtract. A terminal line reporting neither count emits no `usage` chunk.
- `done_reason` maps `stop` → `stop` and `length` (the `num_predict` cap) → `max-tokens`; any other value becomes `finish {kind: 'error', failure}` with the uppercased value as `code`.
- Generation knobs nest under `options`: `num_predict` ← `maxTokens`, `temperature`, `stop`. Ollama ignores unknown members there, so only measured fields are sent, and the whole object is omitted when the request sets no knob.
- A line framing only splits and trims; a non-empty unterminated tail at end of stream is truncation, and a stream that ends without a `done: true` line fails with `STREAM_CLOSED`.
- Serialization maps each harness message to one wire message with the same role, its text blocks joined into `content`. Assistant reasoning blocks are dropped — the route has no passback field for them.

## Errors

Non-2xx responses throw `LlmError` with stable codes: `UNKNOWN_MODEL` (404 — the server has not pulled that model), `INVALID_REQUEST` (400 — including a `tools` request to a model without tool support and undecodable image bytes), `RATE_LIMIT` (429), `SERVER` (5xx), `HTTP_<status>` otherwise. The error body is a plain `{"error": "<message>"}` string member, which becomes the failure message; a missing, empty, or unparseable body keeps the status-line message. Its serializable `failure` retains the HTTP status. Ollama sends no `Retry-After` and no request-id header, so neither appears in a failure.

A pre-response transport failure (a server that is not running, DNS, refused connection) throws `TRANSPORT` naming the configured endpoint and chaining the original rejection as `cause`; caller aborts throw `ABORTED`, and the loop's cancellation signal remains authoritative. Protocol violations throw `STREAM_CLOSED` (no terminal line) or `MALFORMED_RESPONSE` (a line that is not JSON). A generation failure delivered as an in-band `{"error": …}` line throws `SERVER`, which the default policy retries. A completed stream whose `stop` (or absent) reason opened no content block becomes a `finish {kind: 'error'}` with code `EMPTY_RESPONSE` (also retried by default). Requests the route cannot represent fail before any network I/O: declared tool schemas throw `UNSUPPORTED_OPTION`, and a `tool-call` or `tool-result` block in history throws `UNSUPPORTED_CONTENT`.

## Model Experience

### Ollama request

#### What the model sees

The selected local model receives the harness system prompt as the wire `system` message, the message history as one wire message per harness message, and the request's output cap, temperature, and stop sequences — without adapter-authored prompt prose. A declared vision model additionally receives each user image as base64 bytes beside that message's text. Reasoning from a prior assistant turn is omitted, and a request carrying tool schemas or tool blocks never reaches the model at all.

#### Token effect

Provider tokenization governs exact input. Dropping prior reasoning avoids paying those tokens again; an image contributes the model's own image-token expansion, which the terminal line reports inside `prompt_eval_count`.

#### KV Cache effect

Ollama keeps a loaded model's prompt prefix in its own KV cache, so an unchanged assembled prefix is eligible for reuse. Any upstream prompt, history, or image change may prevent reuse from the first changed token, and a model-route change selects a different cache domain. This adapter reports no cache metric, because the route reports none.

### Ollama response

#### What the model sees

Visible text is translated into a single harness text block for the loop to log and assemble.

#### Token effect

Generated tokens follow the request's logged `maxTokens`, which crosses the wire as `options.num_predict`; only loop-retained blocks affect later input.

#### KV Cache effect

Loop-retained response blocks append to the next request and preserve its earlier reusable prefix; dropped blocks have no later cache effect.

## Known Limitations and Deferred Work

- **Tool calling is not supported** — the adapter refuses `GenerateOptions.tools` with `UNSUPPORTED_OPTION` and refuses `tool-call`/`tool-result` history with `UNSUPPORTED_CONTENT`, so this route cannot serve the agent loop's tool steps. Ollama's `/api/chat` does accept `tools` for models whose `capabilities` include it; wiring that needs a tool-call delta translation and history passback this package does not own yet.
- **Reasoning is not supported** — Ollama's `thinking` request field and `message.thinking` response field are unmapped, so `resolveModelInfo` exposes no reasoning levels and a thinking-capable model's reasoning never reaches the harness.
- **A model's image support is declared, not detected** — `GET /api/tags` reports each model's `capabilities` (including `vision`), but the adapter never reads it: a deployment states `inputModalities` per catalog entry instead. Automatic detection would need a cached, invalidated view of a mutable server-side model list, which this scope does not justify. A missing declaration fails safe (the image is refused).
- **`GET /api/tags` is not exposed as model discovery** — `ctx.llm.registerModelDiscovery` is unimplemented here, so a configuration surface cannot list a server's pulled models.
- **A settings `models` list replaces the composition list wholesale** — settings-layer merging is per-field, and arrays are one field; per-entry catalog merging would need a keyed shape.
- **No context-overflow classification** — Ollama truncates an oversized prompt against `num_ctx` instead of rejecting it, so no request produces `CONTEXT_WINDOW_EXCEEDED` and an over-budget prompt silently loses its oldest tokens. Configuring each model's real `contextWindow` is what keeps the loop's own pressure handling honest.
- **An authenticating proxy in front of the server is out of scope** — the adapter sends no credential, so a 401 or 403 surfaces as the unclassified `HTTP_401`/`HTTP_403`.
- **Requests use raw `fetch`, not `@cordisjs/plugin-http`** — no shared proxy/interception configuration, matching the DeepSeek adapter's deferral.
- **Serialization flattens message content to text blocks and images** — plugin-added block types are skipped.
