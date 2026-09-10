/**
 * Static-package browser half, node half. Pure UI plugin: the empty apply
 * exists so the plugin appears in the host cordis.yml / Loader; the browser
 * half ships via exports["./client"], discovered through the package.json
 * dsh.client declaration.
 * @module @deepseek-ai/dsh-cordis-static-packages-client
 */

/** Host plugin body — no host-side behavior for this browser-half plugin. */
export function apply(): void {}
