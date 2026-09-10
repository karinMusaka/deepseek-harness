/**
 * Boot-time loader for dual-half packages kept on disk. Each configured
 * package names a directory holding a host half and/or a browser half written
 * in the dynamic-package dialect (an async function body evaluated with the
 * `harness` verbs, returning a plugin). The host half runs under the same
 * `node:vm` sandbox, registration guard, and fiber group discipline as a
 * `cordis_define`d package, so a package promoted from a chat session keeps
 * its behavior; the browser half is served to the page over this Remote
 * namespace and its `host.call` traffic is routed back through `invoke`.
 *
 * The configuration file is the operator's authorization: nothing here asks a
 * person per run, and nothing survives outside process memory except the
 * source files themselves.
 * @module @deepseek-ai/dsh-cordis-static-packages
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  createSandbox, evaluateHostCode, isPlugin, normalizeHandler, startHostHalf,
} from '@deepseek-ai/dsh-cordis-host-runner'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type {
  StaticCordisClientSource, StaticCordisHostState, StaticCordisInvokeResult, StaticCordisPackageRow,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    staticCordisPackages: StaticCordisPackagesService
  }
}

/** One package the loader brings up at boot. */
export interface StaticCordisPackageConfig {
  /** Stable id: lowercase letter first, then lowercase letters, digits, or hyphens (3–32 characters). */
  id: string
  /** Label shown by the browser half and used as its plugin name. */
  name: string
  /** Absolute directory holding the package sources. */
  sourceDir: string
  /** Host-half file name inside `sourceDir`; omit for a browser-only package. */
  host?: string
  /** Browser-half file name inside `sourceDir`; omit for a host-only package. */
  client?: string
}

/** Loader configuration. */
export interface Config {
  /** Maximum synchronous VM evaluation time per host half, in milliseconds. */
  vmTimeoutMs?: number
  /** Packages to load at boot. */
  packages?: StaticCordisPackageConfig[]
}

const ID_PATTERN = /^[a-z][a-z0-9-]{2,31}$/

const packageSchema: z<StaticCordisPackageConfig> = z.object({
  id: z.string().pattern(ID_PATTERN).required(),
  name: z.string().required(),
  sourceDir: z.string().required(),
  host: z.string(),
  client: z.string(),
})

/** One loaded package: its configuration, host-half state, and handler table. */
interface Entry {
  config: StaticCordisPackageConfig
  hostState: StaticCordisHostState
  error?: string
  handlers: Map<string, (args: unknown) => Promise<unknown>>
  fiber?: Fiber
  clientCode?: string
}

/**
 * Message and stack of a thrown value, for wire answers and boot diagnostics.
 * Duck-typed rather than `instanceof Error`: a value thrown inside a host half
 * is an Error of the vm realm, which never satisfies the host realm's check.
 */
function describe(error: unknown): { message: string; stack?: string } {
  if (typeof error !== 'object' || error === null) return { message: String(error) }
  const message = 'message' in error && typeof error.message === 'string'
    ? error.message
    : Object.prototype.toString.call(error)
  const stack = 'stack' in error && typeof error.stack === 'string' ? error.stack : undefined
  return { message, ...stack === undefined ? {} : { stack } }
}

/** Static package table and host-half lifecycle. */
export class StaticCordisPackagesService extends TypertRemoteService {
  static Config: z<Config> = z.object({
    vmTimeoutMs: z.number().min(1).default(5000),
    packages: z.array(packageSchema).default([]),
  })

  /** Settles when every configured package has been brought up or recorded as failed. */
  readonly ready: Promise<void>

  private readonly entries = new Map<string, Entry>()
  private readonly vmTimeoutMs: number
  private group: Fiber | undefined

  /**
   * Validate the configuration and start loading every package.
   * @param ctx - Host composition context; host halves mount under a child group of it.
   * @param config - Loader configuration, already normalized by `Config`.
   * @throws when two packages share an id, a `sourceDir` is relative, or a package names no half.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'staticCordisPackages')
    this.vmTimeoutMs = config.vmTimeoutMs ?? 5000
    for (const pkg of config.packages ?? []) {
      if (this.entries.has(pkg.id)) throw new Error(`cordis-static-packages: duplicate package id "${pkg.id}"`)
      if (!isAbsolute(pkg.sourceDir)) {
        throw new Error(`cordis-static-packages: package "${pkg.id}" needs an absolute sourceDir, got "${pkg.sourceDir}"`)
      }
      if (pkg.host === undefined && pkg.client === undefined) {
        throw new Error(`cordis-static-packages: package "${pkg.id}" names neither a host nor a client file`)
      }
      // A host-configured entry reads as failed until its own start() settles;
      // every Remote method awaits `ready`, so that interim state is never served.
      this.entries.set(pkg.id, {
        config: pkg,
        hostState: pkg.host === undefined ? 'none' : 'failed',
        handlers: new Map(),
      })
    }
    this.ready = this.startAll()
  }

  /**
   * List every configured package with its host-half status. Answers only
   * after boot has settled, so a page reconnecting during startup never reads
   * a package that has not been evaluated yet as failed.
   * @returns one row per configured package, in configuration order.
   */
  @Remote('list')
  async list(): Promise<StaticCordisPackageRow[]> {
    await this.ready
    return [...this.entries.values()].map(entry => ({
      id: entry.config.id,
      name: entry.config.name,
      hasClientHalf: entry.config.client !== undefined,
      hostState: entry.hostState,
      ...entry.error === undefined ? {} : { error: entry.error },
    }))
  }

