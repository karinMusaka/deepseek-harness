/**
 * @vitest-environment jsdom
 *
 * Static-package browser half account: `list()` drives one `loadStatic` per
 * eligible row with the identity/source passed through; a row with no browser
 * half, a failed host half, an unservable or unreachable source, or a load
 * failure is skipped and logged without stopping the others; a listing carrier
 * failure makes `apply` throw; the `invoke` closure this plugin hands to each
 * `loadStatic` call unwraps a successful answer and teaches each refusal shape;
 * and disposing the plugin's fiber unloads every package it actually seated.
 * Plus the two plane-level companions: the node half's empty apply and the
 * invariant registration.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import InvariantService from '@deepseek-ai/dsh-invariants'
import type { CordisDynamicPluginRunId, JsonValue } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  StaticCordisClientSource, StaticCordisInvokeResult, StaticCordisPackageRow,
} from '@deepseek-ai/dsh-cordis-static-packages/types'
import type { CordisStaticLoadRequest, DynamicCordisLoadResult } from '@deepseek-ai/dsh-cordis-client-runner/client'
import * as NodeHalf from '../src/index.ts'
import * as Invariant from '../src/invariant.ts'
import * as ClientHalf from '../src/client/index.ts'

/**
 * What every generated Remote method resolves to (structurally, without a
 * dependency on `@deepseek-ai/dsh-typert-protocol`, which this package does not
 * declare): the carrier folds its own failures into the error branch.
 */
type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; details?: object } }

function ok<T>(value: T): Promise<Result<T>> {
  return Promise.resolve({ ok: true, value })
}

function carrierFail<T>(code: string, message: string): Promise<Result<T>> {
  return Promise.resolve({ ok: false, error: { code, message, details: {} } })
}

/** One configured row, defaulted to the common case: a running host half with a browser half. */
function row(overrides: Partial<StaticCordisPackageRow> = {}): StaticCordisPackageRow {
  return { id: 'p1', name: 'Demo', hasClientHalf: true, hostState: 'running', ...overrides }
}

/** The source `remote.clientSource` answers for a servable row. */
function source(id: string, name = 'Demo'): Extract<StaticCordisClientSource, { ok: true }> {
  return { ok: true, id, name, code: `return { apply() {} } /* ${id} */` }
}

interface BootConfig {
  list?: () => Promise<Result<StaticCordisPackageRow[]>>
  rows?: StaticCordisPackageRow[]
  clientSource?: (id: string) => Promise<Result<StaticCordisClientSource>>
  loadStaticImpl?: (request: CordisStaticLoadRequest) => Promise<DynamicCordisLoadResult>
}

interface Bench {
  ctx: Context
  fiber: ReturnType<Context['plugin']>
  loadStatic: ReturnType<typeof vi.fn>
  unloadStatic: ReturnType<typeof vi.fn>
  /** Every `remote.invoke` call the loaded halves' `invoke` closures made. */
  invoked: { id: string; method: string; args: unknown }[]
  /** Answer of the next `remote.invoke` call. */
  invokeResult: { current: Result<StaticCordisInvokeResult> }
  /** Every request `loadStatic` received, in call order. */
  captured: CordisStaticLoadRequest[]
}

/** Mount the browser half over a fake `remote.staticCordisPackages` and a fake `dynamicCordisRunner` face. */
function boot(config: BootConfig = {}): Bench {
  const ctx = new Context()
  const invoked: Bench['invoked'] = []
  const invokeResult: Bench['invokeResult'] = { current: { ok: true, value: { ok: true, value: 'pong' } } }
  const rows = config.rows ?? [row()]
  const captured: CordisStaticLoadRequest[] = []
  const namespace = {
    list: config.list ?? ((): Promise<Result<StaticCordisPackageRow[]>> => ok(rows)),
    clientSource: config.clientSource ?? ((id: string): Promise<Result<StaticCordisClientSource>> => ok(source(id))),
    invoke: (id: string, method: string, args: JsonValue): Promise<Result<StaticCordisInvokeResult>> => {
      invoked.push({ id, method, args })
      return Promise.resolve(invokeResult.current)
    },
  }
  const loadStatic = vi.fn((request: CordisStaticLoadRequest): Promise<DynamicCordisLoadResult> => {
    captured.push(request)
    return (config.loadStaticImpl ?? ((): Promise<DynamicCordisLoadResult> =>
      Promise.resolve({ ok: true, pluginRunId: 'static' as CordisDynamicPluginRunId })))(request)
  })
  const unloadStatic = vi.fn((): Promise<void> => Promise.resolve())
  ctx.reflect.provide('remote', { staticCordisPackages: namespace })
  ctx.reflect.provide('remote.staticCordisPackages', namespace)
  ctx.reflect.provide('dynamicCordisRunner', { loadStatic, unloadStatic })
  const fiber = ctx.plugin(ClientHalf)
  // A test that deliberately drives `apply` to throw (a listing carrier
  // failure) must not also surface as an unhandled rejection here.
  void Promise.resolve(fiber).catch(() => {})
  return { ctx, fiber, loadStatic, unloadStatic, invoked, invokeResult, captured }
}

