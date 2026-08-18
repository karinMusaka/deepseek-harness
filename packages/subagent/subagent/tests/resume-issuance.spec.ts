import { describe, expect, it } from 'vitest'
import { CallId, createMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { SUBAGENT_RESUME_META_KEY, verifyResumeIssuance } from '../src/resume-issuance.ts'
import type { SubagentResumeIssuance } from '../src/resume-issuance.ts'

/** A well-formed issuance record, reused as the mutation base for each malformed-shape case. */
const VALID: SubagentResumeIssuance = { id: 'resume-1', provider: 'codex', permissionMode: 'read-only', cwd: '/workspace' }

/** One turn logging a `tool/result` event whose `meta` is exactly `meta` (or omitted when `undefined`). */
function seedToolResult(session: Session, turn: number, meta: JsonValue | undefined): void {
  const callId = CallId(`call-${turn}`)
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: 'subagent', arguments: '{}' }],
      source: { kind: 'model', provider: 'test', model: 'test' },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn, step: 1, callId, name: 'subagent', arguments: '{}' })
  session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'seeded' }], isError: false }),
    ...meta !== undefined ? { meta } : {},
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function sessionWith(...metas: (JsonValue | undefined)[]): Session {
  const session = Session.create(SessionId('resume-issuance-test'))
  metas.forEach((meta, index) => { seedToolResult(session, index + 1, meta) })
  return session
}

/** `VALID` with `key` entirely absent (not present-but-`undefined`, which is not JSON-serializable). */
function withoutField(key: keyof SubagentResumeIssuance): Record<string, JsonValue> {
  const { [key]: _omitted, ...rest } = VALID
  return rest
}

describe('dsh-subagent resume-issuance', () => {
  it('matches an issuance recorded verbatim by a prior tool/result event', () => {
    const session = sessionWith({ [SUBAGENT_RESUME_META_KEY]: { ...VALID } })
    expect(verifyResumeIssuance(session, VALID)).toBe(true)
  })

  it('finds a matching issuance among several logged tool/result events', () => {
    const session = sessionWith(
      { [SUBAGENT_RESUME_META_KEY]: { ...VALID, id: 'resume-0' } },
      { [SUBAGENT_RESUME_META_KEY]: { ...VALID } },
    )
    expect(verifyResumeIssuance(session, VALID)).toBe(true)
  })

  it('rejects an id no tool/result event ever logged', () => {
    const session = sessionWith({ [SUBAGENT_RESUME_META_KEY]: { ...VALID } })
    expect(verifyResumeIssuance(session, { ...VALID, id: 'never-issued' })).toBe(false)
  })

  it('rejects a matching id issued under a different provider (scope mismatch)', () => {
    const session = sessionWith({ [SUBAGENT_RESUME_META_KEY]: { ...VALID } })
    expect(verifyResumeIssuance(session, { ...VALID, provider: 'claude-code' })).toBe(false)
  })

  it('rejects a matching id issued under a different permissionMode (scope mismatch)', () => {
    const session = sessionWith({ [SUBAGENT_RESUME_META_KEY]: { ...VALID } })
    expect(verifyResumeIssuance(session, { ...VALID, permissionMode: 'workspace-write' })).toBe(false)
  })

  it('rejects a matching id issued under a different cwd (scope mismatch)', () => {
    const session = sessionWith({ [SUBAGENT_RESUME_META_KEY]: { ...VALID } })
    expect(verifyResumeIssuance(session, { ...VALID, cwd: '/other-workspace' })).toBe(false)
  })

  it('ignores tool/result events with no meta at all', () => {
    const session = sessionWith(undefined)
    expect(verifyResumeIssuance(session, VALID)).toBe(false)
  })

  it('ignores tool/result events whose meta is not an object (null, array, primitive)', () => {
    const session = sessionWith(null, ['not', 'an', 'object'], 'a string', 42)
    expect(verifyResumeIssuance(session, VALID)).toBe(false)
  })

  it('ignores a meta object with no subagentResume key', () => {
    const session = sessionWith({ someOtherKey: { ...VALID } })
    expect(verifyResumeIssuance(session, VALID)).toBe(false)
  })

  it('ignores a subagentResume value that is not an object (null, array, primitive)', () => {
    const session = sessionWith(
      { [SUBAGENT_RESUME_META_KEY]: null },
      { [SUBAGENT_RESUME_META_KEY]: ['not', 'an', 'object'] },
      { [SUBAGENT_RESUME_META_KEY]: 'a string' },
    )
    expect(verifyResumeIssuance(session, VALID)).toBe(false)
  })

  it('ignores a subagentResume record with a missing, non-string, or empty id', () => {
    const session = sessionWith(
      { [SUBAGENT_RESUME_META_KEY]: withoutField('id') },
      { [SUBAGENT_RESUME_META_KEY]: { ...VALID, id: 42 } },
      { [SUBAGENT_RESUME_META_KEY]: { ...VALID, id: '' } },
    )
    expect(verifyResumeIssuance(session, VALID)).toBe(false)
  })

  it('ignores a subagentResume record with a missing, non-string, or empty provider', () => {
    const session = sessionWith(
      { [SUBAGENT_RESUME_META_KEY]: withoutField('provider') },
      { [SUBAGENT_RESUME_META_KEY]: { ...VALID, provider: 42 } },
      { [SUBAGENT_RESUME_META_KEY]: { ...VALID, provider: '' } },
    )
    expect(verifyResumeIssuance(session, VALID)).toBe(false)
  })

  it('ignores a subagentResume record with a permissionMode outside the closed union', () => {
    const session = sessionWith(
      { [SUBAGENT_RESUME_META_KEY]: withoutField('permissionMode') },
      { [SUBAGENT_RESUME_META_KEY]: { ...VALID, permissionMode: 'full-access' } },
    )
    expect(verifyResumeIssuance(session, VALID)).toBe(false)
  })

  it('ignores a subagentResume record with a missing, non-string, or empty cwd', () => {
    const session = sessionWith(
      { [SUBAGENT_RESUME_META_KEY]: withoutField('cwd') },
      { [SUBAGENT_RESUME_META_KEY]: { ...VALID, cwd: 42 } },
      { [SUBAGENT_RESUME_META_KEY]: { ...VALID, cwd: '' } },
    )
    expect(verifyResumeIssuance(session, VALID)).toBe(false)
  })

  it('skips non-tool/result events even when they happen to carry a subagentResume-shaped meta', () => {
    const session = Session.create(SessionId('resume-issuance-test-2'))
    session.append('turn/start', { turn: 1 })
    expect(verifyResumeIssuance(session, VALID)).toBe(false)
  })

  it('returns false for an empty session log', () => {
    const session = Session.create(SessionId('resume-issuance-test-3'))
    expect(verifyResumeIssuance(session, VALID)).toBe(false)
  })
})
