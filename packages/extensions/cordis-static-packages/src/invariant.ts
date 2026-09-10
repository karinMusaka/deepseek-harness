/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-cordis-static-packages`.
 * @module @deepseek-ai/dsh-cordis-static-packages/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-cordis-static-packages'

/** Cordis companion plugin name. */
export const name = 'cordis-static-packages-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package table is process memory built once from
 * validated configuration, with no event stream to observe, and its one owned
 * relation (a running entry owns a settled host-half fiber and its handler
 * table) is established inside one awaited boot step, so package tests assert
 * it directly.
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
