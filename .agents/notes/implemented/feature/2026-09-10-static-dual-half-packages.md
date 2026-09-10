# Agent Note: static dual-half packages, loaded at boot from disk

Status: implemented

English | [中文](2026-09-10-static-dual-half-packages.zh.md)

## Problem

`cordis_define`d dynamic packages ([the self-referential toolset](../../implemented/feature/2026-07-08-self-referential-cordis-toolset.md)) live only in the host process's memory: a restart forgets every definition, and a browser half is never restored on page reload — a page runs one only when someone answers a fresh `cordis/request-run`. That is correct for the toolset's own trust model (a person authorizes each run), but it means a package a chat session wrote and iterated on cannot survive the process that defined it.

The recommended promotion path — rewrite the package as an ordinary Cordis plugin with typed `@Remote` methods and a built TSX bundle through the [client plugin loading model](../architecture/2026-07-23-client-plugin-loading-model.md) — costs real engineering time: weeks, for the roughly 7,000-line dual-half packages already in daily use. That path also reinvents machinery the dynamic runtime already has: a `node:vm` sandbox and registration guard for the host half, and closure evaluation, module seating, and teardown for the browser half. A package with no correctness reason to change its evaluation model should not have to.

## Decision

`@deepseek-ai/dsh-cordis-static-packages` is a boot-time loader for dual-half packages kept on disk, written in the same dynamic-package dialect `cordis_define` accepts. Its `packages` config field lists `{ id, name, sourceDir, host?, client? }` rows; at construction it validates them (duplicate id, relative `sourceDir`, or neither half named fails the constructor itself) and reads, evaluates, and mounts each configured host half.

Host-half evaluation reuses [`@deepseek-ai/dsh-cordis-host-runner`](../../../../packages/extensions/cordis-host-runner/README.md)'s primitives directly: `createSandbox`, `evaluateHostCode`, `startHostHalf`, `isPlugin`, and `normalizeHandler`, now exported from that package specifically so the static loader shares them rather than re-implementing the sandbox. A static host half therefore runs under the exact same `node:vm` timeout and registration guard as a `cordis_define`d one; a package promoted from a chat session keeps its behavior unchanged. A per-package read/evaluate/mount failure is recorded on the entry (`hostState: 'failed'`, `error`) and logged through `ctx.logger.error`, never thrown — one broken package must not take the others down, since the loader brings up an operator-curated list, not one model-issued call.

The configuration file is the operator's authorization. Unlike `cordis_define`'s run round trip, nothing here asks a person per run: listing a package's `sourceDir` in `cordis.yml`/`cordis.patch.yml` and restarting the process is the complete approval act, matching the trust stance the self-referential toolset note already assigns to a dynamic package. The registry itself stays process memory exactly like the dynamic runner's; the source files on disk are the only durable state, and editing them takes effect on the next restart, not live.

The browser half is loaded by `@deepseek-ai/dsh-cordis-static-packages-client`, a client plugin that lists configured packages through the `staticCordisPackages` Remote namespace, fetches each browser-half source, and loads it through `@deepseek-ai/dsh-cordis-client-runner`'s runner face — never by importing that package's runtime module directly, because plugin-to-plugin value imports are a build error under the client plugin loading model; a `ctx` service is the sanctioned route. That runner face gained two extension points for this: `load(half, overrides?)` accepts `DynamicCordisLoadOverrides` (`invoke`, `reportGuardFailure`, `reportRenderFailure`) so a browser half with no owning host-runner definition can route its `host.call` and failure reports to the static client instead of the host-runner's Agent-scoped paths, and `unload(pluginId, pluginRunId)` is the awaitable teardown a static package needs since it has no host-side stop to broadcast a `retract` event for. `ctx.dynamicCordisRunner.loadStatic`/`unloadStatic` are the face's static-facing wrappers around those two.

`packages/api/remotes` mounts the `staticCordisPackages` namespace alongside the existing `dynamicCordisRunner` one, and `packages/bundle/web-app`'s patch ships both new rows — the host row with an empty `packages` list, so a deployment lists its own packages by overriding that row's config in its own `cordis.patch.yml` by id, the same override mechanism every other bundle row uses.

## Alternatives considered

**A full rewrite to static plugins.** Rejected as the default path per package: correct for a package whose maintainers want typed `@Remote` methods and compiled bundles going forward, but not a requirement for keeping a proven chat-authored package running across a restart. The static loader does not block a later rewrite; it removes the false urgency to do one immediately.

**Re-defining every static package into the dynamic registry at boot.** Considered because it would reuse the dynamic runner's registry unchanged. Rejected: `runHostHalf` requires the owning Agent's authorization context and the registry's internal contract assumes a model-issued `define`/`run` pair, so re-defining at boot would still need a page-side run request and, effectively, an approval per restart — exactly the friction the loader exists to remove.

**Leaving packages dynamic and adding a restore skill.** Rejected: it still costs one chat message and N per-package approvals every restart, plus a manual reload click per already-open page, none of which a configuration file needs to pay again.

**An out-of-tree profile package serving an HTTP route.** Rejected: typed Remote namespaces are generated only for in-monorepo packages, so this path would need a hand-rolled client bundle build outside the shared tsdown preset, duplicating machinery `dsh-cordis-client-runner` already provides for free.

## Consequences

A configured package survives a process restart and, once its host half is running again, is fetched and loaded fresh by every reconnecting page — no explicit "restore" step exists because there is nothing to restore beyond running the loader again. The cost is that a static package's `id` shares the dynamic runner's module-id space, so a static id and a chat-session-defined id must not collide, and hot editing is gone: a `host`/`client` file change needs a process restart, unlike a `cordis_define` call that takes effect on the next run. There is also no UI row for a static package in the panel that operates `cordis_define`d packages; a boot-time failure is visible only through `list()` or the process log, not any push notification. The trade this makes explicit is authorization granularity: the toolset's per-run human approval becomes a one-time, config-file-level decision, appropriate for a package an operator has already reviewed and wants running unattended.
