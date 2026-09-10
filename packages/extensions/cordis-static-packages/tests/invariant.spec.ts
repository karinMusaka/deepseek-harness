import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as StaticCordisPackagesInvariant from '../src/invariant.ts'

describe('cordis-static-packages invariant companion', () => {
  it('registers the package-owned empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(StaticCordisPackagesInvariant)
    await expect(fiber.await()).resolves.toBeDefined()
    await fiber.dispose()
    await expect(ctx.plugin(StaticCordisPackagesInvariant).await()).resolves.toBeDefined()
    await ctx.fiber.dispose()
  })
})
