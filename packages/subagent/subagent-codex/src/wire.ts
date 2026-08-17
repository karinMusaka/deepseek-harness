/**
 * Minimal Codex app-server 0.147.0 protocol adapter. The shared JSON-RPC
 * transport owns framing and request correlation; this module owns only the
 * product methods, current thread/turn association, unattended approval
 * responses, and terminal-answer selection.
 *
 * @module @deepseek-ai/dsh-subagent-codex/wire
 */

import type { Readable, Writable } from 'node:stream'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-llm'
import { ClassifiedSubagentFailure } from '@deepseek-ai/dsh-subagent'
import type { SubagentFailureCode, SubagentPermissionMode, SubagentResult } from '@deepseek-ai/dsh-subagent'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'

/**
 * Map the seam's closed permission vocabulary to the app-server's `sandbox`
 * enum.
 * @param permissionMode - the child's fixed permission scope.
 * @returns the app-server `ThreadStartParams.sandbox` value.
 */
function codexSandbox(permissionMode: SubagentPermissionMode): 'read-only' | 'workspace-write' {
  switch (permissionMode) {
    case 'read-only':
      return 'read-only'
    case 'workspace-write':
      return 'workspace-write'
    /* v8 ignore next 2 -- closed-union exhaustiveness guard */
    default:
      return assertNever(permissionMode, 'codexSandbox')
  }
}

type JsonObject = Record<string, unknown>

/**
 * A JSON-RPC-level deviation from the app-server's own documented shapes
 * (this validator's very purpose). Every throw here is classified `protocol`
 * — the spec's own definition of the class — so a mid-turn shape violation
 * settles as a routable `SubagentResult.failure` instead of an unclassified
 * `'error'` stop reason.
 */
function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    const message = `subagent-codex: app-server returned invalid ${label}`
    throw new ClassifiedSubagentFailure(message, { code: 'protocol', message })
  }
  return value as JsonObject
}

/** See {@link object}: the same protocol-deviation classification for a required string field. */
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    const message = `subagent-codex: app-server returned invalid ${label}`
    throw new ClassifiedSubagentFailure(message, { code: 'protocol', message })
  }
  return value
}

function unattendedDecision(params: JsonObject): 'cancel' | 'decline' {
  const available = params.availableDecisions
  if (available === undefined || available === null) return 'decline'
  if (Array.isArray(available)) {
    if (available.includes('cancel')) return 'cancel'
    if (available.includes('decline')) return 'decline'
  }
  throw new Error('subagent-codex: app-server offered no unattended approval decision')
}

function isContextWindowExceeded(turn: JsonObject): boolean {
  if (turn.status !== 'failed') return false
  const error = turn.error
  return error !== null
    && typeof error === 'object'
    && !Array.isArray(error)
    && (error as JsonObject).codexErrorInfo === 'contextWindowExceeded'
}

/**
 * `codexErrorInfo` object variants that carry an HTTP status
 * (`rust-v0.147.0`): `httpConnectionFailed`, `responseStreamConnectionFailed`,
 * `responseStreamDisconnected`, `responseTooManyFailedAttempts`.
 */
const HTTP_STATUS_VARIANT_KEYS = [
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts',
] as const

/**
 * The comparable label for "most specific cause seen": the literal enum
 * string (`unauthorized`, `usageLimitExceeded`, `other`, …) as-is, or the
 * matching {@link HTTP_STATUS_VARIANT_KEYS} name for an object variant, or
 * `'other'` for an unrecognized shape. `codexErrorInfo`'s vocabulary is
 * external and open (the app-server may add values in a later release);
 * unrecognized labels fall through to `'other'`'s classification rather than
 * failing loud, so a version bump degrades gracefully instead of crashing.
 */
function codexErrorInfoLabel(info: unknown): string {
  if (typeof info === 'string') return info
  if (info !== null && typeof info === 'object' && !Array.isArray(info)) {
    const record = info as JsonObject
    for (const key of HTTP_STATUS_VARIANT_KEYS) {
      if (key in record) return key
    }
  }
  return 'other'
}

