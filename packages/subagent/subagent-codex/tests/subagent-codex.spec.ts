import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {
  SubprocessHandle,
  SubprocessOutcome,
} from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as codex from '../src/index.ts'
import * as invariant from '../src/invariant.ts'
import {
  codexAppServerArgv,
  DEFAULT_DISPOSE_GRACE_MS,
  disposeCodexChild,
  startCodexRun,
  textTask,
  type CodexRunSpec,
} from '../src/run.ts'
import { CodexAppServerWire } from '../src/wire.ts'

type JsonObject = Record<string, unknown>

const fakeParent = {
  id: 'parent',
  session: { header: { cwd: process.cwd() } },
} as unknown as Agent

function request(
  prompt: ContentBlock[] = [{ type: 'text', text: 'do the task' }],
  signal = new AbortController().signal,
) {
  return { prompt, parent: fakeParent, signal }
}

async function nextTask(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve) })
}

class ProtocolPeer {
  private buffer = ''
  private readonly frames: JsonObject[] = []
  private readonly wakeups = new Set<() => void>()

  constructor(
    input: PassThrough,
    private readonly output: PassThrough,
  ) {
    input.on('data', (chunk: Buffer | string) => {
      this.buffer += chunk.toString()
      for (;;) {
        const newline = this.buffer.indexOf('\n')
        if (newline < 0) break
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        if (line.trim().length > 0) this.frames.push(JSON.parse(line) as JsonObject)
      }
      for (const wake of this.wakeups) wake()
      this.wakeups.clear()
    })
  }

  async next(predicate: (frame: JsonObject) => boolean): Promise<JsonObject> {
    for (;;) {
      const index = this.frames.findIndex(predicate)
      if (index >= 0) return this.frames.splice(index, 1)[0]!
      await new Promise<void>((resolve) => { this.wakeups.add(resolve) })
    }
  }

  nextMethod(method: string): Promise<JsonObject> {
    return this.next(frame => frame.method === method)
  }

  nextResponse(id: unknown): Promise<JsonObject> {
    return this.next(frame => frame.id === id && frame.method === undefined)
  }

  send(...frames: readonly JsonObject[]): void {
    this.output.write(`${frames.map(frame => JSON.stringify(frame)).join('\n')}\n`)
  }

  respond(requestFrame: JsonObject, result: unknown): void {
    this.send({ id: requestFrame.id, result })
  }

  respondError(requestFrame: JsonObject, code: number, message: string): void {
    this.send({ id: requestFrame.id, error: { code, message } })
  }
}

interface FakeChildOptions {
  readonly pid?: number
  readonly exitOnTerminate?: boolean
  readonly doneError?: Error
}

interface FakeChild {
  readonly handle: SubprocessHandle
  readonly peer: ProtocolPeer
  readonly fromChild: PassThrough
  readonly toChild: PassThrough
  readonly settle: (outcome?: SubprocessOutcome) => void
  readonly fail: (error: Error) => void
  readonly terminate: () => void
  readonly waitForExit: (signal?: AbortSignal) => Promise<boolean>
}

function fakeChild(options: FakeChildOptions = {}): FakeChild {
  const fromChild = new PassThrough()
  const toChild = new PassThrough()
  const peer = new ProtocolPeer(toChild, fromChild)
  let exited = false
  let resolveDone!: (outcome: SubprocessOutcome) => void
  let rejectDone!: (error: Error) => void
  const done = new Promise<SubprocessOutcome>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  const settle = (
    outcome: SubprocessOutcome = { exitCode: 0, signal: null },
  ): void => {
    if (exited) return
    exited = true
    resolveDone(outcome)
  }
  const fail = (error: Error): void => {
    if (exited) return
    exited = true
    rejectDone(error)
  }
  if (options.doneError !== undefined) fail(options.doneError)
  const terminate = vi.fn(() => {
    if (options.exitOnTerminate !== false) settle()
  })
  const waitForExit = vi.fn(async (signal?: AbortSignal) => {
    if (exited) return true
    if (signal === undefined) {
      await done.catch(() => {})
      return true
    }
    return await new Promise<boolean>((resolve) => {
      const onAbort = (): void => { resolve(false) }
      signal.addEventListener('abort', onAbort, { once: true })
      void done.then(
        () => {
          signal.removeEventListener('abort', onAbort)
          resolve(true)
        },
        () => {
          signal.removeEventListener('abort', onAbort)
          resolve(true)
        },
      )
    })
  })
  const handle: SubprocessHandle = {
    pid: options.pid ?? 1234,
    stdin: toChild,
    stdout: fromChild,
    stderr: undefined,
    collected: {},
    done,
    terminate,
    waitForExit,
  }
  return {
    handle,
    peer,
    fromChild,
    toChild,
    settle,
    fail,
    terminate,
    waitForExit,
  }
}

function runSpec(
  child: FakeChild,
  overrides: Partial<CodexRunSpec> = {},
): CodexRunSpec {
  return {
    cwd: process.cwd(),
    permissionMode: 'read-only',
    requestResume: false,
    env: {},
    disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS,
    spawn: () => child.handle,
    ...overrides,
  }
}

async function initializeWire(): Promise<{
  readonly child: FakeChild
  readonly wire: CodexAppServerWire
}> {
  const child = fakeChild()
  const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
  wire.start()
  const initializing = wire.initialize(new AbortController().signal)
  const initialize = await child.peer.nextMethod('initialize')
  child.peer.respond(initialize, { userAgent: 'codex-cli 0.147.0' })
  await initializing
  expect(await child.peer.nextMethod('initialized')).toEqual({
    jsonrpc: '2.0',
    method: 'initialized',
  })
  const starting = wire.startThread(process.cwd(), 'read-only', new AbortController().signal)
  const threadStart = await child.peer.nextMethod('thread/start')
  child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: true } })
  await starting
  return { child, wire }
}

async function publishRun(
  child = fakeChild(),
  signal = new AbortController().signal,
  specOverrides: Partial<CodexRunSpec> = {},
) {
  const starting = startCodexRun(request(undefined, signal), runSpec(child, specOverrides))
  const initialize = await child.peer.nextMethod('initialize')
  child.peer.respond(initialize, { userAgent: 'codex-cli 0.147.0' })
  await child.peer.nextMethod('initialized')
  const threadStart = await child.peer.nextMethod('thread/start')
  child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: true } })
  const run = await starting
  const turnStart = await child.peer.nextMethod('turn/start')
  return { child, run, turnStart }
}

function agentMessage(
  text: unknown,
  phase: unknown,
  turnId = 'turn-1',
  threadId = 'thread-1',
): JsonObject {
  return {
    method: 'item/completed',
    params: {
      threadId,
      turnId,
      item: { type: 'agentMessage', text, phase },
    },
  }
}

function turnCompleted(
  status: unknown,
  turnId = 'turn-1',
  threadId = 'thread-1',
  error: unknown = null,
): JsonObject {
  return {
    method: 'turn/completed',
    params: {
      threadId,
      turn: { id: turnId, status, error },
    },
  }
}

