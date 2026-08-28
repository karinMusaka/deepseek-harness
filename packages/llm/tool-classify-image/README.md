# @deepseek-ai/dsh-tool-classify-image

English | [中文](README.zh.md)

The model-facing `classify_image` tool: read one local image file and relay it to an auxiliary vision route on `ctx.llm`, returning only text labels. It answers two questions about a person image — photograph or illustration, and apparent gender — and nothing else.

The tool exists because an image cannot simply be shown to the conversation's own model. A durable `image` block in session history pins every later request to a text-only route on a permanent `UNSUPPORTED_CONTENT` failure (`assertTextOnly` in [`dsh-llm-deepseek`](../llm-deepseek/README.md)), so a session that saw one image would stay broken. This tool therefore builds the image message as a local variable inside one tool call, sends it to a separate vision route, and returns text. The calling session never holds image content.

## Plugin

```yml
- name: '@deepseek-ai/dsh-tool-classify-image'
  config:
    provider: ollama
    model: minicpm-v:latest
    maxTokens: 128
    timeoutMs: 120000
```

`inject`: `tools`, `llm`, `fs`, `attachments`. All four are required — the tool resolves a path through the filesystem seam, commits the bytes through the attachment store, and streams the auxiliary request through the LLM seam.

| Key | Default | Meaning |
|---|---|---|
| `provider` | `ollama` | Registered provider route carrying the vision model. |
| `model` | `minicpm-v:latest` | Exact vision model id passed to that provider. |
| `maxTokens` | `128` | Output-token cap for each of the two auxiliary requests. |
| `timeoutMs` | `120000` | Cooperative tool-call budget, enforced by [`dsh-tool-call-timeout-policy`](../../guard/timeout-policy/README.md). |

`provider` and `model` are required together: a provider alone would inherit a model id that means nothing on it, and a model alone would run on whatever route `ollama` happens to be. Supplying one without the other fails at load.

The route must declare image input. With the Ollama provider that means a catalog entry for the model, since `dsh-llm-ollama` treats `inputModalities` as declared, not detected:

```yml
- name: '@deepseek-ai/dsh-llm-ollama'
  config:
    models:
      - id: minicpm-v:latest
        inputModalities: [text, image]
```

## Execution

One call runs, in order: extension-to-media-type mapping, the deployment's accepted-media-type check, the route's image-input check, path resolution and `stat` through `ctx.fs`, a bounded `readBytes`, `ctx.attachments.saveImage`, an `fs/observed` emit, the `tool-classify-image/request` session append, and then the two auxiliary requests. Every refusal that can be decided without I/O is decided before the read, so a rejected call leaves no attachment behind.

The two questions are fixed package prose, not configuration, because `src/normalize.ts` matches the markers these exact questions elicit. Its gender rule tests female markers first: `female` contains `male` and `woman` contains `man`, so a male-first scan would mislabel every female answer.

The canonical value is `{ type, gender, typeRaw, genderRaw }`. `type` is `photo`, `illustration`, or `unknown`; `gender` is `male`, `female`, or `unknown`. Both raw sentences ride along so a caller can judge an `unknown` for itself. The UI render intent is a `generic` card in the `read` family with a `locations` entry on the image path.

## Session events

`tool-classify-image/request` is a log-only record appended before either auxiliary dispatch, carrying the resolved path, the durable attachment id and media type, the route, both prompts, and the output cap. It is the session log's only trace of two model requests that are otherwise invisible, because their image and prompts never become conversation messages. A direct non-agent call has no session and records nothing.

## Model Experience

### `classify_image` tool schema

#### What the model sees

The tool schema in the [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-classify-image): one required `path` string. There are no deltas beyond that entry.

#### Token effect

Fixed: one schema entry in every request's tool list while the plugin is mounted.

#### KV Cache effect

Prefix-stable. The schema is constant for a mounted plugin, so it neither grows nor changes between requests; mounting or unmounting the plugin changes the tool list and invalidates reuse from that point.

### `classify_image` tool result

#### What the model sees

Two label lines followed by the vision model's two raw sentences.

##### Verbatim result text, with the model's own words in placeholders

```markdown
type: <photo|illustration|unknown>
gender: <male|female|unknown>

vision model answers:
- <the model's photograph-or-illustration sentence>
- <the model's apparent-gender sentence>
```

#### Token effect

Small and bounded: two labels plus two sentences each capped by `maxTokens` (128 by default). The image contributes nothing — it never becomes model-visible content in this session.

#### KV Cache effect

Append-only. The result is one ordinary tool-result block appended after the call, so it preserves the already-reusable prefix.

### Auxiliary vision requests

#### What the model sees

The *auxiliary* vision model, not the calling model, sees one user message containing the image and one fixed question, with no system prompt and no tool schemas. Two such requests run per call, one per question. The calling model sees none of it.

#### Token effect

Independent of the calling session's budget: each auxiliary request costs the vision route the image's own token expansion plus one short question, and is capped at `maxTokens` output.

#### KV Cache effect

Independent. Each auxiliary request is a fresh single-message conversation with no shared prefix, so it neither reuses nor invalidates the calling session's cache; provider-side reuse across the two questions is the vision route's own business.

## Known Limitations and Deferred Work

- **The image must be a local file path** — the only argument is `path`, resolved by the mounted filesystem backend. A URL, a base64 payload, and an existing attachment id are all unaccepted; a caller holding bytes must write them to a file the backend can reach first.
- **Two fixed questions, no prompt override** — the questions are package-owned prose paired with the marker sets in `src/normalize.ts`, so configuration cannot replace them without silently degrading the labels. A different classification need is a different tool, not a config key on this one.
- **Normalization is substring matching, not understanding** — an answer that names both a photograph and an illustration reports `type: unknown` rather than guessing, and an answer phrased without any listed marker reports `unknown` even when a human would read it clearly. `typeRaw`/`genderRaw` exist so a caller can recover from that.
- **Only binary-presenting gender vocabulary is recognized** — the marker sets are `female`/`woman`/`girl` and `male`/`man`/`boy`; any other answer reports `unknown`. The tool reports a vision model's surface reading of an image, which is not a claim about the depicted person.
- **The route's image support is declared, not detected** — the gate reads `inputModalities` from `ctx.llm.resolveModelInfo`, so a vision-capable model whose provider catalog omits the declaration is refused. This inherits the Ollama adapter's declared-capability stance and fails safe.
- **English-only questions** — the fixed prompts and the marker sets are English. A vision model answering in another language reports `unknown` for both fields.
- **No batch form** — one call classifies one file. Classifying a directory costs one tool call and two vision requests per image.