  /**
   * Serve one package's browser-half source to the page; answers after boot has settled.
   * @param id - Configured package id.
   * @returns the source, or why none is served (unknown id, no browser half, or a failed host half).
   */
  @Remote('clientSource')
  async clientSource(id: string): Promise<StaticCordisClientSource> {
    await this.ready
    const entry = this.entries.get(id)
    if (entry === undefined) return { ok: false, message: `no static package "${id}" is configured` }
    if (entry.clientCode === undefined) return { ok: false, message: `static package "${id}" has no browser half` }
    if (entry.hostState === 'failed') {
      return { ok: false, message: `static package "${id}" host half failed: ${entry.error ?? 'unknown error'}` }
    }
    return { ok: true, id, name: entry.config.name, code: entry.clientCode }
  }

  /**
   * Route one `host.call` from a package's browser half to the method its host half registered.
   * @param id - Configured package id.
   * @param method - Method name given to `harness.handle`.
   * @param args - JSON argument the browser half passed (`null` when it passed none).
   * @returns the handler's JSON answer, or which routing step refused.
   */
  @Remote('invoke')
  async invoke(id: string, method: string, args: JsonValue): Promise<StaticCordisInvokeResult> {
    await this.ready
    const entry = this.entries.get(id)
    if (entry === undefined) return { ok: false, code: 'package-missing', message: `no static package "${id}" is configured` }
    if (entry.hostState !== 'running') {
      return { ok: false, code: 'host-not-running', message: `static package "${id}" has no running host half` }
    }
    const handler = entry.handlers.get(method)
    if (handler === undefined) {
      return { ok: false, code: 'method-not-found', message: `static package "${id}" registered no Host method "${method}"` }
    }
    try {
      return { ok: true, value: await handler(args) as JsonValue }
    } catch (error) {
      return { ok: false, code: 'handler-error', ...describe(error) }
    }
  }

  private async startAll(): Promise<void> {
    for (const entry of this.entries.values()) {
      await this.start(entry)
    }
  }

  /**
   * Read one package's halves and mount its host half. A failure is recorded
   * on the entry and logged rather than thrown: one broken package must not
   * take the others down, and `list` reports it to the page.
   */
  private async start(entry: Entry): Promise<void> {
    const { id, sourceDir, host, client } = entry.config
    try {
      if (client !== undefined) entry.clientCode = await readFile(join(sourceDir, client), 'utf8')
      if (host === undefined) return
      const hostCode = await readFile(join(sourceDir, host), 'utf8')
      const handle = (method: unknown, fn: unknown): (() => void) => {
        const normalized = normalizeHandler(method, fn)
        entry.handlers.set(normalized.method, normalized.handler)
        return () => {
          if (entry.handlers.get(normalized.method) === normalized.handler) entry.handlers.delete(normalized.method)
        }
      }
      const evaluated = await evaluateHostCode(createSandbox(id, { handle }), hostCode, id, this.vmTimeoutMs)
      if (!isPlugin(evaluated)) {
        throw new Error(evaluated === undefined
          ? 'the host half returned `undefined` — did you forget `return`?'
          : 'the host half must return a Plugin function or an object with apply(ctx)')
      }
      entry.fiber = await startHostHalf(this.requireGroup(), evaluated, (error) => {
        this.ctx.logger.warn(`cordis-static-packages: ${id} host guard rejected runtime code: ${describe(error).message}`)
      })
      entry.hostState = 'running'
    } catch (error) {
      entry.handlers.clear()
      entry.hostState = 'failed'
      entry.error = describe(error).message
      this.ctx.logger.error(`cordis-static-packages: ${id} failed to start: ${entry.error}`)
    }
  }

  private requireGroup(): Fiber {
    this.group ??= this.ctx.plugin({ name: 'cordis-static', apply: () => {} })
    return this.group
  }
}

export default StaticCordisPackagesService
