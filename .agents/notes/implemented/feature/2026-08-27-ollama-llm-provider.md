# Agent Note: an Ollama provider route for local models

Status: implemented

English | [中文](2026-08-27-ollama-llm-provider.zh.md)

## Problem

A local `ollama serve` is the cheapest way to run a small vision model — classifying whether a portrait is a photograph or an illustration, for instance — but neither shipped adapter can reach it. `dsh-llm-deepseek` speaks SSE with a `[DONE]` sentinel and an OpenAI-compatible chat-completions body, and its whole credential path (`apiKeyEnv`, per-request key resolution, `MISSING_CREDENTIAL`, the anonymous user-id header) assumes an authenticated remote endpoint. `dsh-llm-pi-ai` reaches providers only through the pi-ai SDK's own catalog and cannot address a route the SDK does not model. Ollama's native `/api/chat` differs on exactly the axes those two adapters fix: it streams raw NDJSON with no framing prefix, it marks termination with a JSON field rather than an out-of-band string, it reports token counts only on that terminal line, and it needs no credential at all.

## Decision

`packages/llm/llm-ollama` (`@deepseek-ai/dsh-llm-ollama`) is a new provider package owning the single route `ollama`, registered on `ctx.llm` by a function plugin that mirrors `llm-deepseek`'s structure minus every credential concern: one `resolveAdapterOptions` step from raw config to validated connection facts, a per-operation thunk so a settings edit reaches the next request, and `registration.replace([PROVIDER])` for the one registration-captured fact (the retry policy). `attributionHeaders()`'s `User-Agent` is the only harness header on the wire.

The package splits along the wire: `ndjson.ts` frames `\n`-terminated lines and knows nothing about the protocol; `translate.ts` owns termination, because Ollama's end-of-stream is the `"done": true` field inside a line rather than a sentinel the framing layer could recognize. That split is the one structural difference from `llm-deepseek`, where `sse.ts` detects `[DONE]` itself and `translate.ts` only reacts to it. `translate.ts` therefore also owns `STREAM_CLOSED` (lines ended without a terminal line), `MALFORMED_RESPONSE` (a line that is not JSON), and `SERVER` for a generation failure delivered as an in-band `{"error": …}` line.

The route serves one visible-text channel, so at most one harness block is ever open, at index 0. `block-end`, `usage`, and `finish` all defer to the terminal line — which is also the only line carrying `prompt_eval_count`/`eval_count` — so `usage` always precedes `finish` and nothing follows it. `done_reason` maps `stop` → `stop` and `length` → `max-tokens` (both measured against a live server), with any other value becoming an error finish keyed by its uppercased self.

Tool calling and reasoning are refused, not approximated. `GenerateOptions.tools` throws `UNSUPPORTED_OPTION`, and a `tool-call` or `tool-result` block in history throws `UNSUPPORTED_CONTENT`, both before any network I/O; `resolveModel` exposes no reasoning levels. Silently flattening a tool result into text would change what the model is answering while looking like success.

Image support is declared per catalog entry (`inputModalities: [text, image]`), never detected. An omitted or empty list, and every uncatalogued pass-through id, mean text only — the negative-capability convention `llm-deepseek`'s `resolveModel` already uses — so an image request against an undeclared model fails with `UNSUPPORTED_CONTENT` before any request. A declared image request resolves bytes through the optional `ctx.attachments` service and sends them base64-encoded in the wire message's `images` array; without a mounted service the request fails rather than dropping the image.

`models` defaults to empty. Which models a server has pulled is deployment state this package cannot know, so a shipped default naming one would advertise a model the server may not have.

### Measured wire facts

`ollama serve` 0.33.1, `moondream:latest`, over `curl`:

- `POST /api/chat` with `stream: true` answers one complete JSON object per `\n`-terminated line, no `data:` prefix.
- The terminal line carries `"done": true`, `done_reason`, `prompt_eval_count`, and `eval_count`; its `message.content` is `""`.
- `options.num_predict: 5` against a long-form prompt reproduces `done_reason: "length"`; `options.stop` and `options.temperature` are accepted; unknown `options` members are ignored and the request still answers HTTP 200.
- Errors are pre-stream: a plain `{"error": "<string>"}` body with a non-2xx status — 404 for a model the server has not pulled, 400 for `tools` against a tool-less model and for undecodable image bytes.
- `images: ["<base64>"]` on a user message drives the vision path; the bytes carry no `data:` URI prefix.

