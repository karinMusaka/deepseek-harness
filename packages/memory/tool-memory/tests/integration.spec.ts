// Full-loop integration across TWO sessions sharing one host-plane
// MemoryService: session A's mocked model calls the REAL memory_remember
// tool, and the assertions observe the same execution paths a live model
// would (tool/call + a non-error tool/result) plus durable persistence.
// Session B then proves cross-session recall is model-visible ⟺ logged: its
// first request carries a system-prompt-sourced `user/message` snapshot that
// surfaces A's stored preference, and the exact text lands in the mock
// adapter's received request.
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import MemoryService from '@deepseek-ai/dsh-memory'
import * as ToolMemory from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Boot the real storage/memory/tool-memory composition plus the concrete
 * agent loop, driven by the given scripted mock model.
 */
async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path: ':memory:' })
  await ctx.plugin(StorageDomain, { backend: 'sqlite', routes: {} })
  await ctx.plugin(MemoryService)
  await ctx.plugin(ToolMemory, { contextLimit: 10, maxRecallLimit: 50 })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function findEvent<T extends SessionEvent['type']>(
  log: readonly SessionEvent[],
  type: T,
  position: 'first' | 'last' = 'first',
): Extract<SessionEvent, { type: T }> {
  const found = position === 'first'
    ? log.find(event => event.type === type)
    : log.findLast(event => event.type === type)
  if (!found) throw new Error(`no ${type} event in the session log`)
  return found as Extract<SessionEvent, { type: T }>
}

/** Join every text block of a content-block array, exactly as the model reads it. */
function textOf(content: readonly ContentBlock[]): string {
  return content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('cross-session memory through the agent loop', () => {
  it('one session remembers a preference through the real tool; a later session recalls it as logged, model-visible context', async () => {
    const adapter = new MockAdapter([
      // Session A: the model calls memory_remember, then answers in text.
      toolCallResponse('call-remember', 'memory_remember', {
        content: 'Prefers pnpm over npm',
        kind: 'preference',
        scope: 'user',
      }, 'Noting that preference.'),
      textResponse('Got it — I will remember that.'),
      // Session B: a single plain reply; what matters is the REQUEST it receives.
      textResponse('Sure, how can I help?'),
    ])
    const ctx = await harness(adapter)

    const agentA = ctx.agentLoop.create(SessionId('mem-it-a'), { provider: 'mock', model: 'mock' })
    agentA.followup(createUserMessage({
      content: [{ type: 'text', text: 'Remember that I prefer pnpm over npm.' }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agentA)

    const logA = agentA.session.events
    expect(findEvent(logA, 'tool/call').data.name).toBe('memory_remember')
    const resultA = findEvent(logA, 'tool/result')
    expect(resultA.data.message.content[0].isError).toBe(false)

    // Durable persistence: the entry survives independent of the session log.
    expect(ctx.memory.list('user').some(entry => entry.content === 'Prefers pnpm over npm')).toBe(true)

    // A second memory entry stored directly (no tool round-trip needed here),
    // whose content carries a literal `{{model}}` group: `interpolate: false`
    // must render it verbatim rather than treating it as a prompt variable.
    await ctx.memory.remember({
      scope: 'user',
      kind: 'note',
      content: 'Uses {{model}} literally in notes',
    })

    const agentB = ctx.agentLoop.create(SessionId('mem-it-b'), { provider: 'mock', model: 'mock' })
    agentB.followup(createUserMessage({
      content: [{ type: 'text', text: 'Hi there' }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agentB)

    const logB = agentB.session.events
    const runtimeContextEvent = logB.find((event): event is Extract<SessionEvent, { type: 'user/message' }> =>
      event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === '@deepseek-ai/dsh-system-prompt')
    expect(runtimeContextEvent).toBeDefined()
    const snapshotText = textOf(runtimeContextEvent!.data.content)
    expect(snapshotText).toContain('Stored memory about the user and this project')
    expect(snapshotText).toContain('Prefers pnpm over npm')
    // Rendered verbatim (no interpolation error), literal braces intact.
    expect(snapshotText).toContain('Uses {{model}} literally in notes')

    // Model-visible ⟺ logged: the exact text the log carries reached the adapter.
    const requestB = adapter.requests.at(-1)!
    const requestText = requestB.messages.flatMap(message => textOf(message.content)).join('\n')
    expect(requestText).toContain('Prefers pnpm over npm')
    expect(requestText).toContain('Uses {{model}} literally in notes')
  }, 30_000)
})
