/* oxlint-disable typescript/no-unsafe-assignment -- Vitest asymmetric matchers are typed as any. */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import StaticCordisPackagesService from '../src/index.ts'
import type { Config } from '../src/index.ts'

/**
 * Real-composition coverage for the boot-time static-package loader: every
 * package under test is a real temp-directory source tree evaluated through
 * the same `node:vm` sandbox a `cordis_define`d package runs under, mounted
 * on a real `Context`. Only two narrow seams are mocked (below), each
 * defaulting to the real implementation so every other test keeps exercising
 * real disk I/O and the real registration-guard wrapper.
 */

declare module '@deepseek-ai/cordis' {
  interface Events {
    'cordis-static-packages-test-guard-trigger': () => void
  }
}

// Controls exactly two `readFile` calls (by absolute path) for the single
// test that observes the loader mid-boot, before its host half settles —
// a window no amount of `await Promise.resolve()` on the REAL fs can pin
// deterministically, since real disk I/O completes off the microtask queue.
const fsRaceState = vi.hoisted(() => ({
  gates: new Map<string, Promise<string>>(),
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: ((path: unknown, encoding: unknown) => {
      const gate = fsRaceState.gates.get(String(path))
      if (gate !== undefined) return gate
      return (actual.readFile as (path: unknown, encoding: unknown) => Promise<string>)(path, encoding)
    }) as typeof actual.readFile,
  }
})

// Controls the `harness.handle` registration for the single test proving
// `describe()` omits `stack` when absent: every thrown value a *sandboxed*
// host half can produce is a vm-realm Error, which the host-realm
// `instanceof Error` check never recognizes (proven below), so the only way
// to reach a host-realm Error with no `stack` is to construct one directly.
const handlerOverrideState = vi.hoisted(() => ({
  override: undefined as ((method: unknown, fn: unknown) => {
    method: string
    handler: (args: unknown) => Promise<unknown>
  }) | undefined,
}))

vi.mock('@deepseek-ai/dsh-cordis-host-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-cordis-host-runner')>()
  return {
    ...actual,
    normalizeHandler: (method: unknown, fn: unknown) => {
      if (handlerOverrideState.override !== undefined) return handlerOverrideState.override(method, fn)
      return actual.normalizeHandler(method, fn)
    },
  }
})

const tempRoots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  fsRaceState.gates.clear()
  handlerOverrideState.override = undefined
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** A fresh temp directory (macOS-`/var`-symlink-safe), cleaned up in `afterEach`. */
async function mkRoot(): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'dsh-static-pkgs-'))
  tempRoots.push(root)
  return root
}

/** One package's source directory under `root`. */
async function pkgDir(root: string, name: string): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  return dir
}

/** Write one package's source files. */
async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  await Promise.all(Object.entries(files).map(([name, content]) => writeFile(join(dir, name), content, 'utf8')))
}