/** Extract the HTTP status from an object-variant `codexErrorInfo`, if any. */
function codexHttpStatusCode(info: unknown): number | undefined {
  if (info === null || typeof info !== 'object' || Array.isArray(info)) return undefined
  const record = info as JsonObject
  for (const key of HTTP_STATUS_VARIANT_KEYS) {
    const variant = record[key]
    if (variant !== null && typeof variant === 'object' && !Array.isArray(variant)) {
      const status = (variant as JsonObject).httpStatusCode
      if (typeof status === 'number') return status
    }
  }
  return undefined
}

/**
 * Map a codex-native cause to the seam's closed failure vocabulary (measured
 * table; see the
 * [Agent Note](../../../../.agents/notes/implemented/feature/2026-08-17-subagent-delegation-failure-classification.md)).
 * `codexErrorInfo`'s enum is external and open, so an unrecognized label
 * falls through to `'provider'` — never `assertNever`, which is reserved for
 * this module's own closed {@link SubagentFailureCode} switches.
 * @param label - {@link codexErrorInfoLabel}'s comparable cause label.
 * @param httpStatusCode - the HTTP status from an object-variant cause, if any.
 * @returns the classified failure code.
 */
function classifyCodexFailure(label: string, httpStatusCode: number | undefined): SubagentFailureCode {
  if (httpStatusCode === 401) return 'auth'
  if (httpStatusCode === 429) return 'quota'
  if (label === 'unauthorized') return 'auth'
  if (label === 'usageLimitExceeded' || label === 'serverOverloaded') return 'quota'
  return 'provider'
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed protocol and stream failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`subagent-codex: app-server request aborted: ${String(signal.reason)}`)
}

