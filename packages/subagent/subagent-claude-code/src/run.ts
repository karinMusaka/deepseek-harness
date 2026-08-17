/**
 * One-shot Claude Code lifecycle: invoke the official Agent SDK, place its
 * real CLI process under the shared subprocess owner, map only strict SDK
 * success to completion, and dispose to whole-tree quiescence.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code/run
 */

import { randomUUID } from 'node:crypto'
import {
  query as officialQuery,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type Query,
  type SDKAssistantMessageError,
  type SDKMessage,
  type SDKResultMessage,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'
import { assertNever } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  ClassifiedSubagentFailure,
  settleRunResult,
  subprocessRunHandle,
  type SubagentFailureCode,
  type SubagentPermissionMode,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import {
  scrubbedParentEnv,
  type SubprocessHandle,
  type SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  claudeSpawnSpec,
  ManagedClaudeCodeProcess,
} from './process.ts'

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/* jscpd:ignore-start -- sibling providers intentionally keep product-private
 * run inputs and error normalization instead of adding a shared lifecycle owner. */
/** Fully resolved inputs for one official Claude Agent SDK query. */
export interface ClaudeCodeRunSpec {
  /** Parent Session workspace supplied to the SDK and real CLI. */
  readonly cwd: string
  /**
   * Permission scope fixed for this child, resolved from
   * `SubagentStartRequest.permissionMode` (already defaulted to `read-only` by
   * the provider). Enforced by {@link fixedCanUseTool}'s allowlist.
   */
  readonly permissionMode: SubagentPermissionMode
  /** Exact native Claude Code executable resolved from the host PATH. */
  readonly executable: string
  /** Explicit deployment/test environment layered after shared scrubbing. */
  readonly env: Record<string, string>
  /**
   * How this child authenticates, derived purely from {@link env} by the
   * provider (`Config.env` setting a credential-shaped variable name means
   * `'api-key'`) — never by reading `~/.claude`. Attached to every settled
   * result.
   */
  readonly authMode?: SubagentResult['authMode']
  /** Subprocess termination grace passed to the shared process-tree owner. */
  readonly disposeGraceMs: number
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Diagnostic sink for a post-publication error flattened into a result. */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed SDK and subprocess failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}
/* jscpd:ignore-end */

/**
 * Validate and preserve the one-shot task before crossing the SDK boundary.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact text sequence as one SDK prompt.
 */
export function textTask(prompt: readonly ContentBlock[]): string {
  if (prompt.length === 0) {
    throw new Error('subagent-claude-code: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-claude-code: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('subagent-claude-code: the one-shot task must not be empty')
  }
  return texts.join('')
}

/**
 * Fields read directly off an `SDKResultMessage`, bypassing its own `subtype`
 * discriminant. Measured against Claude Agent SDK 0.3.220 with no credential
 * configured: a real logged-out run reports `is_error: true` while `subtype`
 * stays `'success'` (see the Agent Note) — narrowing through the union's own
 * discriminant would silently classify that run as successful. Classify from
 * `is_error`/`terminal_reason`/`api_error_status` instead, never `subtype`.
 */
export interface ClaudeResultFields {
  readonly isError: boolean
  readonly terminalReason: string | undefined
  readonly apiErrorStatus: number | null
  readonly resultText: string | undefined
  readonly errors: string[] | undefined
}

/**
 * Read {@link ClaudeResultFields} off a result message without trusting its
 * `subtype` discriminant.
 * @param message - an official discriminated result union member.
 * @returns the fields this module classifies on.
 */
export function resultFields(message: SDKResultMessage): ClaudeResultFields {
  const record = message as unknown as Record<string, unknown>
  return {
    isError: record.is_error === true,
    terminalReason: typeof record.terminal_reason === 'string' ? record.terminal_reason : undefined,
    apiErrorStatus: typeof record.api_error_status === 'number' ? record.api_error_status : null,
    resultText: typeof record.result === 'string' ? record.result : undefined,
    errors: Array.isArray(record.errors)
      ? record.errors.filter((entry): entry is string => typeof entry === 'string')
      : undefined,
  }
}

/**
 * Map one `SDKAssistantMessageError` to the seam's closed failure vocabulary.
 * The enum is external and open (a future SDK release may add a value):
 * an unrecognized future value falls through to `'provider'`, never
 * `assertNever` — that guard is reserved for a closed {@link SubagentFailureCode}
 * switch, not this open external enum.
 * @param error - the assistant message's own classified cause.
 * @returns the seam failure code, or `undefined` when the value is not a
 *   terminal-failure signal (`max_output_tokens` notes a per-message
 *   truncation, not a run-ending cause).
 */
export function classifyAssistantError(error: SDKAssistantMessageError): SubagentFailureCode | undefined {
  switch (error) {
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
      return 'auth'
    case 'rate_limit':
    case 'billing_error':
    case 'overloaded':
      return 'quota'
    case 'max_output_tokens':
      return undefined
    case 'invalid_request':
    case 'model_not_found':
    case 'server_error':
    case 'unknown':
      return 'provider'
    default:
      return 'provider'
  }
}

/**
 * Classify a terminal result already known to have `is_error: true`. Prefers
 * the most specific cause retained from the run's own assistant messages (the
 * pinned SDK's clean `SDKAssistantMessageError` enum) over the result
 * message's own `api_error_status`, and falls back to `'provider'` when
 * neither signal narrows further. `'protocol'` never applies here: the SDK
 * abstracts its own wire transport entirely (see the package README's Known
 * Limitations).
 * @param fields - the terminal result's own fields.
 * @param retainedAssistantClass - the most specific classifiable assistant
 *   error seen so far this run, if any.
 * @returns the classified failure code.
 */
export function classifyClaudeFailure(
  fields: ClaudeResultFields,
  retainedAssistantClass: SubagentFailureCode | undefined,
): SubagentFailureCode {
  if (retainedAssistantClass !== undefined) return retainedAssistantClass
  if (fields.apiErrorStatus === 401) return 'auth'
  if (fields.apiErrorStatus === 429) return 'quota'
  return 'provider'
}

/**
 * The provider's own actionable text for a terminal failure: the result's own
 * text when present (e.g. `"Not logged in · Please run /login"`, already
 * usable as-is), else joined `errors`, else a generic fallback naming the
 * terminal reason.
 * @param fields - the terminal result's own fields.
 * @returns non-empty diagnostic text.
 */
export function claudeFailureMessage(fields: ClaudeResultFields): string {
  if (fields.resultText !== undefined && fields.resultText.trim().length > 0) return fields.resultText
  if (fields.errors !== undefined && fields.errors.length > 0) return fields.errors.join('; ')
  return `subagent-claude-code: Claude Code failed (${fields.terminalReason ?? 'unknown reason'})`
}

/**
 * Consume the complete SDK stream and require one strict success plus normal
 * iterator completion. Classifies from {@link resultFields}, never `subtype`.
 * @param query - published official SDK query.
 * @returns the completed shared result.
 */
export async function consumeClaudeQuery(
  query: AsyncIterable<SDKMessage>,
): Promise<SubagentResult> {
  let answer: string | undefined
  let retainedAssistantClass: SubagentFailureCode | undefined
  for await (const message of query) {
    if (message.type === 'assistant' && message.error !== undefined) {
      const classified = classifyAssistantError(message.error)
      if (classified !== undefined) retainedAssistantClass = classified
      continue
    }
    if (message.type !== 'result') continue
    const fields = resultFields(message)
    if (!fields.isError) {
      if (fields.resultText !== undefined && fields.resultText.trim().length > 0) {
        answer = fields.resultText
        continue
      }
      throw new Error('subagent-claude-code: Claude Code succeeded but returned no answer')
    }
    const code = classifyClaudeFailure(fields, retainedAssistantClass)
    const failureText = claudeFailureMessage(fields)
    throw new ClassifiedSubagentFailure(failureText, { code, message: failureText })
  }
  if (answer === undefined) {
    throw new Error('subagent-claude-code: Claude Code ended without a result')
  }
  return {
    output: [{ type: 'text', text: answer }],
    stopReason: 'completed',
  }
}

/**
 * Close the official query, terminate the managed process tree, and wait for
 * the subprocess owner to prove it is gone.
 * @param query - official SDK query, when creation reached that point.
 * @param child - shared-service handle that owns the CLI process tree.
 */
export async function disposeClaudeCodeChild(
  query: Pick<Query, 'close'> | undefined,
  child: SubprocessHandle,
): Promise<void> {
  const failures: Error[] = []
  try {
    query?.close()
  } catch (error: unknown) {
    failures.push(thrown(error))
  }

  if (child.pid > 0) {
    child.terminate()
    try {
      await child.waitForExit()
    } catch (error: unknown) {
      failures.push(thrown(error))
    }
  }
  try {
    await child.done
  } catch (error: unknown) {
    failures.push(thrown(error))
  }

  const firstFailure = failures[0]
  if (failures.length === 1 && firstFailure !== undefined) throw firstFailure
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'subagent-claude-code: query and process cleanup failed',
    )
  }
}

