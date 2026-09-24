/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-memory`.
 * @module @deepseek-ai/dsh-memory/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import { MemoryId } from '@deepseek-ai/dsh-memory'

const PACKAGE_NAME = '@deepseek-ai/dsh-memory'

/** Cordis companion plugin name. */
export const name = 'memory-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Owned relationship: the service's in-memory cache mirrors the memory
 * domain's durable `entries` table. A durable `put` must appear in the cache;
 * a `delete` must be absent from it.
 */
const install: InvariantInstaller = Object.assign(
  (ctx: Context, fail: (message: string) => never) => {
    ctx.on('domain/changed', (change: DomainChanged) => {
      if (change.domain !== 'memory' || change.table !== 'entries') return
      if (change.operation === 'deleted') {
        if (ctx.memory.has(MemoryId(change.key))) {
          fail(
            `memory record '${change.key}' was deleted while the service cache still `
            + 'publishes it — some write path bypassed ctx.memory',
          )
        }
        return
      }
      if (!ctx.memory.has(MemoryId(change.key))) {
        fail(
          `memory record '${change.key}' landed durably but the service cache holds `
          + 'no entry for it — the cache and the domain table have diverged',
        )
      }
    })
  },
  { inject: ['memory'] },
)

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
