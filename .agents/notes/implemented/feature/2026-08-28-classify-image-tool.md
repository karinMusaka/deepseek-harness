# Agent Note: a classify_image tool that relays an image without showing it to the caller

Status: implemented

English | [中文](2026-08-28-classify-image-tool.zh.md)

## Problem

Classifying a person image — photograph or illustration, apparent gender — is cheap on a local vision model, and [`dsh-llm-ollama`](2026-08-27-ollama-llm-provider.md) already reaches one. What was missing is a way to ask for that classification from an ordinary session without switching the whole session's model by hand.

Handing the image to the session's own model is not merely unhelpful, it is destructive. `assertTextOnly` in `packages/llm/llm-deepseek/src/serialize.ts` rejects any request whose history contains an image block, and session history is append-only: once an image block is logged, every later request that includes that message fails with `UNSUPPORTED_CONTENT`, permanently. The comment in `packages/fs/tool-fs/src/read-image.ts` states the same fact from the other side, which is why `read_image` refuses unless the exact routed model declares image input. So the requirement is not "let the main model see an image"; it is the opposite — classify the image while guaranteeing the main model never sees it.

## Decision

`packages/llm/tool-classify-image` (`@deepseek-ai/dsh-tool-classify-image`) registers one narrow tool, `classify_image`, taking a single `path`. Inside `execute` it resolves and reads the file through `ctx.fs`, commits the bytes through `ctx.attachments.saveImage`, and builds a **local** `Message[]` carrying one image block and one question. That array is a function-scoped variable: it is passed to `ctx.llm.stream` and discarded. Nothing appends it to the calling session, so the caller's history stays text-only and every later request on it remains valid. What returns to the calling model is `{ type, gender, typeRaw, genderRaw }` — closed labels plus the two raw sentences.

Two fixed questions are asked, sequentially, on the configured route: whether the image is a photograph or a digital illustration, and the apparent gender of the person or character. They are package prose, not configuration, because `src/normalize.ts` matches the markers those exact questions elicit. Its gender rule tests `female`/`woman`/`girl` before `male`/`man`/`boy`, since `female` contains `male` and `woman` contains `man`; a male-first scan would mislabel every female answer. A type answer naming both families reports `unknown` rather than guessing.

The route is validated before any I/O. `ctx.llm.resolveModelInfo(provider, model)` must declare `image` input, mirroring `read_image`'s strict gate; with the Ollama provider that means the deployment's catalog entry says `inputModalities: [text, image]`, since that adapter declares image support rather than detecting it. `provider` and `model` are required together in config (defaulting as a pair to `ollama` / `minicpm-v:latest`) because a provider supplied alone would inherit a model id meaningless on it, and a model alone would run on whatever `ollama` happens to be.

The two auxiliary requests would otherwise leave no trace at all, since their image and prompts never become conversation messages. So the tool follows `session-title-llm`'s log-only pre-dispatch pattern: `tool-classify-image/request` is appended before either dispatch, carrying the resolved path, the durable attachment id and media type, the route, both prompts, and the output cap. A direct non-agent call has no session and records nothing, which is consistent — there is no history to reconstruct.

`GenerateOptions.purpose` gained the value `'vision-classify'`. The field is a plain closed literal union in `packages/llm/llm/src/types.ts`, not a merge-extensible map, so the union was widened in place; both existing readers (`llm-deepseek`'s compaction header and its session-title thinking override) test for their own value and pass the new one through untouched.

Scope is deliberately narrow. `packages/bundle/base` is untouched: this activates only when a deployment's own `cordis.yml` registers it.

## Alternatives considered

**A generic "ask another provider" relay tool.** Rejected: this classification is the only current consumer, and a general relay would have to own prompt passthrough, per-call route selection, and result shaping with no evidence about what any of those should be. The repository rule is to require a current owner and need for each public option.

**Extending `read_image`.** Rejected as a contract inversion. `read_image` exists to put an image *into* the conversation so the main model can look at it, which is why it commits an image block to the tool result and refuses on a route that cannot carry one. This tool's requirement is that the main model never sees the image, and it works precisely on the routes `read_image` refuses. Two tools with opposite guarantees should not share one implementation.

**A configurable prompt (`promptOverride`).** Rejected: the questions and the marker sets in `normalize.ts` are one design. A replaced question keeps producing labels while silently making them wrong, which is worse than not offering the knob.

**Marking the session event `ignorable`.** Considered because the package is opt-in and a log written with it mounted might be read by a composition without it. Rejected as unnecessary: `KNOWN_SESSION_EVENT_TYPES` is generated by `gen-persistence-catalog` from every in-repo `SessionEventMap` merge, so an in-repo event type is known to every first-party build regardless of which plugins are mounted. `Session.append` also exposes no `ignorable` argument yet ([session log versioning](../architecture/2026-08-10-session-log-version-mechanism.md) defers that surface to its first real user).

## Consequences

The tool answers exactly two questions and cannot be pointed at a third. A new classification need is a new tool, not a config key here; if several accumulate, the shared machinery to extract is the read-commit-relay path, not the questions.

Normalization is substring matching over English answers. A vision model that phrases an answer without a listed marker, or answers in another language, yields `unknown` even when a human would read the sentence clearly. `typeRaw` and `genderRaw` are returned so a caller can recover from that, and they make a marker-set gap visible in the transcript rather than silent.

The route gate depends on a declaration the deployment writes. A vision-capable model whose provider catalog omits `inputModalities` is refused with a message naming the fix. This fails safe and inherits the Ollama adapter's stance, but it does mean the tool refuses every call under that adapter's default empty catalog.

`purpose` is now a three-value union that any future adapter switching on it must handle; the two current readers already fall through. Widening it also means an auxiliary vision request is distinguishable from an ordinary one at the adapter boundary, which is what a provider would need to apply purpose-specific generation policy later.

## Verification

`packages/llm/tool-classify-image/tests/` covers the marker sets including the `female`/`male` and `woman`/`man` ordering hazard, every refusal arm and terminal finish reason against the real local filesystem and the real attachment validation helpers with only the model route scripted, and a real-Loader composition that boots the tool beside `llm-ollama` over a mock NDJSON endpoint: it asserts the base64 image bytes on the wire, the returned labels, that the calling session's log holds only the log-only record, and that a `[text]`-only catalog entry refuses before any request.