/**
 * Read-only tool names, verified against the pinned SDK's `sdk-tools.d.ts`
 * tool input interfaces (`FileReadInput` → `Read`, `GlobInput` → `Glob`,
 * `GrepInput` → `Grep`, `WebFetchInput` → `WebFetch`, `WebSearchInput` →
 * `WebSearch`). An allowlist, not a denylist: a denied `Write` attempt was
 * observed routing around `disallowedTools` through `Bash` in the same run
 * (see the Agent Note), so an unlisted tool — including one this pin does not
 * yet know about — stays denied by default instead of failing open.
 */
const READ_ONLY_ALLOWED_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'])

/** `read-only`'s allowlist plus the write-capable tools `workspace-write` admits. */
const WORKSPACE_WRITE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  ...READ_ONLY_ALLOWED_TOOLS,
  'Write',
  'Edit',
  'NotebookEdit',
  'Bash',
])

/** Resolve the fixed allowlist for one permission scope. */
function allowedToolsFor(permissionMode: SubagentPermissionMode): ReadonlySet<string> {
  switch (permissionMode) {
    case 'read-only':
      return READ_ONLY_ALLOWED_TOOLS
    case 'workspace-write':
      return WORKSPACE_WRITE_ALLOWED_TOOLS
    /* v8 ignore next 2 -- closed-union exhaustiveness guard */
    default:
      return assertNever(permissionMode, 'allowedToolsFor')
  }
}