/** One `item/completed` `fileChange` notification, matching the real app-server's measured shape. */
function fileChangeItem(
  status: unknown,
  changes: unknown = [{ path: '/workspace/made.txt', kind: { type: 'add' }, diff: 'WROTE\n' }],
  turnId = 'turn-1',
  threadId = 'thread-1',
): JsonObject {
  return {
    method: 'item/completed',
    params: {
      threadId,
      turnId,
      item: { type: 'fileChange', id: 'exec-fixture', changes, status },
    },
  }
}

/**
 * One `thread/tokenUsage/updated` notification, matching the real app-server's
 * measured shape. `last` is this individual model call's own declared usage
 * (what production code reads); `total` defaults to the same value for tests
 * that do not care about the distinction, but a caller proving production
 * code does NOT read `total` passes a deliberately different (inflated)
 * value — measured real behavior: `total` is the THREAD's cumulative
 * lifetime total, not reset per turn, so it is NOT usable as "this call's
 * usage" on a resumed thread (see the Agent Note).
 */
function tokenUsageUpdated(
  last: { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number },
  turnId = 'turn-1',
  threadId = 'thread-1',
  total: { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number } = last,
): JsonObject {
  return {
    method: 'thread/tokenUsage/updated',
    params: {
      threadId,
      turnId,
      tokenUsage: { total, last, modelContextWindow: 258400 },
    },
  }
}

/** One intermediate `error` notification, matching the app-server's own shape. */
function errorNotification(
  error: { message: string; codexErrorInfo: unknown; additionalDetails?: unknown },
  willRetry: boolean,
  turnId = 'turn-1',
  threadId = 'thread-1',
): JsonObject {
  return {
    method: 'error',
    params: { error, willRetry, threadId, turnId },
  }
}

