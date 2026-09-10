/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-cordis-static-packages-client`.
 * @module @deepseek-ai/dsh-cordis-static-packages-client/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-cordis-static-packages-client'

/** Cordis companion plugin name. */
export const name = 'cordis-static-packages-client-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the owned relation (every configured browser half the
 * host lists is loaded exactly once on this page while the plugin is mounted)
 * is browser-only state reachable through the dynamic-package runner's face,
 * which the node-plane companion cannot observe; the package's load/unload
 * coverage asserts it instead.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