/**
 * Build the fixed `canUseTool` enforcing one permission scope: default DENY,
 * allow only the scope's fixed tool-name allowlist. Requires
 * `settingSources: []` in the same {@link Options} — without it, a host
 * Claude settings file that pre-approves a tool skips the permission decision
 * entirely and this callback is never invoked (see the Agent Note).
 * @param permissionMode - the child's fixed permission scope.
 * @returns the SDK `canUseTool` callback.
 */
function fixedCanUseTool(permissionMode: SubagentPermissionMode): CanUseTool {
  const allowed = allowedToolsFor(permissionMode)
  return (toolName: string): Promise<PermissionResult> => Promise.resolve(
    allowed.has(toolName)
      ? { behavior: 'allow' }
      : {
        behavior: 'deny',
        message: `subagent-claude-code: "${toolName}" is outside the delegated child's fixed "${permissionMode}" permission scope`,
      },
  )
}

/**
 * Build the fixed official SDK options for one one-shot provider run.
 * @param spec - Workspace, environment, process service, and disposal policy.
 * @param controller - per-run cancellation owner.
 * @param capture - receives the real managed child synchronously from the SDK hook.
 * @returns options that inherit native settings while disabling persistence, user
 *   questions, and host settings, and enforcing the fixed permission scope.
 */
export function claudeQueryOptions(
  spec: ClaudeCodeRunSpec,
  controller: AbortController,
  capture: (child: SubprocessHandle) => void,
): Options {
  return {
    abortController: controller,
    cwd: spec.cwd,
    pathToClaudeCodeExecutable: spec.executable,
    env: { ...scrubbedParentEnv(), ...spec.env },
    persistSession: false,
    // The child's world is fixed at delegation: host CLAUDE.md, MCP servers,
    // and permission pre-approvals from `~/.claude/settings.json` and project
    // settings must never leak in and drift what an identical delegation does.
    settingSources: [],
    permissionMode: 'default',
    disallowedTools: ['AskUserQuestion'],
    canUseTool: fixedCanUseTool(spec.permissionMode),
    spawnClaudeCodeProcess: (options: SpawnOptions) => {
      const child = spec.spawn(claudeSpawnSpec(options, spec.disposeGraceMs))
      capture(child)
      return new ManagedClaudeCodeProcess(child)
    },
  }
}

/**
 * Start one official Claude Agent SDK query and publish its one-shot run.
 * @param request - resolved shared subagent request.
 * @param spec - Workspace, environment, process service, and diagnostic policy.
 * @returns the published run after both Query and real CLI handle exist.
 */
export async function startClaudeCodeRun(
  request: SubagentStartRequest,
  spec: ClaudeCodeRunSpec,
): Promise<SubagentRun> {
  const prompt = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error('subagent-claude-code: request was aborted before SDK startup')
  }

  const controller = new AbortController()
  const requestCancel = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('subagent-claude-code: run cancelled locally'))
    }
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  let child: SubprocessHandle | undefined
  let query: Query | undefined
  try {
    query = officialQuery({
      prompt,
      options: claudeQueryOptions(spec, controller, (captured) => {
        child = captured
      }),
    })
    if (child === undefined || child.pid <= 0) {
      throw new Error(
        'subagent-claude-code: official SDK did not publish a controllable Claude Code process',
      )
    }
    if (controller.signal.aborted) {
      throw new Error('subagent-claude-code: request was aborted before SDK startup')
    }
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    const cancelledBeforeCleanup = controller.signal.aborted
    requestCancel()
    if (child !== undefined) {
      try {
        await disposeClaudeCodeChild(query, child)
      } catch (disposeError: unknown) {
        throw new AggregateError(
          [thrown(error), thrown(disposeError)],
          'subagent-claude-code: startup failed and CLI cleanup also failed',
        )
      }
    } else if (query !== undefined) {
      try {
        query.close()
      } catch (disposeError: unknown) {
        throw new AggregateError(
          [thrown(error), thrown(disposeError)],
          'subagent-claude-code: startup failed and query cleanup also failed',
        )
      }
    }
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- the request can abort while process cleanup is awaited.
    if (cancelledBeforeCleanup || request.signal.aborted) {
      throw new Error('subagent-claude-code: request was aborted before SDK startup')
    }
    throw thrown(error)
  }

  const publishedQuery = query
  const publishedChild = child
  const result = settleRunResult({
    attempt: () => consumeClaudeQuery(publishedQuery),
    collectOutput: () => [],
    cancelled: () => controller.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
    authMode: spec.authMode,
  })

  return subprocessRunHandle({
    id: SessionId(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: () => disposeClaudeCodeChild(
      publishedQuery,
      publishedChild,
    ),
  })
}
