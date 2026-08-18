/**
 * Fixed Codex one-shot subagent provider. Every accepted run starts a fresh
 * official `codex app-server --stdio` process in the delegating Session's
 * workspace and publishes only after an ephemeral thread exists.
 *
 * @module @deepseek-ai/dsh-subagent-codex
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  assertPositiveFinite,
  NO_START_CAPABILITIES,
  resolveChildCwd,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
  type SubagentResult,
} from '@deepseek-ai/dsh-subagent'
import { SENSITIVE_ENV_PATTERN } from '@deepseek-ai/dsh-subprocess'
import {
  DEFAULT_DISPOSE_GRACE_MS,
  startCodexRun,
  type CodexRunSpec,
} from './run.ts'

/**
 * Derive `authMode` purely from the deployment's own `Config.env`: the only
 * path an API key reaches this child is an explicit credential-shaped entry
 * here (`scrubbedParentEnv` removes every credential-shaped name from the
 * inherited parent environment before this layers over it). Never probes
 * `~/.codex`.
 * @param env - the resolved `Config.env`.
 * @returns `'api-key'` when `env` sets a credential-shaped variable name, else `'subscription'`.
 */
function resolveAuthMode(env: Record<string, string>): NonNullable<SubagentResult['authMode']> {
  return Object.keys(env).some(key => SENSITIVE_ENV_PATTERN.test(key)) ? 'api-key' : 'subscription'
}

export const name = 'subagent-codex'
export const inject = ['subagents', 'subprocess']

/** Deployment-owned environment and process-release bound. */
export interface Config {
  /**
   * Explicit environment entries layered over the subprocess seam's
   * credential-scrubbed parent environment.
   */
  env?: Record<string, string>
  /** Grace in milliseconds for app-server process-tree termination. */
  disposeGraceMs?: number
}

export const Config: z<Config> = z.object({
  env: z.dict(z.string()).default({}),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
})

type ResolvedConfig = Required<Config>

class CodexProvider implements SubagentProvider {
  readonly name = 'codex'
  // Every other start-time capability stays NO_START_CAPABILITIES's `false`: an
  // out-of-process app-server child cannot honor `outputSchema`/`maxDepth`/
  // `toolFilter`/`persona`. `permissionMode` and `resume` are the two
  // exceptions — the official app-server's own `sandbox`/`approvalPolicy`
  // enforce the former natively, and its own `thread/start { ephemeral:
  // false }`/`thread/resume` enforce the latter (opt-in only — see the
  // [Agent Note](../../../../.agents/notes/implemented/feature/2026-08-18-subagent-delegation-resume.md)).
  readonly capabilities: SubagentCapabilities = { ...NO_START_CAPABILITIES, permissionMode: true, resume: true }
  readonly inheritsParentContext = false

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  start(request: ResolvedSubagentStartRequest) {
    const parentCwd = request.parent.session.header.cwd
    if (parentCwd === undefined) {
      throw new Error(
        'subagent-codex: no working directory for the child — delegate from a parent session that has one',
      )
    }
    const spec: CodexRunSpec = {
      cwd: resolveChildCwd(
        'subagent-codex',
        undefined,
        parentCwd,
      ),
      // Absent means the provider's own default (`SubagentStartRequest.permissionMode` JSDoc):
      // fixed here as `read-only`, never left to the app-server's own config.toml.
      permissionMode: request.permissionMode ?? 'read-only',
      requestResume: request.requestResume === true,
      ...request.resumeId !== undefined ? { resumeId: request.resumeId } : {},
      env: this.config.env,
      authMode: resolveAuthMode(this.config.env),
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-codex: child run failed (${stopReason}): ${error.message}`,
        )
      },
    }
    return startCodexRun(request, spec)
  }
}

/**
 * Register the fixed `codex` provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - explicit child environment and disposal grace.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveFinite(
    'subagent-codex',
    'disposeGraceMs',
    resolved.disposeGraceMs,
  )
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `subagent-codex: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  ctx.subagents.registerProvider(new CodexProvider(ctx, resolved))
}
