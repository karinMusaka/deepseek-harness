# @deepseek-ai/dsh-cordis-static-packages-client

English | [中文](README.zh.md)

Browser half of static dual-half packages. At activation it asks the `staticCordisPackages` namespace which packages the host loaded, fetches each browser-half source, and seats it through the dynamic-package runner face (`ctx.dynamicCordisRunner.loadStatic`) with `host.call` routed to the static loader's `invoke`. Unloads them on disposal. Nothing here asks a person: the host's configuration file already authorized every package.

## What it does

`apply` lists packages via `ctx.remote.staticCordisPackages.list()`, then for each row with a browser half whose host state is not `failed`, fetches `clientSource(id)` and calls `ctx.dynamicCordisRunner.loadStatic({ pluginId, name, code, invoke, reportGuardFailure, reportRenderFailure })`. `invoke` routes to `ctx.remote.staticCordisPackages.invoke(id, method, args)`; a routing refusal or a handler error becomes a teaching `Error` naming the call and the failing stage. `reportGuardFailure` and `reportRenderFailure` write to the browser console rather than to any host RPC — a static package has no owning Agent to report to. On disposal, every plugin id this page loaded is unloaded through `ctx.dynamicCordisRunner.unloadStatic`.

A listing failure, a source-fetch failure, an unservable source, or a load failure is logged to the browser console and that one package is skipped; the others still load.

The node half (`src/index.ts`) is an empty `apply` — it exists only so the plugin appears in the host `cordis.yml`/Loader; the browser half ships through `exports["./client"]`, discovered by the `dsh.client` package.json declaration. This package never imports `@deepseek-ai/dsh-cordis-client-runner` or `@deepseek-ai/dsh-cordis-static-packages` for values, only for types (`ctx.dynamicCordisRunner` face types and `StaticCordisInvokeResult`) — cross-package plugin-to-plugin value imports are a build error, so the sanctioned route to the loader is the `ctx.dynamicCordisRunner` service.

## Model Experience

None, as this package routes guard and render failures to the browser console only; nothing it authors reaches a model.

#### KV Cache effect

None. This package neither sends nor receives any model-visible content; a loaded package's own host half owns whatever tool or context effect it registers.

## Known Limitations and Deferred Work

- **Loaded once at activation, never re-synced.** A package added, removed, or changed on the host after this plugin activated is not picked up without a page reload.
- **No retry.** A failed list, fetch, or load for one package is not retried; only a page reload tries again.
- **Failures are browser-console only.** Nothing here reports a load failure back to the host or to any model-visible surface.