/** A fresh root `Context`, disposed in `afterEach`. */
function createCtx(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

/** Mount the service on `ctx` and await every configured package's boot. */
async function boot(ctx: Context, config: Config): Promise<StaticCordisPackagesService> {
  await ctx.plugin(StaticCordisPackagesService, config)
  const service = ctx.staticCordisPackages
  await service.ready
  return service
}

/** A fresh `Context` with the service mounted and booted. */
async function mount(config: Config): Promise<{ ctx: Context; service: StaticCordisPackagesService }> {
  const ctx = createCtx()
  const service = await boot(ctx, config)
  return { ctx, service }
}

/** A resolvable-from-outside promise. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

describe('a package with both halves', () => {
  it('lists running state, serves client source, and routes invoke including a null-argument call', async () => {
    const root = await mkRoot()
    const dir = await pkgDir(root, 'echo')
    await writeFiles(dir, {
      'host.js': `
        return {
          name: 'echo-package',
          apply() {
            harness.handle('echo', (args) => ({ got: args }))
          },
        }
      `,
      'client.js': '// echo client half',
    })
    const { service } = await mount({
      packages: [{ id: 'echo-pkg', name: 'Echo', sourceDir: dir, host: 'host.js', client: 'client.js' }],
    })

    await expect(service.list()).resolves.toEqual([
      { id: 'echo-pkg', name: 'Echo', hasClientHalf: true, hostState: 'running' },
    ])
    await expect(service.clientSource('echo-pkg')).resolves.toEqual({
      ok: true, id: 'echo-pkg', name: 'Echo', code: '// echo client half',
    })
    await expect(service.invoke('echo-pkg', 'echo', { a: 1 })).resolves.toEqual({
      ok: true, value: { got: { a: 1 } },
    })
    await expect(service.invoke('echo-pkg', 'echo', null)).resolves.toEqual({
      ok: true, value: { got: null },
    })
  })
})

describe('a loader with no configured packages', () => {
  it('boots to an empty table when `packages` is omitted from a raw, unnormalized config', async () => {
    // Direct construction bypasses the `Config` schema's own `packages`
    // default (`z.array(packageSchema).default([])`) — `ctx.plugin(...)`
    // normalizes that default in BEFORE the constructor runs, so only a raw
    // config exercises the constructor's OWN `config.packages ?? []` fallback.
    const ctx = createCtx()
    const service = new StaticCordisPackagesService(ctx, {})
    await service.ready
    await expect(service.list()).resolves.toEqual([])
  })
})

describe('invoke refusals', () => {
  it('reports package-missing for an unconfigured id', async () => {
    const { service } = await mount({ packages: [] })
    await expect(service.invoke('ghost', 'm', null)).resolves.toEqual({
      ok: false, code: 'package-missing', message: 'no static package "ghost" is configured',
    })
  })

  it('reports method-not-found for an unregistered method on a running package', async () => {
    const root = await mkRoot()
    const dir = await pkgDir(root, 'noop')
    await writeFiles(dir, { 'host.js': "return { name: 'noop', apply() {} }" })
    const { service } = await mount({
      packages: [{ id: 'noop-pkg', name: 'Noop', sourceDir: dir, host: 'host.js' }],
    })
    await expect(service.invoke('noop-pkg', 'ghost', null)).resolves.toEqual({
      ok: false, code: 'method-not-found', message: 'static package "noop-pkg" registered no Host method "ghost"',
    })
  })

  it('reports handler-error with the vm-realm Error message and stack when the sandbox throws', async () => {
    // The thrown Error is constructed inside the vm realm, so a host-realm
    // `instanceof Error` would never recognize it; `describe()` duck-types the
    // message and stack instead, matching the dynamic runner's errorDetails.
    const root = await mkRoot()
    const dir = await pkgDir(root, 'boom')
    await writeFiles(dir, {
      'host.js': "return { name: 'boom', apply() { harness.handle('boom', () => { throw new Error('boom message') }) } }",
    })
    const { service } = await mount({
      packages: [{ id: 'boom-pkg', name: 'Boom', sourceDir: dir, host: 'host.js' }],
    })
    await expect(service.invoke('boom-pkg', 'boom', null)).resolves.toEqual({
      ok: false, code: 'handler-error', message: 'boom message', stack: expect.stringContaining('boom message'),
    })
  })

  it('reports handler-error with a stack when a host-realm serialization rejection throws', async () => {
    // `cloneJson` runs in the HOST realm (dsh-cordis-host-runner), so a
    // handler returning a value it rejects (here: undefined) reaches
    // describe() as a genuine host Error, with a real stack.
    const root = await mkRoot()
    const dir = await pkgDir(root, 'unserializable')
    await writeFiles(dir, {
      'host.js': "return { name: 'unserializable', apply() { harness.handle('bad-return', () => undefined) } }",
    })
    const { service } = await mount({
      packages: [{ id: 'unserializable-pkg', name: 'Unserializable', sourceDir: dir, host: 'host.js' }],
    })
    const result = await service.invoke('unserializable-pkg', 'bad-return', null)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('handler-error')
    expect(result.message).toContain('must be lossless JSON data')
    expect(result.stack).toBeDefined()
  })

  it('omits the stack field when a host-realm handler-error throws an Error without one', async () => {
    const root = await mkRoot()
    const dir = await pkgDir(root, 'stackless')
    await writeFiles(dir, {
      'host.js': "return { name: 'stackless', apply() { harness.handle('boom', () => {}) } }",
    })
    handlerOverrideState.override = () => ({
      method: 'boom',
      handler: async () => {
        const error = new Error('no stack available')
        delete (error as { stack?: string }).stack
        throw error
      },
    })
    const { service } = await mount({
      packages: [{ id: 'stackless-pkg', name: 'Stackless', sourceDir: dir, host: 'host.js' }],
    })
    await expect(service.invoke('stackless-pkg', 'boom', null)).resolves.toEqual({
      ok: false, code: 'handler-error', message: 'no stack available',
    })
  })

  it('reports host-not-running for a package whose host half failed', async () => {
    const root = await mkRoot()
    const dir = await pkgDir(root, 'never-loads')
    const { service } = await mount({
      packages: [{ id: 'failed-pkg', name: 'Failed', sourceDir: dir, host: 'missing.js' }],
    })
    await expect(service.invoke('failed-pkg', 'anything', null)).resolves.toEqual({
      ok: false, code: 'host-not-running', message: 'static package "failed-pkg" has no running host half',
    })
  })
})

describe('clientSource refusals', () => {
  it('reports an unknown id', async () => {
    const { service } = await mount({ packages: [] })
    await expect(service.clientSource('ghost')).resolves.toEqual({ ok: false, message: 'no static package "ghost" is configured' })
  })

  it('reports no browser half for a host-only package', async () => {
    const root = await mkRoot()
    const dir = await pkgDir(root, 'host-only')
    await writeFiles(dir, { 'host.js': "return { name: 'host-only', apply() {} }" })
    const { service } = await mount({
      packages: [{ id: 'host-only-pkg', name: 'HostOnly', sourceDir: dir, host: 'host.js' }],
    })
    await expect(service.clientSource('host-only-pkg')).resolves.toEqual({
      ok: false, message: 'static package "host-only-pkg" has no browser half',
    })
  })
})

describe('a client-only package', () => {
  it('reports hostState none, serves its client source, and refuses invoke', async () => {
    const root = await mkRoot()
    const dir = await pkgDir(root, 'client-only')
    await writeFiles(dir, { 'client.js': 'return () => {}' })
    const { service } = await mount({
      packages: [{ id: 'client-only-pkg', name: 'ClientOnly', sourceDir: dir, client: 'client.js' }],
    })
    await expect(service.list()).resolves.toEqual([
      { id: 'client-only-pkg', name: 'ClientOnly', hasClientHalf: true, hostState: 'none' },
    ])
    await expect(service.clientSource('client-only-pkg')).resolves.toEqual({
      ok: true, id: 'client-only-pkg', name: 'ClientOnly', code: 'return () => {}',
    })
    await expect(service.invoke('client-only-pkg', 'anything', null)).resolves.toEqual({
      ok: false, code: 'host-not-running', message: 'static package "client-only-pkg" has no running host half',
    })
  })
})

describe('constructor validation', () => {
  it('rejects a duplicate package id', () => {
    const ctx = createCtx()
    expect(() => new StaticCordisPackagesService(ctx, {
      packages: [
        { id: 'dup-pkg', name: 'A', sourceDir: '/abs/a', client: 'a.js' },
        { id: 'dup-pkg', name: 'B', sourceDir: '/abs/b', client: 'b.js' },
      ],
    })).toThrow('cordis-static-packages: duplicate package id "dup-pkg"')
  })

  it('rejects a relative sourceDir', () => {
    const ctx = createCtx()
    expect(() => new StaticCordisPackagesService(ctx, {
      packages: [{ id: 'rel-pkg', name: 'Rel', sourceDir: 'relative/dir', client: 'a.js' }],
    })).toThrow('cordis-static-packages: package "rel-pkg" needs an absolute sourceDir, got "relative/dir"')
  })

  it('rejects a package naming neither a host nor a client file', () => {
    const ctx = createCtx()
    expect(() => new StaticCordisPackagesService(ctx, {
      packages: [{ id: 'empty-pkg', name: 'Empty', sourceDir: '/abs/empty' }],
    })).toThrow('cordis-static-packages: package "empty-pkg" names neither a host nor a client file')
  })
})

describe('host-half failure modes', () => {
  it('records ENOENT when the host file is missing, and logs it', async () => {
    const root = await mkRoot()
    const dir = await pkgDir(root, 'missing-host')
    const ctx = createCtx()
    const errorSpy = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    const service = await boot(ctx, {
      packages: [{ id: 'missing-host-pkg', name: 'MissingHost', sourceDir: dir, host: 'nope.js' }],
    })
    const [row] = await service.list()
    expect(row).toMatchObject({ id: 'missing-host-pkg', hostState: 'failed' })
    expect(row?.error).toContain('ENOENT')
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0]?.[0]).toContain('missing-host-pkg failed to start')
  })

  it('records a syntax error in the host source with parse diagnostics', async () => {
    const root = await mkRoot()
    const dir = await pkgDir(root, 'syntax-bad')
    await writeFiles(dir, { 'host.js': 'return {' })
    const { service } = await mount({
      packages: [{ id: 'syntax-pkg', name: 'Syntax', sourceDir: dir, host: 'host.js' }],
    })
    const [row] = await service.list()
    expect(row?.hostState).toBe('failed')
    expect(row?.error).toContain('failed to parse')
  })

  it('records a "did you forget return" failure when the host half returns undefined', async () => {
    const root = await mkRoot()
    const dir = await pkgDir(root, 'undef-return')
    await writeFiles(dir, { 'host.js': "harness.handle('noop', () => {})" })
    const { service } = await mount({
      packages: [{ id: 'undef-pkg', name: 'Undef', sourceDir: dir, host: 'host.js' }],
    })
    await expect(service.list()).resolves.toEqual([{
      id: 'undef-pkg',
      name: 'Undef',
      hasClientHalf: false,
      hostState: 'failed',
      error: 'the host half returned `undefined` — did you forget `return`?',
    }])
  })

  it('records a non-plugin-value failure when the host half returns a primitive', async () => {
    const root = await mkRoot()
    const dir = await pkgDir(root, 'primitive-return')
    await writeFiles(dir, { 'host.js': 'return 42' })
    const { service } = await mount({
      packages: [{ id: 'primitive-pkg', name: 'Primitive', sourceDir: dir, host: 'host.js' }],
    })
    await expect(service.list()).resolves.toEqual([{
      id: 'primitive-pkg',
      name: 'Primitive',
      hasClientHalf: false,
      hostState: 'failed',
      error: 'the host half must return a Plugin function or an object with apply(ctx)',
    }])
  })

  it('records a failure when the returned plugin\'s apply throws during activation', async () => {
    const root = await mkRoot()
    const dir = await pkgDir(root, 'apply-throws')
    await writeFiles(dir, {
      'host.js': "return { name: 'apply-throws', apply() { throw new Error('apply boom') } }",
    })
    const { service } = await mount({
      packages: [{ id: 'apply-throws-pkg', name: 'ApplyThrows', sourceDir: dir, host: 'host.js' }],
    })
    await expect(service.list()).resolves.toEqual([{
      id: 'apply-throws-pkg',
      name: 'ApplyThrows',
      hasClientHalf: false,
      hostState: 'failed',
      // The vm-realm "apply boom" Error fails lifecycle.ts's own host-realm
      // `instanceof Error` check too, so it is re-wrapped there as a fresh
      // host Error whose message is the String(vmError) fallback.
      error: 'Error: apply boom',
    }])
  })

  it('keeps other configured packages running when one fails, and serves the failed one\'s clientSource as a host failure', async () => {
    const root = await mkRoot()
    const goodDir = await pkgDir(root, 'good')
    await writeFiles(goodDir, { 'host.js': "return { name: 'good', apply() {} }" })
    const secondGoodDir = await pkgDir(root, 'second-good')
    await writeFiles(secondGoodDir, { 'host.js': "return { name: 'second-good', apply() {} }" })
    const failDir = await pkgDir(root, 'fail')
    await writeFiles(failDir, { 'client.js': 'return () => {}' })

    const { service } = await mount({
      packages: [
        { id: 'good-pkg', name: 'Good', sourceDir: goodDir, host: 'host.js' },
        // A second successfully-loading host half: exercises the shared
        // `cordis-static` group fiber being reused, not created again.
        { id: 'second-good-pkg', name: 'SecondGood', sourceDir: secondGoodDir, host: 'host.js' },
        { id: 'fail-pkg', name: 'Fail', sourceDir: failDir, host: 'missing.js', client: 'client.js' },
      ],
    })

    await expect(service.list()).resolves.toEqual([
      { id: 'good-pkg', name: 'Good', hasClientHalf: false, hostState: 'running' },
      { id: 'second-good-pkg', name: 'SecondGood', hasClientHalf: false, hostState: 'running' },
      {
        id: 'fail-pkg', name: 'Fail', hasClientHalf: true, hostState: 'failed',
        error: expect.stringContaining('ENOENT') as unknown as string,
      },
    ])

    const source = await service.clientSource('fail-pkg')
    expect(source.ok).toBe(false)
    if (source.ok) throw new Error('unreachable')
    expect(source.message).toContain('fail-pkg" host half failed:')
    expect(source.message).toContain('ENOENT')
  })

  it('answers list and clientSource only after boot settled, never reporting an unevaluated host half as failed', async () => {
    const root = await mkRoot()
    const dir = await pkgDir(root, 'race')
    const clientPath = join(dir, 'client.js')
    const hostPath = join(dir, 'host.js')
    const clientGate = deferred<string>()
    const hostGate = deferred<string>()
    fsRaceState.gates.set(clientPath, clientGate.promise)
    fsRaceState.gates.set(hostPath, hostGate.promise)

    const ctx = createCtx()
    const service = new StaticCordisPackagesService(ctx, {
      packages: [{ id: 'race-pkg', name: 'Race', sourceDir: dir, host: 'host.js', client: 'client.js' }],
    })

    let settled = false
    const pendingSource = service.clientSource('race-pkg').then((value) => { settled = true; return value })
    const pendingList = service.list()
    clientGate.resolve('return () => {}')
    await Promise.resolve()
    await Promise.resolve()
    // The host file is still being read: a page asking now waits instead of
    // being told the package failed.
    expect(settled).toBe(false)

    hostGate.resolve("return { name: 'race', apply() {} }")
    await expect(pendingSource).resolves.toEqual({ ok: true, id: 'race-pkg', name: 'Race', code: 'return () => {}' })
    await expect(pendingList).resolves.toEqual([
      { id: 'race-pkg', name: 'Race', hasClientHalf: true, hostState: 'running' },
    ])
  })
})

describe('vmTimeoutMs', () => {
  it('bounds synchronous host evaluation and records a timeout failure', async () => {
    const root = await mkRoot()
    const dir = await pkgDir(root, 'busy')
    await writeFiles(dir, { 'host.js': 'while (true) {}' })
    const { service } = await mount({
      vmTimeoutMs: 20,
      packages: [{ id: 'busy-pkg', name: 'Busy', sourceDir: dir, host: 'host.js' }],
    })
    const [row] = await service.list()
    expect(row?.hostState).toBe('failed')
    expect(row?.error).toMatch(/timed out after \d+ms/)
  })
})

describe('handler disposal and replacement', () => {
  it('removes the method via its disposer, and a stale disposer no-ops after replacement', async () => {
    const root = await mkRoot()
    const dir = await pkgDir(root, 'disposer')
    await writeFiles(dir, {
      'host.js': `
        return {
          name: 'disposer-package',
          apply() {
            const disposeA = harness.handle('m', () => 'A')
            const disposeB = harness.handle('m', () => 'B')
            harness.handle('dispose-a', () => { disposeA(); return 'ok' })
            harness.handle('dispose-b', () => { disposeB(); return 'ok' })
          },
        }
      `,
    })
    const { service } = await mount({
      packages: [{ id: 'disposer-pkg', name: 'Disposer', sourceDir: dir, host: 'host.js' }],
    })

    // The second `harness.handle('m', ...)` call replaced the first.
    await expect(service.invoke('disposer-pkg', 'm', null)).resolves.toEqual({ ok: true, value: 'B' })

    // Disposing the FIRST (stale) registration is a no-op: 'm' still resolves.
    await expect(service.invoke('disposer-pkg', 'dispose-a', null)).resolves.toEqual({ ok: true, value: 'ok' })
    await expect(service.invoke('disposer-pkg', 'm', null)).resolves.toEqual({ ok: true, value: 'B' })

    // Disposing the current registration removes it.
    await expect(service.invoke('disposer-pkg', 'dispose-b', null)).resolves.toEqual({ ok: true, value: 'ok' })
    await expect(service.invoke('disposer-pkg', 'm', null)).resolves.toEqual({
      ok: false, code: 'method-not-found', message: 'static package "disposer-pkg" registered no Host method "m"',
    })
  })
})

describe('host guard rejection after activation', () => {
  it('logs the guard failure via ctx.logger.warn and leaves the package running', async () => {
    const root = await mkRoot()
    const dir = await pkgDir(root, 'guard-violator')
    await writeFiles(dir, {
      'host.js': `
        return {
          name: 'guard-violator',
          apply(pluginCtx) {
            pluginCtx.on('cordis-static-packages-test-guard-trigger', () => {
              pluginCtx.forbiddenService
            })
          },
        }
      `,
    })
    const { ctx, service } = await mount({
      packages: [{ id: 'guard-pkg', name: 'Guard', sourceDir: dir, host: 'host.js' }],
    })
    const warnSpy = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    await expect(service.list()).resolves.toEqual([
      { id: 'guard-pkg', name: 'Guard', hasClientHalf: false, hostState: 'running' },
    ])

    // The listener runs asynchronously (long) after activation, so the
    // violation is reported — never a startup failure.
    expect(() => { ctx.emit('cordis-static-packages-test-guard-trigger') }).toThrow()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toContain('cordis-static-packages: guard-pkg host guard rejected runtime code:')

    await expect(service.list()).resolves.toEqual([
      { id: 'guard-pkg', name: 'Guard', hasClientHalf: false, hostState: 'running' },
    ])
  })
})