async function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => {})
    throw abortError(signal)
  }
  let rejectAbort!: (error: Error) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = (): void => { rejectAbort(abortError(signal)) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * One app-server connection and its single ephemeral thread/turn.
 *
 * The class deliberately exposes no generic request surface. Supporting
 * another product method must first become part of the provider contract.
 */
export class CodexAppServerWire {
  private readonly transport: JsonRpcLineTransport
  private readonly fatal = Promise.withResolvers<never>()
  private threadId: string | undefined
  private turnId: string | undefined
  private pendingTurnId: string | undefined
  private turnCompleted: PromiseWithResolvers<JsonObject> | undefined
  private readonly earlyTurnNotifications: Array<{
    readonly method: string
    readonly params: JsonObject
  }> = []
  private lastFinalAnswer: string | undefined
  private lastUnphasedAnswer: string | undefined
  private closed = false
  /**
   * Most specific cause retained across the active turn's `error`
   * notifications. The terminal `turn/completed` degrades a retryable 401 to
   * the literal `codexErrorInfo: "other"` (measured against real
   * unauthenticated app-server 0.147.0) — retaining the cause here, from the
   * intermediate notifications `handleNotification` does not otherwise
   * observe, is the only way to classify that turn as `auth` instead of
   * `provider`.
   */
  private retainedErrorLabel: string | undefined
  private retainedHttpStatusCode: number | undefined

  constructor(
    private readonly input: Readable,
    output: Writable,
  ) {
    this.transport = new JsonRpcLineTransport(input, output)
    // Fatal protocol state can arrive after the current guarded operation has
    // already settled. Keep the shared rejection observed without inserting
    // another promise-adoption hop into active races.
    void this.fatal.promise.catch(() => {})
    this.transport.onRequest((method, params) => this.handleServerRequest(method, params))
    this.transport.onNotification((method, params) => {
      try {
        this.handleNotification(method, params)
      } catch (error: unknown) {
        this.fail(thrown(error))
      }
    })
    this.input.on('error', this.onInputError)
    this.input.on('end', this.onInputEnd)
    // Pipe errors can race protocol closure and process teardown. Retain both
    // error listeners for the lifetime of their per-run streams so no late
    // EPIPE or read failure becomes an unhandled EventEmitter error.
    output.on('error', this.onOutputError)
  }

  /** Start reading app-server frames. */
  start(): void {
    this.transport.start()
  }

  /**
   * Perform the required app-server initialize/initialized handshake.
   * @param signal - unpublished-start cancellation.
   */
  async initialize(signal: AbortSignal): Promise<void> {
    object(await this.guarded(this.transport.request('initialize', {
      clientInfo: {
        name: 'deepseek-harness',
        title: 'DeepSeek Harness',
        version: '0.0.1',
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    }, signal), signal), 'initialize response')
    this.transport.notify('initialized')
    await this.guarded(this.transport.flush(), signal)
  }

  /**
   * Create the run's private ephemeral thread and retain its identity. Pins
   * `sandbox` from the fixed delegation-time permission scope and
   * `approvalPolicy: 'never'` explicitly, rather than inheriting whatever
   * `~/.codex/config.toml` the host happens to have (both are non-experimental
   * app-server 0.147.0 parameters).
   * @param cwd - parent Session workspace.
   * @param permissionMode - the child's fixed permission scope, mapped to `sandbox`.
   * @param signal - unpublished-start cancellation.
   */
  async startThread(cwd: string, permissionMode: SubagentPermissionMode, signal: AbortSignal): Promise<void> {
    const response = object(await this.guarded(this.transport.request('thread/start', {
      cwd,
      ephemeral: true,
      sandbox: codexSandbox(permissionMode),
      approvalPolicy: 'never',
    }, signal), signal), 'thread/start response')
    const thread = object(response.thread, 'thread/start thread')
    const id = string(thread.id, 'thread/start thread id')
    if (thread.ephemeral !== true) {
      throw new Error('subagent-codex: app-server did not create an ephemeral thread')
    }
    this.threadId = id
  }

  /**
   * Submit the one text-only task and wait for this thread/turn's authoritative
   * terminal notification.
   * @param texts - already validated task text blocks.
   * @param signal - local cancellation for the published run.
   * @returns the shared subagent result.
   */
  async runTurn(
    texts: readonly string[],
    signal: AbortSignal,
  ): Promise<SubagentResult> {
    const completion = Promise.withResolvers<JsonObject>()
    this.turnCompleted = completion
    const threadId = this.threadId as string
    const response = object(await this.guarded(this.transport.request('turn/start', {
      threadId,
      input: texts.map(text => ({ type: 'text', text, text_elements: [] })),
    }, signal), signal), 'turn/start response')
    const turn = object(response.turn, 'turn/start turn')
    this.commitTurnId(string(turn.id, 'turn/start turn id'))

    const completed = await this.guarded(completion.promise, signal)
    const terminal = object(completed.turn, 'turn/completed turn')
    const status = terminal.status
    if (isContextWindowExceeded(terminal)) {
      return { output: this.collectOutput(), stopReason: 'max-tokens' }
    }
    if (status !== 'completed') {
      if (status === 'failed') throw this.classifiedTurnFailure(terminal)
      throw new Error(`subagent-codex: Codex turn ended with status ${String(status)}`)
    }
    const output = this.collectOutput()
    if (output.length === 0) {
      throw new Error('subagent-codex: Codex completed without a final answer')
    }
    return { output, stopReason: 'completed' }
  }

  /**
   * Best-effort remote cancellation. Local settlement and process teardown
   * remain authoritative when the child no longer accepts protocol requests.
   */
  interrupt(): void {
    if (this.threadId === undefined || this.turnId === undefined || this.closed) return
    void this.transport.request('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.turnId,
    }).catch(() => {})
  }

  /**
   * The best non-commentary answer observed so far, preserving exact bytes.
   * @returns the selected final or nullable-phase text block, if any.
   */
  collectOutput(): ContentBlock[] {
    const selected = this.lastFinalAnswer ?? this.lastUnphasedAnswer
    return selected !== undefined && selected.trim().length > 0
      ? [{ type: 'text', text: selected }]
      : []
  }

  /** Detach JSON-RPC listeners and reject outstanding requests. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.input.off('end', this.onInputEnd)
    this.transport.close()
  }

  private async guarded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    const withFatal = Promise.race([this.fatal.promise, pending])
    return raceAbort(withFatal, signal)
  }

  private fail(error: Error): void {
    this.fatal.reject(error)
  }

  private readonly onInputError = (error: Error): void => {
    this.fail(error)
  }

  private readonly onOutputError = (error: Error): void => {
    this.fail(error)
  }

  private readonly onInputEnd = (): void => {
    this.fail(new Error('subagent-codex: app-server protocol stream closed'))
  }

  private observePendingTurnId(id: string): void {
    if (this.turnCompleted === undefined) {
      throw new Error('subagent-codex: app-server referenced a turn before turn/start')
    }
    if (this.pendingTurnId !== undefined && this.pendingTurnId !== id) {
      throw new Error('subagent-codex: app-server referenced conflicting turns')
    }
    this.pendingTurnId = id
  }

  private commitTurnId(id: string): void {
    if (this.pendingTurnId !== undefined && this.pendingTurnId !== id) {
      throw new Error('subagent-codex: turn/start response did not match the active turn')
    }
    this.turnId = id
    const notifications = this.earlyTurnNotifications.splice(0)
    for (const notification of notifications) {
      this.handleNotification(notification.method, notification.params)
    }
  }

  private validateRunIds(params: JsonObject, nullableTurn = false): void {
    if (params.threadId !== this.threadId) {
      throw new Error('subagent-codex: app-server request referenced another thread')
    }
    if (nullableTurn && params.turnId === null) return
    const id = string(params.turnId, 'server request turn id')
    if (this.turnId === undefined) {
      this.observePendingTurnId(id)
      return
    }
    if (id !== this.turnId) {
      throw new Error('subagent-codex: app-server request referenced another turn')
    }
  }

  /**
   * Build the classified failure for a `failed` terminal turn. Prefers
   * {@link retainedErrorLabel}/{@link retainedHttpStatusCode} — the most
   * specific cause seen across the turn's intermediate `error` notifications
   * — over the terminal turn's own `codexErrorInfo`, which degrades a
   * retryable 401 to the literal `"other"` (measured; see the Agent Note).
   * Falls back to the terminal turn's own info only when no `error`
   * notification was observed for this turn at all.
   */
  private classifiedTurnFailure(terminal: JsonObject): ClassifiedSubagentFailure {
    const error = terminal.error !== null && typeof terminal.error === 'object' && !Array.isArray(terminal.error)
      ? terminal.error as JsonObject
      : {}
    const message = typeof error.message === 'string' && error.message.length > 0
      ? error.message
      : 'subagent-codex: Codex turn ended with status "failed"'
    const label = this.retainedErrorLabel ?? codexErrorInfoLabel(error.codexErrorInfo)
    const httpStatusCode = this.retainedErrorLabel !== undefined
      ? this.retainedHttpStatusCode
      : codexHttpStatusCode(error.codexErrorInfo)
    return new ClassifiedSubagentFailure(message, { code: classifyCodexFailure(label, httpStatusCode), message })
  }

  /**
   * Retain the most specific native cause across possibly several `error`
   * notifications for the active turn: once a label other than `'other'` is
   * retained, a later `'other'` (the terminal degradation's own preceding
   * `error` notification, `willRetry: false`) never overwrites it.
   */
  private observeErrorNotification(params: JsonObject): void {
    const error = object(params.error, 'error notification error')
    const info = error.codexErrorInfo
    const label = codexErrorInfoLabel(info)
    if (label !== 'other' || this.retainedErrorLabel === undefined) {
      this.retainedErrorLabel = label
      this.retainedHttpStatusCode = codexHttpStatusCode(info)
    }
  }

  private handleServerRequest(method: string, params: JsonObject): Promise<unknown> {
    try {
      switch (method) {
        case 'item/commandExecution/requestApproval':
        case 'item/fileChange/requestApproval':
          this.validateRunIds(params)
          return Promise.resolve({ decision: unattendedDecision(params) })
        case 'item/permissions/requestApproval':
          this.validateRunIds(params)
          return Promise.resolve({ permissions: {}, scope: 'turn' })
        case 'item/tool/requestUserInput':
          this.validateRunIds(params)
          return Promise.resolve({ answers: {} })
        case 'mcpServer/elicitation/request':
          this.validateRunIds(params, true)
          return Promise.resolve({ action: 'decline', content: null, _meta: null })
        default:
          throw new Error(`subagent-codex: unsupported app-server request ${JSON.stringify(method)}`)
      }
    } catch (error: unknown) {
      const normalized = thrown(error)
      this.fail(normalized)
      return Promise.reject(normalized)
    }
  }

  private handleNotification(method: string, params: JsonObject): void {
    if (method === 'turn/started') {
      const threadId = string(params.threadId, 'turn/started thread id')
      if (threadId !== this.threadId) return
      const turn = object(params.turn, 'turn/started turn')
      if (this.turnCompleted !== undefined && this.turnId === undefined) {
        this.observePendingTurnId(string(turn.id, 'turn/started turn id'))
      }
      return
    }
    if (method === 'item/completed') {
      const threadId = string(params.threadId, 'item/completed thread id')
      if (threadId !== this.threadId) return
      const id = string(params.turnId, 'item/completed turn id')
      if (this.turnId === undefined) {
        if (this.turnCompleted !== undefined) {
          this.observePendingTurnId(id)
          this.earlyTurnNotifications.push({ method, params })
        }
        return
      }
      if (id !== this.turnId) return
      const item = object(params.item, 'item/completed item')
      if (item.type !== 'agentMessage') return
      const text = typeof item.text === 'string'
        ? item.text
        : (() => { throw new Error('subagent-codex: app-server returned an invalid agent message') })()
      if (item.phase === 'final_answer') {
        this.lastFinalAnswer = text
      } else if (item.phase === null) {
        this.lastUnphasedAnswer = text
      } else if (item.phase !== 'commentary') {
        throw new Error(`subagent-codex: app-server returned an unknown agent message phase ${JSON.stringify(item.phase)}`)
      }
      return
    }
    if (method === 'error') {
      const threadId = string(params.threadId, 'error thread id')
      if (threadId !== this.threadId) return
      const id = params.turnId
      if (typeof id === 'string') {
        if (this.turnId === undefined) {
          if (this.turnCompleted !== undefined) {
            this.observePendingTurnId(id)
            this.earlyTurnNotifications.push({ method, params })
          }
          return
        }
        if (id !== this.turnId) return
      }
      this.observeErrorNotification(params)
      return
    }
    if (method !== 'turn/completed') return
    const threadId = string(params.threadId, 'turn/completed thread id')
    if (threadId !== this.threadId) return
    const turn = object(params.turn, 'turn/completed turn')
    const id = string(turn.id, 'turn/completed turn id')
    const turnCompleted = this.turnCompleted
    if (turnCompleted === undefined) return
    if (this.turnId === undefined) {
      this.observePendingTurnId(id)
      this.earlyTurnNotifications.push({ method, params })
      return
    }
    if (id !== this.turnId) return
    if (!['completed', 'interrupted', 'failed'].includes(String(turn.status))) {
      throw new Error(`subagent-codex: app-server returned invalid terminal turn status ${String(turn.status)}`)
    }
    turnCompleted.resolve(params)
  }
}
