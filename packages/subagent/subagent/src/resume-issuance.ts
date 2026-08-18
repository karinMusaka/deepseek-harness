/**
 * Log-derived authorization for a model-supplied {@link SubagentStartRequest.resumeId}.
 * A harness session survives process restarts, so the authoritative check is
 * the session's own durable event log, never an in-process-only registry (see
 * the [Agent
 * Note](../../../../.agents/notes/implemented/feature/2026-08-18-subagent-delegation-resume.md)).
 *
 * @module @deepseek-ai/dsh-subagent/resume-issuance
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { SubagentPermissionMode } from './types.ts'

/**
 * One past delegation's resume-thread issuance, scope-bound to the exact
 * `(provider, permissionMode, cwd)` under which it was created. A consumer
 * that later populates {@link SubagentResult.resumeId} logs this record
 * verbatim as its `tool/result` event's `meta[SUBAGENT_RESUME_META_KEY]`
 * (`dsh-tool-subagent` is the one shipped consumer that does this).
 */
export interface SubagentResumeIssuance {
  /** The provider-reported resume id ({@link SubagentResult.resumeId}). */
  readonly id: string
  /** The `ctx.subagents` provider name this id was issued under. */
  readonly provider: string
  /**
   * The EFFECTIVE permission scope this id was issued under (already
   * resolved past the provider's own `undefined` → `'read-only'` default —
   * see {@link SubagentStartRequest.permissionMode}'s JSDoc). Comparing
   * effective-to-effective, never raw-config-to-raw-config, is what closes
   * the gap PR1's permission-scope work left open for two tool rows that
   * target the same provider with one omitting the field and the other
   * spelling out its provider default explicitly.
   */
  readonly permissionMode: SubagentPermissionMode
  /** The child's resolved working directory at issuance. */
  readonly cwd: string
}

/**
 * The `tool/result.meta` object key a consumer logs {@link SubagentResumeIssuance}
 * under. Exported so a consumer (`dsh-tool-subagent`) and this verifier agree
 * on one wire shape without either depending on the other's package.
 */
export const SUBAGENT_RESUME_META_KEY = 'subagentResume'

/** Narrow an arbitrary `tool/result.meta` value to a well-formed {@link SubagentResumeIssuance}, or `undefined`. */
function readIssuance(meta: unknown): SubagentResumeIssuance | undefined {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  const candidate = (meta as Record<string, unknown>)[SUBAGENT_RESUME_META_KEY]
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
  const record = candidate as Record<string, unknown>
  const { id, provider, permissionMode, cwd } = record
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (permissionMode !== 'read-only' && permissionMode !== 'workspace-write') return undefined
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined
  return { id, provider, permissionMode, cwd }
}

/**
 * Authoritative, log-derived check for a model-supplied resume id:
 * whether `session`'s own event log recorded a `tool/result` event whose
 * `meta` carries a {@link SubagentResumeIssuance} matching every field of
 * `candidate` exactly. Never trusts an in-process cache alone — a harness
 * session survives process restarts, and this scan is what makes a resumed
 * delegation work again after one with no separate re-registration step.
 *
 * Scope-bound: `candidate.provider`/`candidate.permissionMode`/`candidate.cwd`
 * must ALL match the issuing call's own recorded values, not just `id`. This
 * is what stops a model that started a thread through one tool row (say, a
 * `read-only` `codex` instance) from resuming that same id through a
 * different tool row aimed at the same provider with a wider scope (say,
 * `workspace-write`) — see the [Agent
 * Note](../../../../.agents/notes/implemented/feature/2026-08-18-subagent-delegation-resume.md).
 * @param session - the delegating agent's own session (the resume scope: only
 *   ITS log is searched, so a resume attempt from a different session's
 *   Agent — including a sibling subagent's own session — never matches an
 *   issuance this session did not itself log).
 * @param candidate - the id and the resolved scope this call is attempting
 *   to resume under.
 * @returns whether `session.events` contains a matching issuance.
 */
export function verifyResumeIssuance(session: Session, candidate: SubagentResumeIssuance): boolean {
  for (const event of session.events) {
    if (event.type !== 'tool/result') continue
    const issuance = readIssuance(event.data.meta)
    if (issuance === undefined) continue
    if (
      issuance.id === candidate.id
      && issuance.provider === candidate.provider
      && issuance.permissionMode === candidate.permissionMode
      && issuance.cwd === candidate.cwd
    ) {
      return true
    }
  }
  return false
}