describe('task admission and package contracts', () => {
  it('resolves the fixed app-server command through the Windows npm shim boundary', () => {
    expect(codexAppServerArgv('win32')).toEqual([
      'cmd.exe',
      '/d',
      '/s',
      '/c',
      'codex',
      'app-server',
      '--stdio',
    ])
    expect(codexAppServerArgv('linux')).toEqual(['codex', 'app-server', '--stdio'])
  })

  it('accepts one or more text blocks and rejects empty or non-text tasks', () => {
    expect(textTask([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ])).toEqual(['one', 'two'])
    expect(() => textTask([])).toThrow('only text blocks')
    expect(() => textTask([{ type: 'reasoning', text: 'hidden' }]))
      .toThrow('only text blocks')
    expect(() => textTask([{ type: 'text', text: ' \n ' }]))
      .toThrow('must not be empty')
  })

  it('registers one fixed descriptor, validates config, and unregisters on HMR', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const fiber = await ctx.plugin(codex, {})
    const provider = ctx.subagents.getProvider('codex')!
    expect(provider).toMatchObject({
      name: 'codex',
      capabilities: {
        outputSchema: false,
        depthLimit: false,
        toolFilter: false,
        persona: false,
        permissionMode: true,
      },
      inheritsParentContext: false,
    })
    expect(ctx.subagents.list()).toEqual(['codex'])
    await fiber.dispose()
    expect(ctx.subagents.list()).toEqual([])

    for (const disposeGraceMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(ctx.plugin(codex, { disposeGraceMs }))
        .rejects.toThrow('disposeGraceMs must be a positive finite number')
    }
    await expect(ctx.plugin(codex, { disposeGraceMs: MAX_TIMER_DELAY_MS + 1 }))
      .rejects.toThrow(`disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
    await ctx.fiber.dispose()
  })

  it('requires a parent session cwd without suggesting unsupported config', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    await ctx.plugin(codex, {})

    await expect(ctx.subagents.start('codex', {
      prompt: [{ type: 'text', text: 'task' }],
      parent: {
        id: 'parent-without-cwd',
        session: { header: {} },
      } as unknown as Agent,
      signal: new AbortController().signal,
    })).rejects.toThrow(
      'subagent-codex: no working directory for the child — delegate from a parent session that has one',
    )
    expect(spawn).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('keeps the namespace export shape and package-owned empty invariant', async () => {
    expect('default' in codex).toBe(false)
    expect(codex.name).toBe('subagent-codex')
    expect(codex.inject).toEqual(['subagents', 'subprocess'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(codex)).toBe(codex)

    const dispose = vi.fn()
    const register = vi.fn((
      _packageName: string,
      _installer: InvariantInstaller,
    ) => dispose)
    const ctx = { invariants: { register } } as unknown as Context
    await expect(invariant.apply(ctx)).resolves.toBe(dispose)
    expect(register).toHaveBeenCalledWith(
      '@deepseek-ai/dsh-subagent-codex',
      expect.any(Function),
    )
    const install = register.mock.calls[0]![1]
    await install(new Context(), (message) => { throw new Error(message) })
    expect(invariant.name).toBe('subagent-codex-invariant')
    expect(invariant.inject).toEqual(['invariants'])
  })
})

describe('CodexAppServerWire', () => {
  it('sends the fixed handshake, thread, and turn payloads and keeps final_answer', async () => {
    const child = fakeChild()
    const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
    expect(wire.collectOutput()).toEqual([])
    wire.start()

    const initializing = wire.initialize(new AbortController().signal)
    const initialize = await child.peer.nextMethod('initialize')
    expect(initialize.params).toEqual({
      clientInfo: {
        name: 'deepseek-harness',
        title: 'DeepSeek Harness',
        version: '0.0.1',
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    })
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.147.0' })
    await initializing
    await child.peer.nextMethod('initialized')

    const starting = wire.startThread('/workspace', 'workspace-write', new AbortController().signal)
    const threadStart = await child.peer.nextMethod('thread/start')
    expect(threadStart.params).toEqual({
      cwd: '/workspace',
      ephemeral: true,
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
    })
    child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: true } })
    await starting

    const result = wire.runTurn(
      ['first', 'second'],
      new AbortController().signal,
    )
    const turnStart = await child.peer.nextMethod('turn/start')
    expect(turnStart.params).toEqual({
      threadId: 'thread-1',
      input: [
        { type: 'text', text: 'first', text_elements: [] },
        { type: 'text', text: 'second', text_elements: [] },
      ],
    })
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    child.peer.send(
      {
        method: 'turn/started',
        params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
      },
      agentMessage('other thread', 'final_answer', 'turn-1', 'thread-2'),
      agentMessage('other turn', 'final_answer', 'turn-2'),
      {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { type: 'reasoning', text: 'not output' },
        },
      },
      agentMessage('commentary', 'commentary'),
      agentMessage('unphased', null),
      agentMessage('first final', 'final_answer'),
      agentMessage('last final', 'final_answer'),
      turnCompleted('completed'),
    )
    await expect(result).resolves.toEqual({
      output: [{ type: 'text', text: 'last final' }],
      stopReason: 'completed',
    })
    expect(wire.collectOutput()).toEqual([{ type: 'text', text: 'last final' }])
    wire.close()
    wire.close()
  })

  it('uses the last nullable-phase answer when no explicit final exists', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send(
      agentMessage('first', null),
      agentMessage('fallback', null),
      turnCompleted('completed'),
    )
    await expect(result).resolves.toEqual({
      output: [{ type: 'text', text: 'fallback' }],
      stopReason: 'completed',
    })
    wire.close()
  })

  it('maps only an explicit context-window failure to max-tokens', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send(
      agentMessage('partial answer', null),
      turnCompleted('failed', 'turn-1', 'thread-1', {
        message: 'too much context',
        codexErrorInfo: 'contextWindowExceeded',
      }),
    )
    await expect(result).resolves.toEqual({
      output: [{ type: 'text', text: 'partial answer' }],
      stopReason: 'max-tokens',
    })
    wire.close()
  })

  it('retains the most specific error-notification cause over the terminal turn\'s degraded "other" (measured 401 sequence)', async () => {
    // Verbatim shape captured against a real unauthenticated app-server
    // 0.147.0 (see the failure-classification Agent Note): five retryable
    // `error` notifications carrying `responseStreamDisconnected` with
    // `httpStatusCode: 401`, then a non-retryable `error` notification AND
    // the terminal `turn/completed` both degraded to the literal `"other"`.
    // A naive terminal-only read would classify this as `provider`.
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    const retryable = (attempt: number) => errorNotification({
      message: `Reconnecting... ${attempt}/5`,
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } },
      additionalDetails: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, cf-ray: fake-cf-ray, request id: req_fixture',
    }, true)
    child.peer.send(
      retryable(1), retryable(2), retryable(3), retryable(4), retryable(5),
      errorNotification({
        message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, request id: req_fixture',
        codexErrorInfo: 'other',
      }, false),
      turnCompleted('failed', 'turn-1', 'thread-1', {
        message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, request id: req_fixture',
        codexErrorInfo: 'other',
      }),
    )
    const rejection = await result.then(
      () => { throw new Error('expected runTurn to reject') },
      (error: unknown) => error,
    ) as { failure?: { code: string; message: string } }
    expect(rejection.failure?.code).toBe('auth')
    expect(rejection.failure?.message).toContain('401 Unauthorized')
    wire.close()
  })

  it('classifies quota from the enumerated causes without hitting a live rate limit', async () => {
    for (const [codexErrorInfo, label] of [
      ['usageLimitExceeded', 'usageLimitExceeded'],
      ['serverOverloaded', 'serverOverloaded'],
    ] as const) {
      const { child, wire } = await initializeWire()
      const result = wire.runTurn(['task'], new AbortController().signal)
      const turnStart = await child.peer.nextMethod('turn/start')
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      child.peer.send(turnCompleted('failed', 'turn-1', 'thread-1', {
        message: `native ${label} failure`,
        codexErrorInfo,
      }))
      await expect(result).rejects.toMatchObject({ failure: { code: 'quota' } })
      wire.close()
    }

    // The object-variant `httpStatusCode: 429` classifies as `quota` even
    // when the enum label itself does not name a quota cause.
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send(
      errorNotification({
        message: 'Reconnecting... 1/5',
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 429 } },
      }, true),
      turnCompleted('failed', 'turn-1', 'thread-1', {
        message: 'unexpected status 429 Too Many Requests',
        codexErrorInfo: 'other',
      }),
    )
    await expect(result).rejects.toMatchObject({ failure: { code: 'quota' } })
    wire.close()
  })

  it('classifies an unrecognized native cause as provider, never crashing on codexErrorInfo\'s open vocabulary', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send(turnCompleted('failed', 'turn-1', 'thread-1', {
      message: 'the model backend returned a 500',
      codexErrorInfo: 'internalServerError',
    }))
    await expect(result).rejects.toMatchObject({ failure: { code: 'provider' } })
    wire.close()
  })

  it('classifies from the terminal turn\'s own info when no error notification ever fired', async () => {
    // A bare `codexErrorInfo: 'unauthorized'` string (not the object variant,
    // and not degraded to `"other"`) directly on the terminal turn, with no
    // preceding `error` notification at all.
    {
      const { child, wire } = await initializeWire()
      const result = wire.runTurn(['task'], new AbortController().signal)
      const turnStart = await child.peer.nextMethod('turn/start')
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      child.peer.send(turnCompleted('failed', 'turn-1', 'thread-1', {
        message: 'no credentials',
        codexErrorInfo: 'unauthorized',
      }))
      const rejection = await result.then(
        () => { throw new Error('expected runTurn to reject') },
        (error: unknown) => error,
      ) as { failure?: { code: string } }
      expect(rejection.failure?.code).toBe('auth')
      wire.close()
    }

    // An object-shaped `codexErrorInfo` matching none of the known
    // HTTP-status variant keys: falls through to `'other'`/`provider`, and a
    // missing `error` object entirely falls back to the generic message.
    {
      const { child, wire } = await initializeWire()
      const result = wire.runTurn(['task'], new AbortController().signal)
      const turnStart = await child.peer.nextMethod('turn/start')
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      child.peer.send(turnCompleted('failed', 'turn-1', 'thread-1', {
        message: 'unrecognized shape',
        codexErrorInfo: { someFutureVariant: {} },
      }))
      const rejection = await result.then(
        () => { throw new Error('expected runTurn to reject') },
        (error: unknown) => error,
      ) as { failure?: { code: string } }
      expect(rejection.failure?.code).toBe('provider')
      wire.close()
    }

    // `terminal.error` itself absent: the fallback message names the status.
    {
      const { child, wire } = await initializeWire()
      const result = wire.runTurn(['task'], new AbortController().signal)
      const turnStart = await child.peer.nextMethod('turn/start')
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      child.peer.send(turnCompleted('failed', 'turn-1', 'thread-1', null))
      await expect(result).rejects.toThrow('Codex turn ended with status "failed"')
      wire.close()
    }

    // An object-variant key matches, but its own value carries no valid
    // numeric `httpStatusCode` — still falls through to `provider`.
    {
      const { child, wire } = await initializeWire()
      const result = wire.runTurn(['task'], new AbortController().signal)
      const turnStart = await child.peer.nextMethod('turn/start')
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      child.peer.send(turnCompleted('failed', 'turn-1', 'thread-1', {
        message: 'connection failed, no status yet',
        codexErrorInfo: { responseStreamDisconnected: {} },
      }))
      const rejection = await result.then(
        () => { throw new Error('expected runTurn to reject') },
        (error: unknown) => error,
      ) as { failure?: { code: string } }
      expect(rejection.failure?.code).toBe('provider')
      wire.close()
    }
  })

  it('scopes the error notification to this thread/turn and tolerates a thread-level (turnId: null) notification', async () => {
    // A foreign threadId is ignored outright.
    {
      const { child, wire } = await initializeWire()
      const result = wire.runTurn(['task'], new AbortController().signal)
      const turnStart = await child.peer.nextMethod('turn/start')
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      child.peer.send(errorNotification({
        message: 'not for this thread',
        codexErrorInfo: 'unauthorized',
      }, true, 'turn-1', 'some-other-thread'))
      child.peer.send(turnCompleted('failed', 'turn-1', 'thread-1', {
        message: 'native failure',
        codexErrorInfo: 'internalServerError',
      }))
      const rejection = await result.then(
        () => { throw new Error('expected runTurn to reject') },
        (error: unknown) => error,
      ) as { failure?: { code: string } }
      // The foreign-thread notification never retained; classification comes
      // only from the terminal turn's own (unrelated) cause.
      expect(rejection.failure?.code).toBe('provider')
      wire.close()
    }

    // A mismatched turnId is ignored. Waits a tick after `turn/start`'s
    // response so the turn id is already committed — sending it immediately
    // would instead race the early-queue path, which treats any early
    // notification as a claim about the SAME upcoming turn and throws on a
    // genuine conflict (a different, correctly-covered behavior).
    {
      const { child, wire } = await initializeWire()
      const result = wire.runTurn(['task'], new AbortController().signal)
      const turnStart = await child.peer.nextMethod('turn/start')
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      await nextTask()
      child.peer.send(errorNotification({
        message: 'not for this turn',
        codexErrorInfo: 'unauthorized',
      }, true, 'some-other-turn', 'thread-1'))
      child.peer.send(turnCompleted('failed', 'turn-1', 'thread-1', {
        message: 'native failure',
        codexErrorInfo: 'internalServerError',
      }))
      const rejection = await result.then(
        () => { throw new Error('expected runTurn to reject') },
        (error: unknown) => error,
      ) as { failure?: { code: string } }
      expect(rejection.failure?.code).toBe('provider')
      wire.close()
    }

    // A thread-level notification (`turnId: null`) is not turn-scoped and is
    // still retained.
    {
      const { child, wire } = await initializeWire()
      const result = wire.runTurn(['task'], new AbortController().signal)
      const turnStart = await child.peer.nextMethod('turn/start')
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      child.peer.send({
        method: 'error',
        params: {
          error: { message: 'thread-level failure', codexErrorInfo: 'unauthorized' },
          willRetry: false,
          threadId: 'thread-1',
          turnId: null,
        },
      })
      child.peer.send(turnCompleted('failed', 'turn-1', 'thread-1', {
        message: 'degraded to other',
        codexErrorInfo: 'other',
      }))
      const rejection = await result.then(
        () => { throw new Error('expected runTurn to reject') },
        (error: unknown) => error,
      ) as { failure?: { code: string } }
      expect(rejection.failure?.code).toBe('auth')
      wire.close()
    }

    // An `error` notification that arrives before `turn/start`'s own response
    // has committed a turn id (`this.turnCompleted` still undefined) is
    // silently dropped rather than queued or retained.
    {
      const { child, wire } = await initializeWire()
      child.peer.send(errorNotification({
        message: 'too early',
        codexErrorInfo: 'unauthorized',
      }, true, 'turn-1', 'thread-1'))
      const result = wire.runTurn(['task'], new AbortController().signal)
      const turnStart = await child.peer.nextMethod('turn/start')
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      child.peer.send(turnCompleted('failed', 'turn-1', 'thread-1', {
        message: 'native failure',
        codexErrorInfo: 'internalServerError',
      }))
      const rejection = await result.then(
        () => { throw new Error('expected runTurn to reject') },
        (error: unknown) => error,
      ) as { failure?: { code: string } }
      expect(rejection.failure?.code).toBe('provider')
      wire.close()
    }
  })

  it('classifies a JSON-RPC-level deviation as protocol', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    // `turn` is not an object: the same `object()` validator every other
    // shape check uses.
    child.peer.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: 'not-an-object' } })
    await expect(result).rejects.toMatchObject({ failure: { code: 'protocol' } })
    wire.close()
  })

  it('rejects invalid handshake, thread, and turn response shapes', async () => {
    {
      const child = fakeChild()
      const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
      wire.start()
      const pending = wire.initialize(new AbortController().signal)
      const frame = await child.peer.nextMethod('initialize')
      child.peer.respond(frame, null)
      await expect(pending).rejects.toThrow('invalid initialize response')
      wire.close()
    }
    {
      const child = fakeChild()
      const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
      wire.start()
      const pending = wire.startThread('/workspace', 'read-only', new AbortController().signal)
      const frame = await child.peer.nextMethod('thread/start')
      child.peer.respond(frame, { thread: { id: 'thread-1', ephemeral: false } })
      await expect(pending).rejects.toThrow('created a thread with ephemeral=false, expected true')
      wire.close()
    }
    {
      const { child, wire } = await initializeWire()
      const pending = wire.runTurn(['task'], new AbortController().signal)
      const frame = await child.peer.nextMethod('turn/start')
      child.peer.respond(frame, { turn: { id: '' } })
      await expect(pending).rejects.toThrow('turn/start turn id')
      wire.close()
    }
  })

  it('creates a persistent (non-ephemeral) thread and reports its own id as resumeId', async () => {
    const child = fakeChild()
    const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
    wire.start()
    const initializing = wire.initialize(new AbortController().signal)
    child.peer.respond(await child.peer.nextMethod('initialize'), { userAgent: 'codex-cli 0.147.0' })
    await initializing
    const starting = wire.startThread('/workspace', 'read-only', new AbortController().signal, true)
    const threadStart = await child.peer.nextMethod('thread/start')
    expect(threadStart.params).toMatchObject({ ephemeral: false })
    child.peer.respond(threadStart, { thread: { id: 'persistent-thread-1', ephemeral: false } })
    await starting
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send(
      agentMessage('answer', 'final_answer', 'turn-1', 'persistent-thread-1'),
      turnCompleted('completed', 'turn-1', 'persistent-thread-1'),
    )
    await expect(result).resolves.toMatchObject({ resumeId: 'persistent-thread-1' })
    wire.close()
  })

  it('resumes a thread with camelCase threadId and re-pins sandbox/approvalPolicy, never trusting the persisted policy', async () => {
    const child = fakeChild()
    const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
    wire.start()
    const resuming = wire.resumeThread('resumed-thread-1', 'workspace-write', new AbortController().signal)
    const resumeRequest = await child.peer.nextMethod('thread/resume')
    // Measured: the wire param is camelCase `threadId` (the Rust source
    // field `thread_id` fails with `-32600 "missing field threadId"`).
    expect(resumeRequest.params).toEqual({
      threadId: 'resumed-thread-1',
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
    })
    child.peer.respond(resumeRequest, { thread: { id: 'resumed-thread-1', ephemeral: false } })
    await resuming
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-2' } })
    child.peer.send(
      agentMessage('answer', 'final_answer', 'turn-2', 'resumed-thread-1'),
      turnCompleted('completed', 'turn-2', 'resumed-thread-1'),
    )
    await expect(result).resolves.toMatchObject({ resumeId: 'resumed-thread-1' })
    wire.close()
  })

  it('classifies a rejected thread/resume (invalid/unknown id) as a provider failure, never an unclassified crash', async () => {
    const child = fakeChild()
    const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
    wire.start()
    const resuming = wire.resumeThread('unknown-thread-id', 'read-only', new AbortController().signal)
    const resumeRequest = await child.peer.nextMethod('thread/resume')
    // Measured real app-server response for an id its own store does not recognize.
    child.peer.respondError(resumeRequest, -32600, 'no rollout found for thread id unknown-thread-id')
    await expect(resuming).rejects.toMatchObject({
      name: 'ClassifiedSubagentFailure',
      failure: { code: 'provider' },
    })
    wire.close()
  })

  it('rethrows a non-JsonRpcResponseError classified failure from a malformed thread/resume response unchanged', async () => {
    const child = fakeChild()
    const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
    wire.start()
    const resuming = wire.resumeThread('thread-a', 'read-only', new AbortController().signal)
    const resumeRequest = await child.peer.nextMethod('thread/resume')
    // A well-formed JSON-RPC success whose `result` is not an object at all:
    // `object()` classifies this as a protocol violation directly (never a
    // `JsonRpcResponseError`), exercising `resumeThread`'s plain `throw error`
    // rethrow arm rather than its `JsonRpcResponseError`-specific branch.
    child.peer.respond(resumeRequest, null)
    await expect(resuming).rejects.toMatchObject({
      name: 'ClassifiedSubagentFailure',
      failure: { code: 'protocol' },
    })
    wire.close()
  })

  it('rejects a thread/resume that resumed a different thread than requested', async () => {
    const child = fakeChild()
    const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
    wire.start()
    const resuming = wire.resumeThread('thread-a', 'read-only', new AbortController().signal)
    const resumeRequest = await child.peer.nextMethod('thread/resume')
    child.peer.respond(resumeRequest, { thread: { id: 'thread-b', ephemeral: false } })
    await expect(resuming).rejects.toThrow('resumed a different thread than requested')
    wire.close()
  })

  it('fails closed for empty output, malformed messages, phases, and terminal status', async () => {
    const scenarios: Array<{
      readonly frames: JsonObject[]
      readonly message: string
    }> = [
      {
        frames: [turnCompleted('completed')],
        message: 'without a final answer',
      },
      {
        frames: [
          agentMessage('fallback', null),
          agentMessage(' \n ', 'final_answer'),
          turnCompleted('completed'),
        ],
        message: 'without a final answer',
      },
      {
        frames: [agentMessage(42, 'final_answer')],
        message: 'invalid agent message',
      },
      {
        frames: [agentMessage('answer', 'future_phase')],
        message: 'unknown agent message phase',
      },
      {
        // A `failed` terminal turn now throws the classified failure's own
        // message (the provider's actionable text), not a generic wrapper —
        // see the failure-classification Agent Note.
        frames: [turnCompleted('failed', 'turn-1', 'thread-1', { message: 'no' })],
        message: 'no',
      },
      {
        frames: [turnCompleted('interrupted')],
        message: 'status interrupted',
      },
      {
        frames: [turnCompleted('inProgress')],
        message: 'invalid terminal turn status',
      },
    ]
    for (const scenario of scenarios) {
      const { child, wire } = await initializeWire()
      const result = wire.runTurn(['task'], new AbortController().signal)
      const turnStart = await child.peer.nextMethod('turn/start')
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      child.peer.send(...scenario.frames)
      await expect(result).rejects.toThrow(scenario.message)
      wire.close()
    }
  })

  it('fails closed when terminal notification params are not an object', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send({ method: 'turn/completed', params: null })
    await expect(result).rejects.toThrow('invalid turn/completed thread id')
    wire.close()
  })

  it('keeps an unsupported request authoritative over an early terminal in the same chunk', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.send(
      { id: turnStart.id, result: { turn: { id: 'turn-1' } } },
      { id: 'future-request', method: 'future/request', params: {} },
      agentMessage('early answer', 'final_answer'),
      turnCompleted('completed'),
    )
    await expect(result).rejects.toThrow('unsupported app-server request')
    wire.close()
  })

  it('answers all five unattended request classes without granting authority', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')

    child.peer.send({
      id: 'command',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        availableDecisions: ['decline', 'cancel'],
      },
    })
    expect(await child.peer.nextResponse('command')).toMatchObject({
      result: { decision: 'cancel' },
    })

    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    const requests = [
      {
        id: 'file',
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          availableDecisions: ['decline'],
        },
        result: { decision: 'decline' },
      },
      {
        id: 'file-default',
        method: 'item/fileChange/requestApproval',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
        result: { decision: 'decline' },
      },
      {
        id: 'permissions',
        method: 'item/permissions/requestApproval',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
        result: { permissions: {}, scope: 'turn' },
      },
      {
        id: 'user-input',
        method: 'item/tool/requestUserInput',
        params: { threadId: 'thread-1', turnId: 'turn-1', questions: [] },
        result: { answers: {} },
      },
      {
        id: 'mcp',
        method: 'mcpServer/elicitation/request',
        params: { threadId: 'thread-1', turnId: null },
        result: { action: 'decline', content: null, _meta: null },
      },
    ] as const
    for (const serverRequest of requests) {
      child.peer.send(serverRequest)
      expect(await child.peer.nextResponse(serverRequest.id)).toMatchObject({
        result: serverRequest.result,
      })
    }

    child.peer.send(agentMessage('answer', 'final_answer'), turnCompleted('completed'))
    await expect(result).resolves.toMatchObject({ stopReason: 'completed' })
    wire.close()
  })

  it('fails the run on unknown requests or wrong request association', async () => {
    for (const serverRequest of [
      {
        id: 'unknown',
        method: 'future/request',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
      },
      {
        id: 'approval',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          availableDecisions: ['accept'],
        },
      },
      {
        id: 'malformed-approval',
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          availableDecisions: 'decline',
        },
      },
      {
        id: 'thread',
        method: 'item/fileChange/requestApproval',
        params: { threadId: 'thread-2', turnId: 'turn-1' },
      },
      {
        id: 'turn',
        method: 'item/fileChange/requestApproval',
        params: { threadId: 'thread-1', turnId: 'turn-2' },
      },
    ]) {
      const { child, wire } = await initializeWire()
      const result = wire.runTurn(['task'], new AbortController().signal)
      const turnStart = await child.peer.nextMethod('turn/start')
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      await nextTask()
      child.peer.send(serverRequest)
      const response = await child.peer.nextResponse(serverRequest.id)
      expect(response.error).toMatchObject({ code: -32603 })
      await expect(result).rejects.toThrow()
      wire.close()
    }
  })

  it('rejects conflicting early turn identities before accepting output', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.send({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-early' } },
    })
    child.peer.respond(turnStart, { turn: { id: 'turn-response' } })
    await expect(result).rejects.toThrow('did not match the active turn')
    wire.close()
  })

  it('rejects conflicting early notifications and requests before turn/start', async () => {
    {
      const { child, wire } = await initializeWire()
      child.peer.send({
        id: 'too-early',
        method: 'item/fileChange/requestApproval',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
      })
      const response = await child.peer.nextResponse('too-early')
      expect(response.error).toMatchObject({ code: -32603 })
      wire.close()
    }
    {
      const { child, wire } = await initializeWire()
      const result = wire.runTurn(['task'], new AbortController().signal)
      await child.peer.nextMethod('turn/start')
      child.peer.send(
        {
          method: 'turn/started',
          params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
        },
        agentMessage('wrong', 'final_answer', 'turn-2'),
      )
      await expect(result).rejects.toThrow('conflicting turns')
      wire.close()
    }
  })

  it('interrupts only an active open turn and contains remote interrupt failure', async () => {
    const { child, wire } = await initializeWire()
    wire.interrupt()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    wire.interrupt()
    const interrupt = await child.peer.nextMethod('turn/interrupt')
    expect(interrupt.params).toEqual({ threadId: 'thread-1', turnId: 'turn-1' })
    child.peer.send({
      id: interrupt.id,
      error: { code: -32000, message: 'already done' },
    })
    child.peer.send(agentMessage('answer', 'final_answer'), turnCompleted('completed'))
    await expect(result).resolves.toMatchObject({ stopReason: 'completed' })
    wire.close()
    wire.interrupt()
  })

  it('ignores unrelated and out-of-window notifications', async () => {
    const { child, wire } = await initializeWire()
    child.peer.send(
      {
        method: 'turn/started',
        params: { threadId: 'thread-2', turn: { id: 'turn-other' } },
      },
      {
        method: 'turn/started',
        params: { threadId: 'thread-1', turn: { id: 'turn-before' } },
      },
      agentMessage('before', 'final_answer'),
      { method: 'future/notification', params: {} },
      turnCompleted('completed'),
      turnCompleted('completed', 'turn-other', 'thread-2'),
    )
    await nextTask()

    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    child.peer.send(
      agentMessage('wrong turn', 'final_answer', 'turn-2'),
      turnCompleted('completed', 'turn-2'),
      agentMessage('answer', 'final_answer'),
      turnCompleted('completed'),
    )
    await expect(result).resolves.toEqual({
      output: [{ type: 'text', text: 'answer' }],
      stopReason: 'completed',
    })
    wire.close()
  })

  it('rejects pending work on abort, EOF, and stream error', async () => {
    {
      const child = fakeChild()
      const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
      wire.start()
      const controller = new AbortController()
      controller.abort('pre-aborted')
      await expect(wire.initialize(controller.signal))
        .rejects.toThrow('app-server request aborted: pre-aborted')
      wire.close()
    }
    {
      const child = fakeChild()
      const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
      wire.start()
      const controller = new AbortController()
      const pending = wire.initialize(controller.signal)
      await child.peer.nextMethod('initialize')
      controller.abort(new Error('cancel initialize'))
      await expect(pending).rejects.toThrow('cancel initialize')
      wire.close()
    }
    {
      const child = fakeChild()
      const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
      wire.start()
      const pending = wire.initialize(new AbortController().signal)
      await child.peer.nextMethod('initialize')
      child.fromChild.end()
      await expect(pending).rejects.toThrow(/(?:protocol stream|JSON-RPC input) closed/)
      wire.close()
    }
    {
      const child = fakeChild()
      const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
      wire.start()
      const pending = wire.initialize(new AbortController().signal)
      await child.peer.nextMethod('initialize')
      child.fromChild.emit('error', new Error('stdout broke'))
      await expect(pending).rejects.toThrow('stdout broke')
      wire.close()
    }
    {
      const child = fakeChild()
      const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
      wire.start()
      const pending = wire.initialize(new AbortController().signal)
      await child.peer.nextMethod('initialize')
      child.toChild.emit('error', new Error('stdin broke'))
      await expect(pending).rejects.toThrow('stdin broke')
      wire.close()
      child.toChild.emit('error', new Error('late stdin close'))
    }
  })

  it('reports only `completed`-status fileChange items as absolute changedFiles paths (regression: a denied/declined/in-progress item must never be reported)', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send(
      fileChangeItem('inProgress', [{ path: '/workspace/in-progress.txt', kind: { type: 'add' }, diff: '' }]),
      fileChangeItem('declined', [{ path: '/workspace/declined.txt', kind: { type: 'add' }, diff: '' }]),
      fileChangeItem('failed', [{ path: '/workspace/failed.txt', kind: { type: 'add' }, diff: '' }]),
      fileChangeItem('completed', [{ path: '/workspace/made.txt', kind: { type: 'add' }, diff: 'WROTE\n' }]),
      agentMessage('created the file', 'final_answer'),
      turnCompleted('completed'),
    )
    await expect(result).resolves.toEqual({
      output: [{ type: 'text', text: 'created the file' }],
      stopReason: 'completed',
      changedFiles: ['/workspace/made.txt'],
    })
    wire.close()
  })

  it('dedupes repeated completed fileChange paths and preserves first-observed order', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send(
      fileChangeItem('completed', [{ path: '/workspace/a.txt', kind: { type: 'add' }, diff: 'A\n' }]),
      fileChangeItem('completed', [{ path: '/workspace/b.txt', kind: { type: 'add' }, diff: 'B\n' }]),
      fileChangeItem('completed', [{ path: '/workspace/a.txt', kind: { type: 'update' }, diff: 'A2\n' }]),
      agentMessage('done', 'final_answer'),
      turnCompleted('completed'),
    )
    await expect(result).resolves.toEqual({
      output: [{ type: 'text', text: 'done' }],
      stopReason: 'completed',
      changedFiles: ['/workspace/a.txt', '/workspace/b.txt'],
    })
    wire.close()
  })

  it('rejects a malformed fileChange changes array as a protocol failure', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send(fileChangeItem('completed', 'not-an-array'))
    await expect(result).rejects.toMatchObject({
      name: 'ClassifiedSubagentFailure',
      failure: { code: 'protocol' },
    })
    wire.close()
  })

  it('rejects a malformed thread/tokenUsage/updated last field as a protocol failure', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          // A non-number inputTokens is the measured shape deviation this
          // validator exists to reject — never a value this run should ever
          // silently treat as zero or drop. Production code reads `last`, not
          // `total` (see the Agent Note), so the malformed field belongs there.
          last: { inputTokens: 'not-a-number', outputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
        },
      },
    })
    await expect(result).rejects.toMatchObject({
      name: 'ClassifiedSubagentFailure',
      failure: { code: 'protocol' },
    })
    wire.close()
  })

  it('ignores a thread/tokenUsage/updated notification scoped to a different thread', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send(
      // Wrong thread: must be ignored, not retained as this run's usage.
      tokenUsageUpdated({ inputTokens: 999, outputTokens: 999, cachedInputTokens: 0, cacheWriteInputTokens: 0 }, 'turn-1', 'other-thread'),
      tokenUsageUpdated({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 0 }),
      agentMessage('answer', 'final_answer'),
      turnCompleted('completed'),
    )
    await expect(result).resolves.toEqual({
      output: [{ type: 'text', text: 'answer' }],
      stopReason: 'completed',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    wire.close()
  })

  it('sums each notification\'s own last field for one turn, never the raw cumulative total (regression: double-counting)', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send(
      // A real 2-response turn (tool call, then final answer): each
      // notification's `last` is that individual model call's own usage
      // (measured, see the Agent Note), while `total` is deliberately given
      // an unrelated INFLATED value here (as if this thread already carried
      // prior-turn history from a resume) to prove production code never
      // reads it.
      tokenUsageUpdated(
        { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
        'turn-1', 'thread-1',
        { inputTokens: 100_010, outputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
      ),
      tokenUsageUpdated(
        { inputTokens: 20, outputTokens: 6, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
        'turn-1', 'thread-1',
        { inputTokens: 100_030, outputTokens: 11, cachedInputTokens: 40_448, cacheWriteInputTokens: 0 },
      ),
      agentMessage('answer', 'final_answer'),
      turnCompleted('completed'),
    )
    await expect(result).resolves.toEqual({
      output: [{ type: 'text', text: 'answer' }],
      stopReason: 'completed',
      // Sum of both notifications' own `last` (10+20 in, 5+6 out) — the
      // real usage for THIS turn. Reading either raw `total` (100_030/11, a
      // double count against `last`'s own sum for a fresh thread, or an
      // outright wrong inflated value for a resumed one) would fail this.
      usage: { inputTokens: 30, outputTokens: 11, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    wire.close()
  })

  it('drops a thread/tokenUsage/updated notification for an earlier turn without throwing (the resume replay artifact)', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    child.peer.send(
      // Measured: immediately after `thread/resume`, the app-server replays
      // ONE `thread/tokenUsage/updated` notification for the PRE-resume
      // thread's last completed turn, before this process ever calls
      // `turn/start` — i.e. before `this.turnId` is committed. A naive
      // `observePendingTurnId` call here would retain this stale id and then
      // throw once `turn/start`'s own response names the real (different)
      // turn. It must instead be dropped once the real turn commits (see the
      // Agent Note).
      tokenUsageUpdated({ inputTokens: 999, outputTokens: 999, cachedInputTokens: 0, cacheWriteInputTokens: 0 }, 'stale-pre-resume-turn'),
    )
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send(
      tokenUsageUpdated({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 0 }),
      agentMessage('answer', 'final_answer'),
      turnCompleted('completed'),
    )
    await expect(result).resolves.toEqual({
      output: [{ type: 'text', text: 'answer' }],
      stopReason: 'completed',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    wire.close()
  })

  it('silently drops a thread/tokenUsage/updated notification that arrives before any turn was ever started (no turn to queue it for)', async () => {
    const { child, wire } = await initializeWire()
    // No `runTurn()` call yet: `this.turnCompleted` is genuinely `undefined`
    // here (distinct from the resume-replay test above, where `runTurn()`
    // already ran and only `this.turnId` was still unset) — this notification
    // has no turn to queue against at all, so it must be dropped outright,
    // never queued into `earlyTurnNotifications`.
    child.peer.send(tokenUsageUpdated({ inputTokens: 999, outputTokens: 999, cachedInputTokens: 0, cacheWriteInputTokens: 0 }))
    await nextTask()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send(
      tokenUsageUpdated({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 0 }),
      agentMessage('answer', 'final_answer'),
      turnCompleted('completed'),
    )
    await expect(result).resolves.toEqual({
      output: [{ type: 'text', text: 'answer' }],
      stopReason: 'completed',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    wire.close()
  })

  it('attaches changedFiles/usage to a max-tokens result exactly like a completed one', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send(
      fileChangeItem('completed'),
      tokenUsageUpdated({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 0 }),
      agentMessage('partial', null),
      turnCompleted('failed', 'turn-1', 'thread-1', { message: 'ctx', codexErrorInfo: 'contextWindowExceeded' }),
    )
    await expect(result).resolves.toEqual({
      output: [{ type: 'text', text: 'partial' }],
      stopReason: 'max-tokens',
      changedFiles: ['/workspace/made.txt'],
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    wire.close()
  })

  it('reports no changedFiles for a read-only run that never produced a fileChange item', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send(
      agentMessage('nothing to change here', 'final_answer'),
      turnCompleted('completed'),
    )
    const settled = await result
    expect(settled.changedFiles).toBeUndefined()
    expect(settled.usage).toBeUndefined()
    wire.close()
  })
})

describe('run lifecycle and quiescence', () => {
  it('spawns the fixed app-server, publishes after thread creation, and disposes once', async () => {
    const child = fakeChild()
    const spawn = vi.fn(() => child.handle)
    const starting = startCodexRun(
      request([{ type: 'text', text: 'task' }]),
      runSpec(child, { env: { OPENAI_API_KEY: 'fake' }, spawn }),
    )
    let published = false
    void starting.then(() => { published = true })
    const initialize = await child.peer.nextMethod('initialize')
    expect(published).toBe(false)
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.147.0' })
    await child.peer.nextMethod('initialized')
    const threadStart = await child.peer.nextMethod('thread/start')
    expect(published).toBe(false)
    child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: true } })
    const run = await starting
    expect(spawn).toHaveBeenCalledWith({
      argv: codexAppServerArgv(),
      cwd: process.cwd(),
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      graceMs: DEFAULT_DISPOSE_GRACE_MS,
      env: { OPENAI_API_KEY: 'fake' },
    })
    expect(run.localAgent).toBeUndefined()

    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.send(
      { id: turnStart.id, result: { turn: { id: 'turn-1' } } },
      agentMessage('answer', 'final_answer'),
      turnCompleted('completed'),
    )
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'answer' }],
      stopReason: 'completed',
    })
    const disposal = run.dispose()
    expect(run.dispose()).toBe(disposal)
    await disposal
    await nextTask()
    expect(child.terminate).toHaveBeenCalledTimes(1)
    expect(child.waitForExit).toHaveBeenCalledTimes(1)
  })

  it('sends thread/resume (not thread/start) when a resumeId is present, re-pinning sandbox/approvalPolicy', async () => {
    const child = fakeChild()
    const starting = startCodexRun(
      request([{ type: 'text', text: 'continue the task' }]),
      runSpec(child, { permissionMode: 'workspace-write', resumeId: 'prior-thread-1' }),
    )
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.147.0' })
    await child.peer.nextMethod('initialized')
    const resumeRequest = await child.peer.nextMethod('thread/resume')
    expect(resumeRequest.params).toEqual({
      threadId: 'prior-thread-1',
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
    })
    child.peer.respond(resumeRequest, { thread: { id: 'prior-thread-1', ephemeral: false } })
    const run = await starting
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.send(
      { id: turnStart.id, result: { turn: { id: 'turn-2' } } },
      agentMessage('answer', 'final_answer', 'turn-2', 'prior-thread-1'),
      turnCompleted('completed', 'turn-2', 'prior-thread-1'),
    )
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'answer' }],
      stopReason: 'completed',
      resumeId: 'prior-thread-1',
    })
    await run.dispose()
  })

  it('fails the run (never publishing) when thread/resume is rejected for an invalid/unknown id', async () => {
    const child = fakeChild()
    const starting = startCodexRun(
      request([{ type: 'text', text: 'continue the task' }]),
      runSpec(child, { resumeId: 'unknown-thread' }),
    )
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.147.0' })
    await child.peer.nextMethod('initialized')
    const resumeRequest = await child.peer.nextMethod('thread/resume')
    child.peer.respondError(resumeRequest, -32600, 'no rollout found for thread id unknown-thread')
    await expect(starting).rejects.toMatchObject({
      name: 'ClassifiedSubagentFailure',
      failure: { code: 'provider' },
    })
    await nextTask()
    expect(child.terminate).toHaveBeenCalledTimes(1)
  })

  it('settles local cancellation immediately and sends best-effort interrupt', async () => {
    const controller = new AbortController()
    const { child, run, turnStart } = await publishRun(
      fakeChild(),
      controller.signal,
    )
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    controller.abort(new Error('stop'))
    await expect(run.result).resolves.toEqual({
      output: [],
      stopReason: 'aborted',
    })
    expect(await child.peer.nextMethod('turn/interrupt')).toMatchObject({
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    })
    await run.dispose()
  })

  it('flattens child exit and protocol failures after publication', async () => {
    const errors: string[] = []
    {
      const child = fakeChild({ exitOnTerminate: false })
      const { run } = await publishRun(child, undefined, {
        onError: (error) => { errors.push(error.message) },
      })
      child.settle({ exitCode: 9, signal: null })
      await expect(run.result).resolves.toEqual({ output: [], stopReason: 'error' })
      expect(errors.at(-1)).toContain('code 9')
      await run.dispose().catch(() => {})
    }
    {
      const child = fakeChild()
      const { run, turnStart } = await publishRun(child, undefined, {
        onError: () => { throw new Error('diagnostic sink') },
      })
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      child.fromChild.end()
      await expect(run.result).resolves.toEqual({ output: [], stopReason: 'error' })
      await run.dispose()
    }
  })

  it('rejects before spawn when pre-aborted and rolls back startup failures', async () => {
    const controller = new AbortController()
    controller.abort()
    const spawn = vi.fn()
    await expect(startCodexRun(
      request(undefined, controller.signal),
      {
        cwd: process.cwd(),
        permissionMode: 'read-only',
        env: {},
        disposeGraceMs: 10,
        requestResume: false,
        spawn,
      },
    )).rejects.toThrow('aborted before app-server startup')
    expect(spawn).not.toHaveBeenCalled()

    const child = fakeChild()
    const starting = startCodexRun(request(), runSpec(child))
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, null)
    await expect(starting).rejects.toThrow('invalid initialize response')
    expect(child.terminate).toHaveBeenCalledTimes(1)
  })

  it('rolls back an abort that wins immediately after thread creation', async () => {
    const controller = new AbortController()
    const child = fakeChild()
    const starting = startCodexRun(
      request(undefined, controller.signal),
      runSpec(child),
    )
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.147.0' })
    await child.peer.nextMethod('initialized')
    const threadStart = await child.peer.nextMethod('thread/start')
    child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: true } })
    controller.abort('startup race')
    await expect(starting).rejects.toThrow('aborted before run publication')
    expect(child.terminate).toHaveBeenCalledTimes(1)
  })

  it('rolls back a subprocess done rejection during startup', async () => {
    const child = fakeChild({ doneError: new Error('spawn observer failed') })
    const error: unknown = await startCodexRun(request(), runSpec(child)).then(
      () => undefined,
      (failure: unknown) => failure,
    )
    expect(error).toBeInstanceOf(AggregateError)
    if (!(error instanceof AggregateError)) {
      throw new Error('expected startup and rollback failures')
    }
    expect(error.errors).toEqual([
      expect.objectContaining({ message: 'spawn observer failed' }),
      expect.objectContaining({ message: 'spawn observer failed' }),
    ])
    expect(child.terminate).toHaveBeenCalledTimes(1)
  })

  it('keeps overlapping runs isolated', async () => {
    const first = fakeChild()
    const second = fakeChild()
    const runs = await Promise.all([
      publishRun(first),
      publishRun(second),
    ])
    for (const [index, entry] of runs.entries()) {
      const id = `turn-${index + 1}`
      entry.child.peer.send(
        { id: entry.turnStart.id, result: { turn: { id } } },
        agentMessage(`answer-${index + 1}`, 'final_answer', id),
        turnCompleted('completed', id),
      )
    }
    const results = await Promise.all(runs.map(entry => entry.run.result))
    expect(results.map(result => result.output)).toEqual([
      [{ type: 'text', text: 'answer-1' }],
      [{ type: 'text', text: 'answer-2' }],
    ])
    expect(runs[0].run.id).not.toBe(runs[1].run.id)
    await Promise.all(runs.map(entry => entry.run.dispose()))
  })

  it('uses the registered provider config and logs flattened errors', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const child = fakeChild()
    const spawn = vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue(child.handle)
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => {
      warnings.push(String(message))
    }) as typeof ctx.logger.warn
    await ctx.plugin(codex, {
      env: { OPENAI_API_KEY: 'fake' },
      disposeGraceMs: 25,
    })
    const starting = ctx.subagents.start('codex', {
      prompt: [{ type: 'text', text: 'task' }],
      parent: fakeParent,
      signal: new AbortController().signal,
    })
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.147.0' })
    await child.peer.nextMethod('initialized')
    const threadStart = await child.peer.nextMethod('thread/start')
    child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: true } })
    const run = await starting
    await child.peer.nextMethod('turn/start')
    child.settle({ exitCode: 1, signal: null })
    await expect(run.result).resolves.toMatchObject({ stopReason: 'error', authMode: 'api-key' })
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      env: { OPENAI_API_KEY: 'fake' },
      graceMs: 25,
      cwd: process.cwd(),
    }))
    expect(warnings).toEqual([
      expect.stringContaining('subagent-codex: child run failed (error):'),
    ])
    await run.dispose().catch(() => {})
    await ctx.fiber.dispose()
  })

  it('derives auth_mode purely from Config.env, never probing a credential store', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const child = fakeChild()
    vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue(child.handle)
    // No credential-shaped entry anywhere in `Config.env` (an empty env, the
    // schema default): `authMode` must read `'subscription'`.
    await ctx.plugin(codex, {})
    const starting = ctx.subagents.start('codex', {
      prompt: [{ type: 'text', text: 'task' }],
      parent: fakeParent,
      signal: new AbortController().signal,
    })
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.147.0' })
    await child.peer.nextMethod('initialized')
    const threadStart = await child.peer.nextMethod('thread/start')
    child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: true } })
    const run = await starting
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.send(
      { id: turnStart.id, result: { turn: { id: 'turn-1' } } },
      agentMessage('answer', 'final_answer'),
      turnCompleted('completed'),
    )
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'answer' }],
      stopReason: 'completed',
      authMode: 'subscription',
    })
    await run.dispose()
    await ctx.fiber.dispose()
  })
})

describe('disposeCodexChild', () => {
  it('closes stdin, terminates, and waits for the managed tree', async () => {
    const child = fakeChild()
    const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
    const end = vi.spyOn(child.toChild, 'end')
    await disposeCodexChild(wire, child.handle)
    expect(end).toHaveBeenCalled()
    expect(child.terminate).toHaveBeenCalledTimes(1)
    expect(child.waitForExit).toHaveBeenCalledTimes(1)
    expect(child.waitForExit).toHaveBeenCalledWith()
  })

  it('does not finish disposal before the managed tree exits', async () => {
    const child = fakeChild({ exitOnTerminate: false })
    const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
    let disposed = false
    const disposal = disposeCodexChild(wire, child.handle).then(() => {
      disposed = true
    })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(disposed).toBe(false)
    child.settle()
    await disposal
    expect(disposed).toBe(true)
  })

  it('contains a concurrently closed stdin error', async () => {
    const child = fakeChild()
    const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
    vi.spyOn(child.toChild, 'end').mockImplementation(() => {
      throw new Error('already closed')
    })
    await expect(disposeCodexChild(wire, child.handle))
      .resolves.toBeUndefined()
  })

  it('handles a spawn-level failure with no process tree', async () => {
    const child = fakeChild({
      pid: -1,
      doneError: new Error('spawn failed'),
    })
    const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
    await expect(disposeCodexChild(wire, child.handle))
      .resolves.toBeUndefined()
    expect(child.terminate).not.toHaveBeenCalled()
    expect(child.waitForExit).not.toHaveBeenCalled()
  })

  it('reports direct-child observer failure and accepts absent stdin', async () => {
    {
      const child = fakeChild({
        doneError: new Error('close observer failed'),
      })
      const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
      await expect(disposeCodexChild(wire, child.handle))
        .rejects.toThrow('close observer failed')
    }
    {
      const child = fakeChild()
      const handle = { ...child.handle, stdin: undefined }
      const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
      await expect(disposeCodexChild(wire, handle)).resolves.toBeUndefined()
    }
  })
})
