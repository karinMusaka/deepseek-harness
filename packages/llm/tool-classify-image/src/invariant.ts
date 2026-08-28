/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-classify-image`.
 * @module @deepseek-ai/dsh-tool-classify-image/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-classify-image'

/** Cordis companion plugin name. */
export const name = 'tool-classify-image-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package owns one stateless tool whose auxiliary
 * requests are bounded by the tool execution that issues them, so it holds no
 * mutable data and no event sequence beyond the single log-only record the
 * session service already validates.
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
