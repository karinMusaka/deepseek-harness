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
import type { SubagentFailureCode, SubagentPermissionMode, SubagentResult, SubagentUsage } from '@deepseek-ai/dsh-subagent'
import { JsonRpcLineTransport, JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-protocol'

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

/** See {@link object}: the same protocol-deviation classification for a required finite-number field. */
function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
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
  /**
   * Whether the current thread is non-ephemeral (`thread/start { ephemeral:
   * false }` or a successful `thread/resume`), set only on that success path.
   * Governs whether {@link resultExtras} reports {@link threadId} back as
   * {@link SubagentResult.resumeId}: an ephemeral thread has nothing to
   * resume, so it never reports one.
   */
  private persistent = false
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
  /**
   * Absolute paths from every `completed`-status `fileChange` item observed
   * this turn, in first-observed order. A `declined`/`failed`/`inProgress`
   * item is never added (measured: the app-server's own `status` field is the
   * authoritative success signal — see the Agent Note).
   */
  private readonly changedFilePaths = new Set<string>()
  /**
   * The SUM of the `last` field of every `thread/tokenUsage/updated`
   * notification observed for the CURRENT turn (early-queued/dropped by the
   * same turn-scoping rule as {@link observeFileChange}'s `item/completed`
   * notifications — see {@link handleNotification}). `last` is each
   * individual underlying model-call's own declared usage, never cumulative
   * even within one turn (measured against a real 2-response turn: two
   * notifications carried independent `last` values whose sum equals the
   * turn's own total) — so summing it, turn-scoped, reports exactly this
   * call's own usage on BOTH a fresh thread (where it is numerically
   * identical to the old "last observed cumulative total" rule this
   * supersedes) and a RESUMED thread. `total` is NOT used for this purpose:
   * it is cumulative for the THREAD's entire lifetime, confirmed NOT to reset
   * across turns even without resume — reading it directly on a resumed
   * thread would report the run's own usage as the whole thread's history
   * (measured; see the Agent Note). Turn-scoping also means the one-time
   * notification Codex replays immediately after `thread/resume` (carrying
   * the PRE-resume thread's last notification, tagged with the OLD turn id)
   * is dropped rather than folded into this run's usage.
   */
  private retainedUsage: SubagentUsage | undefined

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
   * Create the run's private thread and retain its identity. Pins `sandbox`
   * from the fixed delegation-time permission scope and `approvalPolicy:
   * 'never'` explicitly, rather than inheriting whatever
   * `~/.codex/config.toml` the host happens to have (both are non-experimental
   * app-server 0.147.0 parameters).
   * @param cwd - parent Session workspace.
   * @param permissionMode - the child's fixed permission scope, mapped to `sandbox`.
   * @param signal - unpublished-start cancellation.
   * @param persistent - opt-in request that the thread outlive this run
   *   (`ephemeral: false`), so a later call can `resumeThread` it. Default
   *   `false`: every call site predating this parameter keeps today's
   *   `ephemeral: true` behavior unchanged.
   */
  async startThread(cwd: string, permissionMode: SubagentPermissionMode, signal: AbortSignal, persistent = false): Promise<void> {
    const response = object(await this.guarded(this.transport.request('thread/start', {
      cwd,
      ephemeral: !persistent,
      sandbox: codexSandbox(permissionMode),
      approvalPolicy: 'never',
    }, signal), signal), 'thread/start response')
    const thread = object(response.thread, 'thread/start thread')
    const id = string(thread.id, 'thread/start thread id')
    if (thread.ephemeral !== !persistent) {
      throw new Error(`subagent-codex: app-server created a thread with ephemeral=${String(thread.ephemeral)}, expected ${String(!persistent)}`)
    }
    this.threadId = id
    this.persistent = persistent
  }

  /**
   * Resume a previously persistent thread in a FRESH process (a distinct
   * `CodexAppServerWire`/app-server connection from the one that created it —
   * this is the whole point of a resumable thread). Re-pins `sandbox` and
   * `approvalPolicy: 'never'` on every resume rather than trusting whatever
   * policy the persisted thread happened to store (the same principle
   * {@link startThread} already applies at creation): a resumed thread never
   * silently inherits a wider scope than THIS call's own fixed permission
   * mode. `threadId` is ALREADY authorized for this exact `(provider,
   * permissionMode, cwd)` scope by `SubagentRuntime.start`'s session-log check
   * before this method is ever called — this wire never re-verifies it.
   * @param threadId - the resume id from a prior {@link SubagentResult.resumeId}.
   * @param permissionMode - the child's fixed permission scope, mapped to `sandbox`.
   * @param signal - unpublished-start cancellation.
   * @throws {ClassifiedSubagentFailure} `code: 'provider'` when the app-server
   *   rejects the resume (measured: `-32600 "no rollout found for thread id
   *   <id>"` for an id the app-server's own store does not recognize).
   */
  async resumeThread(threadId: string, permissionMode: SubagentPermissionMode, signal: AbortSignal): Promise<void> {
    let response: JsonObject
    try {
      response = object(await this.guarded(this.transport.request('thread/resume', {
        // Measured: camelCase `threadId` — the Rust source field name
        // `thread_id` fails with `-32600 "missing field threadId"`.
        threadId,
        sandbox: codexSandbox(permissionMode),
        approvalPolicy: 'never',
      }, signal), signal), 'thread/resume response')
    } catch (error: unknown) {
      if (error instanceof JsonRpcResponseError) {
        const message = `subagent-codex: app-server could not resume the requested thread: ${error.message}`
        throw new ClassifiedSubagentFailure(message, { code: 'provider', message })
      }
      throw error
    }
    const thread = object(response.thread, 'thread/resume thread')
    const id = string(thread.id, 'thread/resume thread id')
    if (id !== threadId) {
      throw new Error('subagent-codex: app-server resumed a different thread than requested')
    }
    this.threadId = id
    this.persistent = true
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
      return { output: this.collectOutput(), stopReason: 'max-tokens', ...this.resultExtras() }
    }
    if (status !== 'completed') {
      if (status === 'failed') throw this.classifiedTurnFailure(terminal)
      throw new Error(`subagent-codex: Codex turn ended with status ${String(status)}`)
    }
    const output = this.collectOutput()
    if (output.length === 0) {
      throw new Error('subagent-codex: Codex completed without a final answer')
    }
    return { output, stopReason: 'completed', ...this.resultExtras() }
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

  /**
   * `changedFiles`/`usage`/`resumeId` for a `completed` or `max-tokens`
   * result, omitted (not empty-valued) when nothing was observed — the common
   * read-only, non-resumable-run case reports none of these keys at all.
   * `resumeId` reports the wire's OWN {@link threadId} (never a model-supplied
   * value) only when {@link persistent} is true.
   */
  private resultExtras(): Pick<SubagentResult, 'changedFiles' | 'usage' | 'resumeId'> {
    return {
      ...this.changedFilePaths.size > 0 ? { changedFiles: [...this.changedFilePaths] } : {},
      ...this.retainedUsage !== undefined ? { usage: this.retainedUsage } : {},
      ...this.persistent && this.threadId !== undefined ? { resumeId: this.threadId } : {},
    }
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

  /**
   * Record every path from a `completed`-status `fileChange` item. A
   * `declined`/`failed`/`inProgress` item is silently skipped — this is not a
   * protocol deviation, just a change that did not (yet, or ever) happen
   * (measured: see the Agent Note). `turn/diff/updated` (also observed on the
   * real app-server) is deliberately not used: it carries an unstructured
   * unified-diff blob for the whole turn, while this per-item, per-path,
   * status-qualified shape is what {@link SubagentResult.changedFiles}
   * actually needs.
   */
  private observeFileChange(item: JsonObject): void {
    if (item.status !== 'completed') return
    const changes = item.changes
    if (!Array.isArray(changes)) {
      const message = 'subagent-codex: app-server returned invalid fileChange changes'
      throw new ClassifiedSubagentFailure(message, { code: 'protocol', message })
    }
    for (const change of changes) {
      const record = object(change, 'item/completed fileChange change')
      this.changedFilePaths.add(string(record.path, 'item/completed fileChange path'))
    }
  }

  /**
   * Accumulate this notification's `last` (this individual model call's own
   * declared usage, never cumulative — see {@link retainedUsage}) into the
   * running sum for the CURRENT turn. Only called for a notification already
   * scoped to {@link turnId} by {@link handleNotification} (mirroring
   * {@link observeFileChange}'s turn scoping), so this never sums across two
   * different turns.
   */
  private observeTokenUsage(params: JsonObject): void {
    const tokenUsage = object(params.tokenUsage, 'thread/tokenUsage/updated tokenUsage')
    const last = object(tokenUsage.last, 'thread/tokenUsage/updated tokenUsage.last')
    const increment: SubagentUsage = {
      inputTokens: number(last.inputTokens, 'thread/tokenUsage/updated tokenUsage.last.inputTokens'),
      outputTokens: number(last.outputTokens, 'thread/tokenUsage/updated tokenUsage.last.outputTokens'),
      cacheReadTokens: number(last.cachedInputTokens, 'thread/tokenUsage/updated tokenUsage.last.cachedInputTokens'),
      cacheWriteTokens: number(last.cacheWriteInputTokens, 'thread/tokenUsage/updated tokenUsage.last.cacheWriteInputTokens'),
    }
    const retained = this.retainedUsage
    this.retainedUsage = retained === undefined ? increment : {
      inputTokens: retained.inputTokens + increment.inputTokens,
      outputTokens: retained.outputTokens + increment.outputTokens,
      cacheReadTokens: retained.cacheReadTokens + increment.cacheReadTokens,
      cacheWriteTokens: retained.cacheWriteTokens + increment.cacheWriteTokens,
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
      if (item.type === 'fileChange') {
        this.observeFileChange(item)
        return
      }
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
    if (method === 'thread/tokenUsage/updated') {
      const threadId = string(params.threadId, 'thread/tokenUsage/updated thread id')
      if (threadId !== this.threadId) return
      // Turn-scoped like `item/completed`, but deliberately WITHOUT
      // `observePendingTurnId`'s cross-check: a resumed thread replays its
      // pre-resume state as one `thread/tokenUsage/updated` notification
      // carrying the OLD turn's id, arriving before this process's own
      // `turn/start` call (measured, see the Agent Note). Calling
      // `observePendingTurnId` here would retain that stale id as
      // `pendingTurnId` and then throw once `turn/start`'s own response
      // arrives with the real (different) turn id ("referenced conflicting
      // turns"). Queuing unconditionally and re-checking the turn id only
      // once `commitTurnId` replays this notification is what lets the stale
      // notification simply drop by id mismatch instead.
      if (this.turnId === undefined) {
        if (this.turnCompleted !== undefined) this.earlyTurnNotifications.push({ method, params })
        return
      }
      const id = string(params.turnId, 'thread/tokenUsage/updated turn id')
      if (id !== this.turnId) return
      this.observeTokenUsage(params)
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