describe('browser half', () => {
  it('loads every listed row with a client half, passing its identity and source through', async () => {
    const rows = [row({ id: 'a', name: 'Alpha' }), row({ id: 'b', name: 'Beta' })]
    const bench = boot({
      rows,
      clientSource: id => ok(source(id, id === 'a' ? 'Alpha' : 'Beta')),
    })
    await bench.fiber
    expect(bench.loadStatic).toHaveBeenCalledTimes(2)
    expect(bench.captured[0]).toMatchObject({ pluginId: 'a', name: 'Alpha', code: source('a', 'Alpha').code })
    expect(bench.captured[1]).toMatchObject({ pluginId: 'b', name: 'Beta', code: source('b', 'Beta').code })
  })

  it('skips a row with no browser half', async () => {
    const bench = boot({ rows: [row({ hasClientHalf: false })] })
    await bench.fiber
    expect(bench.loadStatic).not.toHaveBeenCalled()
  })

  it('skips and logs a row whose host half failed', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bench = boot({ rows: [row({ hostState: 'failed', error: 'boom host' })] })
    await bench.fiber
    expect(bench.loadStatic).not.toHaveBeenCalled()
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('skipping p1: its host half failed: boom host'))
    logged.mockRestore()
  })

  it('logs "unknown error" for a failed host half that carries no error text', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bench = boot({ rows: [row({ hostState: 'failed' })] })
    await bench.fiber
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('skipping p1: its host half failed: unknown error'))
    logged.mockRestore()
  })

  it('skips and logs a row whose source fetch fails at the carrier', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bench = boot({ clientSource: () => carrierFail('unavailable', 'down') })
    await bench.fiber
    expect(bench.loadStatic).not.toHaveBeenCalled()
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('fetching p1 source failed: unavailable: down'))
    logged.mockRestore()
  })

  it('skips and logs a row with no servable browser half', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bench = boot({ clientSource: () => ok({ ok: false, message: 'no half configured' }) })
    await bench.fiber
    expect(bench.loadStatic).not.toHaveBeenCalled()
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('p1 has no servable browser half: no half configured'))
    logged.mockRestore()
  })

  it('logs a loadStatic failure result without throwing', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bench = boot({ loadStaticImpl: () => Promise.resolve({ ok: false, cause: 'activate', message: 'boom apply' }) })
    await bench.fiber
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('loading p1 failed at activate: boom apply'))
    logged.mockRestore()
  })

  it('throws when listing static packages fails at the carrier', async () => {
    const bench = boot({ list: () => carrierFail('unavailable', 'down') })
    await expect(bench.fiber).rejects.toThrow(/listing static packages failed: unavailable: down/)
  })

  it('unloads every successfully loaded package when the plugin is disposed', async () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' })]
    const bench = boot({
      rows,
      clientSource: id => ok(source(id)),
      loadStaticImpl: request => Promise.resolve(
        request.pluginId === 'a'
          ? { ok: true, pluginRunId: 'static' as CordisDynamicPluginRunId }
          : { ok: false, cause: 'activate', message: 'nope' },
      ),
    })
    await bench.fiber
    await (bench.fiber as { dispose(): Promise<void> }).dispose()
    expect(bench.unloadStatic).toHaveBeenCalledTimes(1)
    expect(bench.unloadStatic).toHaveBeenCalledWith('a')
  })

  describe('the invoke closure given to loadStatic', () => {
    it('resolves with the handler value on a successful answer', async () => {
      const bench = boot()
      await bench.fiber
      bench.invokeResult.current = { ok: true, value: { ok: true, value: 'pong' } }
      await expect(bench.captured[0]?.invoke('ping', { a: 1 })).resolves.toBe('pong')
      expect(bench.invoked).toEqual([{ id: 'p1', method: 'ping', args: { a: 1 } }])
    })

    it('throws "did not complete" when the wire call itself is refused', async () => {
      const bench = boot()
      await bench.fiber
      bench.invokeResult.current = { ok: false, error: { code: 'unavailable', message: 'down', details: {} } }
      await expect(bench.captured[0]?.invoke('ping', null))
        .rejects.toThrow(/host\.call\("ping"\) on static package p1 did not complete: unavailable: down/)
    })

    it('throws with the handler message and an appended stack for a handler-error refusal', async () => {
      const bench = boot()
      await bench.fiber
      bench.invokeResult.current = { ok: true, value: { ok: false, code: 'handler-error', message: 'boom', stack: 'STACK TRACE' } }
      const failure = await bench.captured[0]?.invoke('ping', null).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toBe('host.call("ping") on static package p1 failed inside the host handler: boom')
      expect((failure as Error).stack).toContain('Host stack:\nSTACK TRACE')
    })

    it('throws the "was refused" text for any other refusal code, with no stack appended when absent', async () => {
      const bench = boot()
      await bench.fiber
      bench.invokeResult.current = { ok: true, value: { ok: false, code: 'package-missing', message: 'no such package' } }
      const failure = await bench.captured[0]?.invoke('ping', null).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toBe('host.call("ping") on static package p1 was refused (package-missing): no such package')
      expect((failure as Error).stack).not.toContain('Host stack:')
    })
  })

  it('logs a guard rejection and a render failure of a loaded package to the console', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bench = boot()
    await bench.fiber
    bench.captured[0]?.reportGuardFailure({ message: 'guard boom' })
    bench.captured[0]?.reportRenderFailure({ slot: 'root', message: 'render boom', abdicated: true })
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('p1 guard rejected runtime code:'), 'guard boom')
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('p1 crashed while rendering root:'), 'render boom')
    logged.mockRestore()
  })
})

describe('node half', () => {
  it('contributes nothing host-side', () => {
    NodeHalf.apply()
    expect(typeof NodeHalf.apply).toBe('function')
  })
})

describe('invariant companion', () => {
  it('reserves package ownership with an explained empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantService, { enabled: true })
    const fiber = ctx.plugin(Invariant)
    await fiber
    expect(Invariant.name).toBe('cordis-static-packages-client-invariant')
    await fiber.dispose()
  })
})
