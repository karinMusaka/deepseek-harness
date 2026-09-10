# @deepseek-ai/dsh-cordis-static-packages

English | [中文](README.zh.md)

Boot-time loader for dual-half packages kept on disk, written in the dynamic-package dialect. Each configured entry names a directory holding a host half and/or a browser half; the host half runs under the same `node:vm` sandbox, registration guard, and fiber lifecycle as a `cordis_define`d package, so a package promoted from a chat session keeps its behavior. Provided as `ctx.staticCordisPackages`, with a Remote namespace of the same name. The browser half is loaded by [`@deepseek-ai/dsh-cordis-static-packages-client`](../cordis-static-packages-client/README.md); the shared evaluation primitives come from [`@deepseek-ai/dsh-cordis-host-runner`](../cordis-host-runner/README.md).

## What it does

At construction, the service validates configuration and starts loading every configured package; `ready` settles once each has been brought up or recorded as failed. For each package:

- A configured `client` file is read as the browser-half source and held for `clientSource`.
- A configured `host` file is read, evaluated with `createSandbox`/`evaluateHostCode` (the same primitives `cordis_define` uses), and — once it resolves to a Plugin — mounted with `startHostHalf` under one child group fiber shared by every static package.
- `harness.handle` registrations from the host half populate a per-package handler table that `invoke` routes into.

A per-package failure at any of those steps is recorded on the entry (`hostState: 'failed'`, `error`) and logged through `ctx.logger.error`; the constructor never throws for it, so one broken package does not stop the others from loading. A duplicate `id`, a relative `sourceDir`, or a package naming neither `host` nor `client` fails the constructor itself, because those are configuration mistakes rather than per-package runtime failures.

- `list` returns one row per configured package (id, name, whether it has a browser half, `hostState`, and `error` when failed), in configuration order. Like `clientSource` and `invoke`, it answers only after boot has settled, so a page reconnecting during startup never reads a package that has not been evaluated yet as failed.
- `clientSource` serves one package's browser-half source, or why none is served: unknown id, no configured browser half, or a failed host half.
- `invoke` routes one `host.call` from a package's browser half to the method its host half registered, and answers which routing step refused: `package-missing`, `host-not-running`, `method-not-found`, or `handler-error` (with the thrown message and stack).

## Storage stance

The package table is process memory, rebuilt from configuration at every process start; nothing here writes to disk. The source files on disk are the durable state — editing `host`/`client` and restarting reloads them, and there is no separate registry to fall out of sync with the files.

## Trust stance

The configuration file is the operator's authorization: nothing here asks a person per run, unlike a `cordis_define`d package's request-run round trip. A host half runs under the same `node:vm` sandbox and guard as a defined one — isolating globals but not a security boundary, since the services it declares reach the live runtime. Treat a configured static package like bash access or a defined dynamic package; see the [self-referential toolset Agent Note](../../../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md).

## Config

| Field | Default | Meaning |
|---|---|---|
| `vmTimeoutMs` | `5000` | Milliseconds the synchronous portion of a host half may run in the vm before evaluation is aborted |
| `packages` | `[]` | Packages to load at boot: `{ id, name, sourceDir, host?, client? }` — `id` matches `^[a-z][a-z0-9-]{2,31}$`, `sourceDir` is absolute, and at least one of `host`/`client` is set |

## Export shape

Service package: default-exports `StaticCordisPackagesService` (service key `staticCordisPackages`), with `./types` carrying the payload shapes the `staticCordisPackages` remote namespace and its consumers share.

## How to promote a chat-defined package

1. Write `host.js` and/or `client.js` in the dynamic-package dialect (an async function body evaluated with the `harness` verbs, returning a plugin) into a directory outside the repository.
2. Add a config row overriding the `cordis-static-packages` row's config in `$DSH_HOME/cordis.patch.yml` (a patch replaces a row's whole `config`, so restate every key):

   ```yaml
   - id: cordis-static-packages
     config:
       packages:
         - id: my-package
           name: My Package
           sourceDir: /absolute/path/to/my-package
           host: host.js
           client: client.js
   ```

3. Restart the process; a running process does not pick up configuration edits.

## Model Experience

None, as this package registers no tool and injects no prompt of its own; a running package's host half may itself register tools, and that view is a consequence of its own registrations rather than this loader's.

#### KV Cache effect

A host half that registers tools changes the next request's tool view, which invalidates prefix reuse from the first changed schema token; a boot with no host half registering tools is prefix-neutral, and nothing here changes tool view again after boot — packages load once and are never reloaded without a process restart.

## Known Limitations and Deferred Work

- **No hot reload of sources.** A `host`/`client` file edit takes effect only on the next process restart; there is no watch, re-evaluate, or re-serve path while the process runs.
- **No UI row in the dynamic-package panel.** A static package's host half shares the runner's sandbox and guard, but the panel that operates `cordis_define`d packages does not list or control static ones.
- **A package failing to start is only visible via `list()` or logs.** There is no push notification of a boot-time failure; a consumer must call `list()` or read the process log.
- **Ids share the runner's module-id space with dynamic packages.** A static package's `id` becomes the browser module id the same way a `cordis_define`d package's does, so a static id and a chat-session-defined id must not collide.
