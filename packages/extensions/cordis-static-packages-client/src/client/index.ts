/**
 * Browser half of static dual-half packages. At activation it asks the
 * `staticCordisPackages` namespace which packages the host loaded, fetches each
 * browser-half source, and seats it through the dynamic-package runner with
 * `host.call` routed to the static loader's `invoke`. Nothing here asks a
 * person: the host's configuration file already authorized every package.
 * @module @deepseek-ai/dsh-cordis-static-packages-client/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CordisDynamicPluginId, JsonValue } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: resolves `ctx.dynamicCordisRunner` (the runner face) on the client Context.
import type {} from '@deepseek-ai/dsh-cordis-client-runner/client'
import type { StaticCordisInvokeResult } from '@deepseek-ai/dsh-cordis-static-packages/types'

/** Stable Cordis plugin name. */
export const name = 'cordis-static-packages-client'

/**
 * Required services: the dynamic-package runner face that seats browser halves
 * and the `staticCordisPackages` Remote namespace that serves them. Declaring
 * the namespace parks this plugin until the host side exists.
 */
export const inject = ['dynamicCordisRunner', 'remote', 'remote.staticCordisPackages']

const TAG = '[cordis-static-packages-client]'

/** Teaching text for a `host.call` the static loader refused or could not complete. */
function invokeFailure(id: string, method: string, result: Extract<StaticCordisInvokeResult, { ok: false }>): Error {
  const where = `host.call("${method}") on static package ${id}`
  const error = new Error(result.code === 'handler-error'
    ? `${where} failed inside the host handler: ${result.message}`
    : `${where} was refused (${result.code}): ${result.message}`)
  if (result.stack !== undefined) error.stack = `${error.stack ?? error.message}\nHost stack:\n${result.stack}`
  return error
}

/**
 * Client plugin body: load every configured browser half, unload them on disposal.
 * @param ctx - client root context.
 */
export async function apply(ctx: Context): Promise<void> {
  const remote = ctx.remote.staticCordisPackages
  const listed = await remote.list()
  if (!listed.ok) throw new Error(`${TAG} listing static packages failed: ${listed.error.code}: ${listed.error.message}`)
  const loaded: CordisDynamicPluginId[] = []
  ctx.effect(() => () => {
    for (const pluginId of loaded) void ctx.dynamicCordisRunner.unloadStatic(pluginId)
  }, 'cordis-static-packages-client: loaded browser halves')
  for (const row of listed.value) {
    if (!row.hasClientHalf) continue
    if (row.hostState === 'failed') {
      console.error(`${TAG} skipping ${row.id}: its host half failed: ${row.error ?? 'unknown error'}`)
      continue
    }
    const source = await remote.clientSource(row.id)
    if (!source.ok) {
      console.error(`${TAG} fetching ${row.id} source failed: ${source.error.code}: ${source.error.message}`)
      continue
    }
    if (!source.value.ok) {
      console.error(`${TAG} ${row.id} has no servable browser half: ${source.value.message}`)
      continue
    }
    const pluginId = row.id as CordisDynamicPluginId
    const result = await ctx.dynamicCordisRunner.loadStatic({
      pluginId,
      name: row.name,
      code: source.value.code,
      invoke: async (method, args) => {
        const answered = await remote.invoke(row.id, method, args as JsonValue)
        if (!answered.ok) throw new Error(`host.call("${method}") on static package ${row.id} did not complete: ${answered.error.code}: ${answered.error.message}`)
        if (!answered.value.ok) throw invokeFailure(row.id, method, answered.value)
        return answered.value.value
      },
      reportGuardFailure: (failure) => { console.error(`${TAG} ${row.id} guard rejected runtime code:`, failure.message) },
      reportRenderFailure: (failure) => { console.error(`${TAG} ${row.id} crashed while rendering ${failure.slot}:`, failure.message) },
    })
    if (result.ok) loaded.push(pluginId)
    else console.error(`${TAG} loading ${row.id} failed at ${result.cause}: ${result.message}`)
  }
}
