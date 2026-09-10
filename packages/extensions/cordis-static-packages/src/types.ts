/**
 * Wire payloads of the `staticCordisPackages` Remote namespace. Client-safe: types only.
 * @module @deepseek-ai/dsh-cordis-static-packages/types
 */

import type { JsonValue } from '@deepseek-ai/dsh-session/types'

/** Where a configured package's host half stands after boot. */
export type StaticCordisHostState =
  /** The host half is evaluated and its fiber is mounted. */
  | 'running'
  /** The host half could not be read, evaluated, or mounted; `error` says why. */
  | 'failed'
  /** The package configured no host half. */
  | 'none'

/** One configured package as the browser half lists it. */
export interface StaticCordisPackageRow {
  /** Configured package id; also the browser module id suffix. */
  id: string
  /** Configured label; the browser plugin name. */
  name: string
  /** Whether the package configures a browser half to load. */
  hasClientHalf: boolean
  /** Host-half status after boot. */
  hostState: StaticCordisHostState
  /** Host-half failure text when `hostState` is `failed`. */
  error?: string
}

/** The browser half's source for one package, or why it cannot be served. */
export type StaticCordisClientSource =
  | {
    ok: true
    /** Configured package id. */
    id: string
    /** Configured label. */
    name: string
    /** Browser-half source: an async function body returning a plugin. */
    code: string
  }
  | {
    ok: false
    /** Why no source is served: unknown id, no browser half, or a failed host half. */
    message: string
  }

/** Answer of one `host.call` routed to a static package's host half. */
export type StaticCordisInvokeResult =
  | {
    ok: true
    /** The handler's JSON answer. */
    value: JsonValue
  }
  | {
    ok: false
    /** Which routing step refused: no such package, no running host half, no such method, or the handler threw. */
    code: 'package-missing' | 'host-not-running' | 'method-not-found' | 'handler-error'
    /** Failure text. */
    message: string
    /** Handler stack when the thrown value supplied one. */
    stack?: string
  }