## Alternatives considered

- **Ollama's OpenAI-compatible `/v1/chat/completions` endpoint, reusing `llm-deepseek`'s adapter** — rejected: the native route's `images: string[]` is a flat array of base64 strings, while the compatible route requires OpenAI's nested `content: [{type: 'image_url', image_url: {url: 'data:...'}}]` parts, so the simpler wire is the native one. The compatibility layer also adds a translation Ollama itself performs, and it reports usage under OpenAI's names rather than the ones `ollama show` and the server logs use.
- **A multi-profile provider dictionary like `llm-pi-ai`'s** — rejected: that shape exists to distinguish several vendors behind one SDK. An Ollama deployment is one server at one base URL; a second server is a second `cordis.yml` entry's problem, not a route-keyed dictionary inside one plugin.
- **Detecting image support from `GET /api/tags`' `capabilities` array** — rejected for this scope: the field exists and does report `vision`, but consuming it means caching and invalidating a view of mutable server-side state, on a request path that must fail fast. Declaration costs one config line, fails safe when absent, and the deferral is recorded in the package README's limitations.
- **Mapping 401/403 to `AUTH`** — rejected: this package resolves no credential, so an `AUTH` code would name a fix it does not offer. An authenticating reverse proxy is out of scope and its statuses surface as `HTTP_401`/`HTTP_403`.
- **Rejecting an empty `inputModalities` list as misconfiguration** — rejected once measured: Schemastery normalizes an omitted array member to `[]`, so an empty list and an absent one are indistinguishable at the resolver. Treating both as "text only" is the only self-consistent reading.

## Consequences

- A deployment states each vision model's image support explicitly; a missing declaration refuses the image instead of sending it, which is the safe direction but does mean the failure is a configuration failure rather than a provider one.
- Without tool calling or reasoning, this route cannot drive the agent loop's tool steps. It serves single-shot classification and description calls, which is the use it was added for.
- The 4,096-token `defaultContextWindow` and 2,048-token `maxTokens` defaults are sized for small local models rather than derived from any one of them; a deployment wanting exact values reads `ollama show` and configures them per model.
- Ollama truncates an oversized prompt against `num_ctx` instead of rejecting it, so no request can produce `CONTEXT_WINDOW_EXCEEDED` and an over-budget prompt silently loses its oldest tokens. Configuring each model's real `contextWindow` is what keeps the loop's pressure handling honest.
- The default bundle (`packages/bundle/base`) mounts nothing from this package; the route exists only for a composition that adds the entry.

## Testing

- `packages/llm/llm-ollama/tests/ndjson.spec.ts` — line framing across read splits, a multibyte character split mid-sequence, blank lines, a `\r\n` terminator, a dropped unterminated tail, and one activity callback per yielded line.
- `packages/llm/llm-ollama/tests/translate.spec.ts` — deferred `block-end`/`usage`/`finish`, text on the terminal line, `done_reason` mapping including an unknown value, usage with one or neither count, `EMPTY_RESPONSE`, `MALFORMED_RESPONSE`, an in-band error line, and `STREAM_CLOSED`.
- `packages/llm/llm-ollama/tests/serialize.spec.ts` — role and text mapping, omitted and populated `options`, refused tool schemas and tool blocks, base64 image ordering, an image without the attachment service, and dropped reasoning.
- `packages/llm/llm-ollama/tests/adapter.spec.ts` — an NDJSON mock server for the request body and headers (attribution present, no `authorization`), each HTTP status class against the plain-string error body, transport and abort classification, the idle watchdog including content-free lines rearming it, the four image-gating refusals and the accepted declared path, HMR-safe registration, catalog resolution, and every config bound.
- `packages/llm/llm-ollama/tests/dynamic-config.spec.ts` and `loader-composition.spec.ts` — settings hot-reload and in-place retry-policy re-registration, then the same chain booted from a test-only `cordis.yml` through the real Loader, with and without a settings entry.
- `packages/llm/llm-ollama/tests/adapter.e2e.ts` — a real local server behind `$DSH_LLM_OLLAMA_E2E`. The opt-in is an explicit variable, not endpoint reachability: an unauthenticated server must not turn a keyless lane's suite on by merely running.
