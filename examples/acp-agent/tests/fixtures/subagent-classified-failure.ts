import type { Context } from '@deepseek-ai/cordis'

export const name = 'subagent-classified-failure'
export const inject = ['subagents']

/**
 * Snapshot-only failure injector for pinning `dsh-tool-subagent`'s
 * classified-failure model-visible text (headline, credential-shaped
 * redaction, `authMode`) without spawning a real Codex/Claude Code product
 * process: the real forked child still runs its scripted turn to completion
 * (a real published child session with a real `subagent/start`/`subagent/end`
 * pair), and only the settled {@link SubagentResult} is replaced with a fixed
 * `auth` failure — the same value the real `codex`/`claude-code` providers
 * would classify from an unauthenticated child, per the
 * failure-classification Agent Note.
 */
export function apply(ctx: Context): void {
  const start = ctx.subagents.start.bind(ctx.subagents)
  ctx.subagents.start = (providerName, request) => start(providerName, request).then(run => ({
    ...run,
    result: run.result.then(() => ({
      output: [],
      stopReason: 'error' as const,
      failure: {
        code: 'auth' as const,
        message: 'Not logged in · Please run /login',
      },
      authMode: 'subscription' as const,
    })),
  }))
}
