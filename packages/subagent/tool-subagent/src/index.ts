/**
 * Model-facing delegation through one configured `ctx.subagents` provider.
 * Provider lifecycle controls tool registration and context-sensitive schema
 * wording. Foreground calls always dispose the run after collection.
 * Background policy is selected by this plugin's configuration: one-shot
 * calls own a plain Task, while continuable calls use
 * `ctx.subagents.startContinuable()`.
 * @module @deepseek-ai/dsh-tool-subagent
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { assertNever } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import {
  assertPositiveFinite,
  assertSubagentMaxDepth,
  ClassifiedSubagentFailure,
  SubagentError,
  settleRun,
  SUBAGENT_RESUME_META_KEY,
} from '@deepseek-ai/dsh-subagent'
import type {
  SubagentFailureCode,
  SubagentFailureDetail,
  SubagentPermissionMode,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentUsage,
} from '@deepseek-ai/dsh-subagent'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import { SENSITIVE_ENV_PATTERN } from '@deepseek-ai/dsh-subprocess'
import { deadline, MAX_TIMER_DELAY_MS, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-system-prompt'

/**
 * Capability-owned code stamped on this tool's own {@link deadline} timer so
 * {@link timeoutOf} can tell its expiry apart from an outer cancellation that
 * happens to reach the same composed signal.
 */
const SUBAGENT_TIMEOUT_CODE = 'SUBAGENT_TIMEOUT'

/**
 * Model-facing headline for a run this tool's own timer stopped, phrased from
 * the model's perspective (no timer/signal/abort vocabulary) and mirroring
 * the sibling `max-tokens` headline in {@link stopReasonFailure}.
 * @param timeoutMs - the elapsed timer bound, in milliseconds.
 * @returns the stop-reason headline naming the configured limit in seconds.
 */
function timeoutHeadline(timeoutMs: number): string {
  return `subagent run hit its ${timeoutMs / 1000}s time limit before finishing`
}

/**
 * A label immediately followed by a `:` or `=` and a value, where the label
 * contains one of `scrubbedParentEnv`'s own credential-shaped substrings
 * (`KEY`/`PASSWORD`/`SECRET`/`TOKEN`, case-insensitive — {@link SENSITIVE_ENV_PATTERN}).
 * Matches the same vocabulary that keeps a real credential out of a spawned
 * child's environment, applied here to free-form provider diagnostic text
 * instead of an environment variable name.
 */
const CREDENTIAL_SHAPED_PAIR = new RegExp(
  String.raw`([\w-]*(?:${SENSITIVE_ENV_PATTERN.source})[\w-]*)(\s*[:=]\s*)(['"]?)([^\s,'"]+)\3`,
  'gi',
)

/**
 * Screen provider diagnostic text for a credential-shaped label/value pair
 * before it reaches model-visible output (and, through it, the session log).
 * This PR is the first to route native provider text into that log — see the
 * Agent Note. Redacts only the value half of a matched pair; the label and
 * surrounding text (including non-secret operational identifiers a real
 * provider message may carry, e.g. a request id) survive unchanged.
 * @param text - the provider's own diagnostic text.
 * @returns `text` with every credential-shaped value replaced by `[REDACTED]`.
 */
export function redactCredentialShapedText(text: string): string {
  return text.replace(CREDENTIAL_SHAPED_PAIR, (_match, label: string, separator: string, quote: string) =>
    `${label}${separator}${quote}[REDACTED]${quote}`)
}

/** Model-facing noun phrase plus the routable {@link SubagentError} code for one failure class. */
interface FailureClassPresentation {
  readonly noun: string
  readonly code: string
}

/**
 * Present one classified {@link SubagentFailureCode}. Closed union: every
 * variant is enumerated and the default falls through to `assertNever`, so an
 * unhandled future addition fails compilation at this switch, not silently at
 * runtime.
 * @param code - the classified failure code.
 * @returns the model-facing noun phrase and the code {@link SubagentError} carries.
 */
function failureClassPresentation(code: SubagentFailureCode): FailureClassPresentation {
  switch (code) {
    case 'auth':
      return { noun: 'subagent could not authenticate with its provider', code: 'SUBAGENT_AUTH' }
    case 'quota':
      return { noun: 'subagent hit its provider\'s usage limit', code: 'SUBAGENT_QUOTA' }
    case 'provider':
      return { noun: 'subagent\'s provider failed', code: 'SUBAGENT_PROVIDER' }
    case 'protocol':
      return { noun: 'subagent\'s provider violated its own protocol', code: 'SUBAGENT_PROTOCOL' }
    /* v8 ignore next 2 -- closed-union exhaustiveness guard */
    default:
      return assertNever(code, 'failureClassPresentation')
  }
}

/**
 * Render one classified native failure as model-facing text: the failure
 * class noun plus the provider's own actionable text, screened for
 * credential-shaped patterns.
 * @param failure - the settled result's classified failure detail.
 * @returns the headline text and the routable {@link SubagentError} code.
 */
function classifiedFailureHeadline(failure: SubagentFailureDetail): { headline: string; code: string } {
  const presentation = failureClassPresentation(failure.code)
  return {
    headline: `${presentation.noun}: ${redactCredentialShapedText(failure.message)}`,
    code: presentation.code,
  }
}

/**
 * Rethrow a rejected `ctx.subagents.start()` call, converting a classified
 * native failure to the same routable, redacted headline the post
 * -publication path already produces. Resuming an invalid/unknown id fails
 * PRE-publication for Codex (`thread/resume` rejects before any thread
 * exists — see the Agent Note), so this pre-publication catch needs the same
 * classification `stopReasonFailure`/`classifiedFailureHeadline` already give
 * a post-publication `SubagentResult.failure`. A `SubagentError` (e.g. this
 * seam's own fail-closed resume-scope rejection) passes through unchanged —
 * it is a harness-side rejection, not a native product failure, and is
 * already a routable `HarnessError`.
 * @param error - the rejection from `ctx.subagents.start()`.
 * @returns never — always throws.
 */
function rethrowStartupFailure(error: unknown): never {
  if (error instanceof ClassifiedSubagentFailure) {
    const { headline, code } = classifiedFailureHeadline(error.failure)
    throw new SubagentError(headline, code)
  }
  throw error
}

export const name = 'tool-subagent'
export const inject = ['tools', 'subagents', 'systemPrompt']

/** Prompt order after bounded delegation policy and before child reporting. */
const SUBAGENT_SECTION_ORDER = 116.5

/** Config: which registered provider this tool delegates to, plus child defaults. */
export interface Config {
  /** The `ctx.subagents` provider name to start runs on (e.g. `spawn`, `acp`). */
  provider: string
  /**
   * Model-facing tool name (default `subagent`). Each loaded instance must use
   * a distinct name.
   */
  toolName?: string
  /**
   * Expose `run_in_background` (default true). Disabled instances omit the
   * parameter and reject forced background calls.
   */
  enableRunInBackground?: boolean
  /**
   * Background execution policy (default `one-shot`). `one-shot` defaults calls
   * to foreground; `continuable` defaults them to background, requires a provider
   * with the `prepareContinuable` capability, and returns the durable child id.
   * Follow-up adapters remain independently optional.
   */
  backgroundMode?: 'one-shot' | 'continuable'
  /**
   * Agent options applied to every child; omitted fields use child-loop defaults.
   */
  agentOptions?: AgentOptions
  /**
   * Per-child persona that shadows `deployment:persona`. Requires the
   * provider's `persona` capability; omission preserves the deployment persona.
   */
  persona?: string
  /**
   * Tool filter applied to every child. Filtered tools disappear from its
   * prompt and reject execution. Requires the provider's `toolFilter`
   * capability; unknown names fail startup.
   */
  toolFilter?: {
    /** Global tool names the child keeps; everything else is removed. */
    allow?: string[]
    /** Global tool names removed from the child. */
    deny?: string[]
  }
  /**
   * Maximum child depth: a non-negative safe integer (default `3`; `0` forbids
   * delegation entirely), or `'provider-managed'` to send no cap. A numeric cap
   * requires the provider's `depthLimit` capability (mount fails loud
   * otherwise). The provider checks the calling agent's current depth at every
   * start; the tool remains model-visible so runtime policy owns rejection.
   * `'provider-managed'` is for an out-of-process provider whose recursion
   * budget belongs to the child runtime or its own deployment.
   */
  maxDepth?: number | 'provider-managed'
  /**
   * Fixed permission scope for every child this tool instance starts.
   * Requires the provider's `permissionMode` capability (mount fails loud
   * otherwise); omission leaves the provider's own default (every provider
   * defines that default as `read-only`), so `spawn`/`fork`/`acp`/`dsh-sdk`
   * compositions that never set this field are unaffected. `read-only`
   * forbids every write-capable operation; `workspace-write` confines writes
   * to the child's working directory. This is deployment configuration, never
   * a model-facing tool argument — a permission-widening decision belongs to
   * whoever writes the composition, not the delegating model.
   */
  permissionMode?: SubagentPermissionMode
  /**
   * Wall-clock cap, in seconds, on this instance's own runs: a positive
   * finite number no greater than {@link MAX_TIMER_DELAY_MS} in milliseconds.
   * Applies to a foreground call and a one-shot background call — both owned
   * by this tool, which starts the timer before `ctx.subagents.start()` so a
   * provider wedged during startup (an unauthenticated backend's slow retry
   * loop, for example) is bounded too. Omission preserves today's behavior:
   * no cap. Rejected at load with `backgroundMode: 'continuable'` — a
   * continuable child's turns are owned by the continuation manager, not this
   * tool, so there is no run here to time out. A caller's own cancellation
   * (the tool call's `exec.signal`) is unaffected and still reports as
   * cancelled, never as a timeout.
   */
  timeoutSeconds?: number
  /**
   * Allow a call to request that its run remain resumable, and to resume a
   * prior run by id (`resume`/`resume_id` tool arguments — absent from the
   * schema entirely when this is `false`). Requires the provider's `resume`
   * capability (mount fails loud otherwise). Default `false`: PR5 is an
   * OPT-IN addition, not a reversal of the shipped default — every existing
   * composition that never sets this stays exactly as before (Codex
   * `ephemeral: true`, Claude `persistSession: false`, no continuation
   * whatsoever). Requesting continuation is not a scope widening (unlike
   * {@link permissionMode}, a deployment-only field): the model choosing to
   * keep its own delegation resumable, or to continue one it already
   * received an id for, is the model's own legitimate call — but the
   * deployment still gates whether the parameter is ever reachable at all.
   * Rejected at load with `backgroundMode: 'continuable'` and at call time
   * for a background call (`run_in_background: true`): only a FOREGROUND
   * call logs the session-log issuance record a later resume is verified
   * against ([Agent
   * Note](../../../../.agents/notes/implemented/feature/2026-08-18-subagent-delegation-resume.md)),
   * so a background resumable run would persist a provider-native thread
   * with no way to ever resume it.
   */
  allowResume?: boolean
}

export const Config: z<Config> = z.object({
  provider: z.string().required(),
  toolName: z.string().default('subagent'),
  enableRunInBackground: z.boolean().default(true),
  backgroundMode: z.union(['one-shot', 'continuable'] as const).default('one-shot'),
  // Prevent Schemastery from materializing omitted agentOptions as `{}`.
  agentOptions: z.object({
    provider: z.string(),
    model: z.string(),
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  }).default(undefined as unknown as { provider: string; model: string; maxTokens: number }),
  persona: z.string(),
  // Preserve omission; Schemastery's `{ allow: [] }` default would deny every tool.
  toolFilter: z.object({
    allow: z.array(z.string()).default(undefined as unknown as string[]),
    deny: z.array(z.string()).default(undefined as unknown as string[]),
  }).default(undefined as unknown as { allow: string[]; deny: string[] }),
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed' as const)]).default(3),
  // No `.default(...)`: preserve omission (the `persona` idiom above) so a
  // provider without the `permissionMode` capability is unaffected unless the
  // deployer explicitly configures this field.
  permissionMode: z.union(['read-only', 'workspace-write'] as const),
  // No `.default(...)`: PR1 learned this the hard way for `permissionMode` —
  // a materialized default here would silently cut off every existing
  // `spawn`/`fork` composition's long-running delegations. Omission stays
  // `undefined` through the Loader, same as `persona`/`permissionMode` above.
  timeoutSeconds: z.number(),
  allowResume: z.boolean().default(false),
})

/** Render text blocks from the canonical JSON block array without trusting arbitrary values. */
function outputValueText(values: JsonValue[]): string {
  return values
    .filter((value): value is { type: 'text'; text: string } =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
      && value.type === 'text' && typeof value.text === 'string')
    .map(value => value.text)
    .join('')
}

/**
 * Model-facing note listing files the run changed, or `''` when the run
 * reported none — the common read-only-run case adds no noise to the result.
 * @param paths - the settled result's `changedFiles`, if any.
 * @returns the note text, prefixed with its own blank-line separator, or `''`.
 */
function renderChangedFilesNote(paths: string[] | undefined): string {
  if (paths === undefined || paths.length === 0) return ''
  return `\n\nFiles changed:\n${paths.map(path => `- ${path}`).join('\n')}`
}

/**
 * Model-facing token usage note, or `''` when the provider reported none.
 * @param usage - the settled result's `usage`, if any.
 * @returns the note text, prefixed with its own blank-line separator, or `''`.
 */
function renderUsageNote(usage: SubagentUsage | undefined): string {
  if (usage === undefined) return ''
  const cache = usage.cacheReadTokens > 0 || usage.cacheWriteTokens > 0
    ? ` (${usage.cacheReadTokens} cached read, ${usage.cacheWriteTokens} cached write)`
    : ''
  return `\n\nTokens used: ${usage.inputTokens} in, ${usage.outputTokens} out${cache}`
}

/**
 * Model-facing resume-id note, or `''` when the run reported none (the
 * default, non-opted-in case reports no key at all).
 * @param resumeId - the settled result's `resumeId`, if any.
 * @returns the note text, prefixed with its own blank-line separator, or `''`.
 */
function renderResumeNote(resumeId: string | undefined): string {
  if (resumeId === undefined) return ''
  return `\n\nResume id: ${resumeId} (pass resume_id: "${resumeId}" in a later call to continue this exact run)`
}

/** Settle pending startup without rejecting the task producer contract. */
async function settleStart(start: Promise<SubagentRun>, signal: AbortSignal): Promise<JobOutcome> {
  try {
    return await settleRun(await start)
  } catch (error: unknown) {
    // Product providers aggregate startup and rollback failures. Cancellation
    // must not turn a failed cleanup into a cleanly killed Job.
    return signal.aborted && !(error instanceof AggregateError)
      ? { status: 'killed' }
      : { status: 'failed', detail: String(error) }
  }
}

/** One non-`completed` stop reason's model-facing headline and, when classified, its routable code. */
interface StopReasonFailure {
  readonly headline: string
  /** Present only for a classified native failure (`result.failure`); routes through {@link SubagentError}. */
  readonly code?: string
}

/**
 * A non-`completed` stop reason means the child did not finish cleanly.
 * @param result - the child's terminal result.
 * @param deadlineSignal - this call's composed signal (`exec.signal` alone
 *   when `timeoutSeconds` is omitted, per {@link deadline}'s identity
 *   forwarding at `timeoutMs <= 0`). An `aborted` result carrying this tool's
 *   own {@link SUBAGENT_TIMEOUT_CODE} reason is this instance's timer, not the
 *   caller; every other `aborted` result — including a caller cancellation
 *   racing an armed timer — reports as cancelled.
 */
function stopReasonFailure(result: SubagentResult, deadlineSignal: AbortSignal): StopReasonFailure | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'aborted': {
      const timedOut = timeoutOf(deadlineSignal, SUBAGENT_TIMEOUT_CODE)
      return { headline: timedOut !== undefined ? timeoutHeadline(timedOut.timeoutMs) : 'subagent run was cancelled' }
    }
    case 'error':
      // `result.failure` is absent when the provider could not classify the
      // cause (e.g. a plain transport failure) — keep the prior unclassified
      // headline and no routable code for that case.
      return result.failure === undefined
        ? { headline: 'subagent run failed' }
        : classifiedFailureHeadline(result.failure)
    case 'max-tokens':
      return { headline: 'subagent run hit its token limit before finishing' }
    case 'refusal':
      return { headline: 'subagent declined the task' }
    // Merge-extensible union: a backend may add stop reasons. Treat an unknown
    // terminal reason as a failure rather than reporting partial output as success.
    default:
      return { headline: `subagent run ended abnormally (${String(result.stopReason)})` }
  }
}

/**
 * Append the child's preserved partial answer to a stop-reason error so a
 * truncated or cancelled child's real text still reaches the parent model.
 * @param error - the stop-reason headline.
 * @param output - the child's selected output (`SubagentResult.output`).
 * @returns the headline, extended with the partial text when any exists.
 */
function withPartialText(error: string, output: ContentBlock[]): string {
  const text = output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  return text.length === 0 ? error : `${error}\nPartial output before the run ended:\n${text}`
}

type ForegroundToolResult = {
  readonly kind: 'foreground'
  readonly runId: SubagentRun['id']
  readonly output: JsonValue[]
  /** Absolute paths the child changed, present only when non-empty (the common read-only case reports no key at all). */
  readonly changedFiles?: string[]
  /** Normalized token usage, present only when the provider reported any. */
  readonly usage?: SubagentUsage
  /** Resume id for this run's thread, present only when `allowResume` is configured and the provider returned one. */
  readonly resumeId?: string
  /**
   * This call's own resolved cwd, present only alongside {@link resumeId}.
   * NOT rendered to the model (see {@link renderResumeNote}) — carries the
   * scope `presentationMeta` needs to write the durable issuance record,
   * since a presenter has no access to the calling `exec`/`Agent`.
   */
  readonly resumeCwd?: string
}

/**
 * Collect and release one foreground run without letting disposal replace an
 * independent result failure.
 * @param run - the published run to await and dispose.
 * @param deadlineSignal - this call's composed signal, forwarded to
 *   {@link stopReasonFailure} so a timeout reports distinctly from a caller
 *   cancellation.
 * @param cwd - this call's resolved cwd, attached alongside a reported
 *   `resumeId` so `presentationMeta` can write the issuance record; absent
 *   when the parent session has no cwd (a request that also fails at the
 *   provider for the same reason before this ever matters).
 */
async function settleForegroundRun(run: SubagentRun, deadlineSignal: AbortSignal, cwd: string | undefined): Promise<ForegroundToolResult> {
  const [execution] = await Promise.allSettled([
    run.result.then((result): ForegroundToolResult => {
      const failure = stopReasonFailure(result, deadlineSignal)
      if (failure !== undefined) {
        // The registry converts this throw to isError; partial output is not
        // success, but the preserved partial answer still reaches the parent.
        // A classified native failure raises `SubagentError` so its routable
        // `code` reaches `ToolExecutionResult.error.info` (the existing
        // structured-error-taxonomy path); an unclassified stop reason keeps
        // the prior plain `Error`.
        const message = withPartialText(failure.headline, result.output)
        throw failure.code !== undefined ? new SubagentError(message, failure.code) : new Error(message)
      }
      return {
        kind: 'foreground',
        runId: run.id,
        // Content blocks already cross durable JSON boundaries elsewhere;
        // the registry performs the authoritative lossless snapshot here.
        output: result.output as unknown as JsonValue[],
        ...result.changedFiles !== undefined && result.changedFiles.length > 0
          ? { changedFiles: [...result.changedFiles] }
          : {},
        ...result.usage !== undefined ? { usage: result.usage } : {},
        ...result.resumeId !== undefined && cwd !== undefined
          ? { resumeId: result.resumeId, resumeCwd: cwd }
          : {},
      }
    }),
  ])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError(
        [execution.reason, disposal.reason],
        `subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`,
      )
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}

/**
 * Model-facing wording from the provider's conversation-history descriptor
 * ({@link SubagentProvider.inheritsParentContext}).
 * A fresh child needs a standalone prompt; a forked child already sees the
 * conversation's completed turns — telling the model to restate everything
 * (or, worse, that the child "does not see this conversation") would be false
 * for a fork.
 * @param inheritsConversation - whether the child's conversation is seeded
 *   with the parent's completed turns; this says nothing about tool, service,
 *   scope, or authority inheritance.
 * @returns the tool `description` and the `prompt` parameter description.
 */
function providerWording(inheritsConversation: boolean): { description: string; promptDescription: string } {
  if (inheritsConversation) {
    return {
      description:
        'Delegate a task to a subagent that inherits this conversation: a child agent seeded with all '
        + 'completed turns so far (it does not see the current in-flight turn). Use this when the subtask '
        + 'builds on this conversation\'s context — a follow-up analysis, '
        + 'a review, a continuation — without consuming this conversation\'s context for the work itself. '
        + 'You receive its result, not its intermediate steps.',
      promptDescription:
        'The task for the subagent. It already sees this conversation\'s completed turns, so build on them '
        + 'freely and state only what is new.',
    }
  }
  return {
    description:
      'Delegate a self-contained task to a subagent (a separate agent that works in its own context) '
      + 'to offload focused, independent work — research, a scoped '
      + 'implementation, an analysis — so it does not consume this conversation\'s context. The subagent '
      + 'returns its result, not its intermediate steps. Give it a '
      + 'complete, standalone prompt: it does not see this conversation.',
    promptDescription:
      'The complete, self-contained task for the subagent. It does not share this '
      + 'conversation\'s context, so include everything it needs.',
  }
}

interface DelegationRunRequest {
  readonly run_in_background?: boolean
}

interface DelegationRunSpec {
  readonly runInBackground: boolean
}

/** Resolve the model's optional scheduling request into one execution route. */
function resolveDelegationRun(
  request: DelegationRunRequest,
  options: { readonly backgroundEnabled: boolean; readonly continuable: boolean },
): DelegationRunSpec {
  if (!options.backgroundEnabled) {
    // The validator permits undeclared keys, so schema omission also needs
    // execution-time enforcement.
    if (request.run_in_background === true) {
      throw new Error('run_in_background is disabled for this tool instance (enableRunInBackground: false)')
    }
    return { runInBackground: false }
  }
  return {
    // Continuable work is independently scheduled unless the caller explicitly
    // needs the result before its next action. One-shot policy keeps its existing
    // foreground default because its background result requires Task collection.
    runInBackground: request.run_in_background ?? options.continuable,
  }
}

export function apply(ctx: Context, config: Config): void {
  // Direct apply() bypasses Schemastery's numeric constraints. A direct-apply
  // omission stays capless (the schema default only runs through the loader).
  if (config.maxDepth !== 'provider-managed') assertSubagentMaxDepth(config.maxDepth)
  // Reject an empty explicit filter at load instead of failing every delegation.
  if (config.toolFilter !== undefined && config.toolFilter.allow === undefined && config.toolFilter.deny === undefined) {
    throw new Error('tool-subagent: `toolFilter` is configured but names neither `allow` nor `deny` — remove the key or fill the filter')
  }
  const backgroundEnabled = config.enableRunInBackground !== false
  const continuable = (config.backgroundMode ?? 'one-shot') === 'continuable'
  // Direct apply() also bypasses the schema's `z.number()` type constraint
  // (but not its `.default()`, since there is none): validate here so a
  // misconfigured cap fails at load, the earliest resolvable point, instead
  // of at the first delegation's `deadline()` call.
  if (config.timeoutSeconds !== undefined) {
    assertPositiveFinite('tool-subagent', 'timeoutSeconds', config.timeoutSeconds)
    if (config.timeoutSeconds * 1000 > MAX_TIMER_DELAY_MS) {
      throw new Error(`tool-subagent: timeoutSeconds must be no greater than ${MAX_TIMER_DELAY_MS / 1000} seconds`)
    }
    // A continuable child's turns are owned by the continuation manager after
    // inbox acceptance, not this tool — there is no run here for a timer to
    // stop. Config-vs-config, fully self-contained: fail at load like the
    // empty-toolFilter check above, not at the first delegation.
    if (continuable) {
      throw new Error(
        'tool-subagent: `timeoutSeconds` cannot be combined with `backgroundMode: \'continuable\'` — '
        + 'a continuable child\'s turns are owned by the continuation manager, not this tool',
      )
    }
  }
  const allowResume = config.allowResume === true
  // A continuable child already has its own durable identity and turn
  // ordering owned by the continuation manager; this resume mechanism exists
  // for the one-shot foreground/background path this tool itself owns.
  // Config-vs-config, fully self-contained: fail at load, not at the first
  // delegation (same rule as `timeoutSeconds` above).
  if (allowResume && continuable) {
    throw new Error(
      'tool-subagent: `allowResume` cannot be combined with `backgroundMode: \'continuable\'` — '
      + 'a continuable child already has its own durable identity and turn ordering',
    )
  }
  const toolName = config.toolName ?? 'subagent'
  // Mirror provider lifecycle because sibling load order and HMR replacement
  // can change provider availability while this fiber remains active.
  let disposeTool: (() => void) | undefined
  const mount = (provider: SubagentProvider): void => {
    // A numeric cap the provider cannot enforce is a misconfiguration — fail at
    // mount (the earliest point the provider's capabilities are known), not on
    // the first delegation.
    if (typeof config.maxDepth === 'number' && !provider.capabilities.depthLimit) {
      throw new Error(
        `tool-subagent: provider "${provider.name}" cannot enforce maxDepth (no depthLimit capability) — `
        + 'set maxDepth: \'provider-managed\' to leave the recursion budget to the provider',
      )
    }
    // Configured only when the deployer explicitly names a scope; omission
    // never reaches this check, so it never fires for a plain `spawn`/`fork`
    // composition that leaves the provider's own default in place.
    if (config.permissionMode !== undefined && !provider.capabilities.permissionMode) {
      throw new Error(
        `tool-subagent: provider "${provider.name}" cannot enforce permissionMode (no permissionMode capability) — `
        + 'remove the key to leave the provider\'s own default in place',
      )
    }
    // Configured only when the deployer explicitly opts in; omission never
    // reaches this check, so it never fires for a plain `spawn`/`fork`/`acp`/
    // `dsh-sdk` composition.
    if (allowResume && !provider.capabilities.resume) {
      throw new Error(
        `tool-subagent: provider "${provider.name}" cannot enforce resume (no resume capability) — `
        + 'set allowResume: false (or remove the key) for this provider',
      )
    }
    const wording = providerWording(provider.inheritsParentContext)
    if (continuable && provider.prepareContinuable === undefined) {
      throw new Error(
        `tool-subagent: provider "${provider.name}" does not support \`backgroundMode: continuable\``,
      )
    }
    disposeTool = ctx.tools.register(defineTool({
      name: toolName,
      description: wording.description + (backgroundEnabled
        // The completion notice is the continuation service's own behavior, not
        // a separately installed capability, so this promise holds whenever the
        // continuable background path is reachable at all.
        ? continuable
          ? ' This tool runs in the background by default, immediately returns a durable subagent id, and keeps the child conversation available for later turns. When that run settles, the runtime sends the parent a notice containing its outcome and any final assistant message; `send_message` starts a later turn in the same child conversation. Set `run_in_background: false` only when your next action depends on receiving the result.'
          : ' This call waits for the result by default. Set `run_in_background: true` to return a job id; collect with `job_output` and stop with `job_kill`.'
        : ' This call waits for the subagent and returns its result.'),
      parameters: {
        description: {
          type: 'string',
          required: true,
          description: 'A short (3-5 word) description of the delegated task, for display.',
        },
        prompt: {
          type: 'string',
          required: true,
          description: wording.promptDescription,
        },
        ...backgroundEnabled ? {
          run_in_background: {
            type: 'boolean' as const,
            description: continuable
              ? 'Whether to run in the background and return a durable subagent id immediately. Defaults to true. Set false to wait for the result when your next action depends on it.'
              : 'Whether to run as a background job and return its id. Defaults to false; collect with job_output or stop with job_kill.',
          },
        } : {},
        // Byte-identical schema when the deployment has not opted in
        // (`allowResume: false`, the default): PR5 never changes what an
        // existing composition's model sees.
        ...allowResume ? {
          resume: {
            type: 'boolean' as const,
            description: 'Whether to keep this run\'s exact context available so a later call can continue it with resume_id. Ignored when resume_id is set (a continued run is already resumable).',
          },
          resume_id: {
            type: 'string' as const,
            description: 'A resume id from a prior call\'s result to continue that exact run (same context) instead of starting fresh. Only a resume id this tool itself returned earlier in this conversation is valid; only meaningful for a foreground call.',
          },
        } : {},
      },
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'background' },
                jobId: { type: 'string', required: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'continuable' },
                subagentId: { type: 'string', required: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'foreground' },
                runId: { type: 'string', required: true },
                output: { type: 'array', required: true, items: { type: 'json' } },
                // Optional: omitted entirely for the common case (a read-only
                // run, or a provider that observed no writes/usage) rather
                // than present-but-empty — see `renderChangedFilesNote`/
                // `renderUsageNote` below for the matching no-noise rendering.
                changedFiles: { type: 'array', items: { type: 'string' } },
                usage: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    inputTokens: { type: 'number', required: true },
                    outputTokens: { type: 'number', required: true },
                    cacheReadTokens: { type: 'number', required: true },
                    cacheWriteTokens: { type: 'number', required: true },
                  },
                },
                // Model-visible: the model needs this value back to pass as
                // `resume_id` on a later call. Present only when `allowResume`
                // is configured and the provider actually returned one.
                ...allowResume ? { resumeId: { type: 'string' } } : {},
                // NOT rendered to the model — carries this call's resolved cwd
                // for `presentationMeta` alone, so the durable issuance record
                // it writes is scope-bound without needing tool-call context
                // `presentationMeta` itself has no access to. See the Agent Note.
                ...allowResume ? { resumeCwd: { type: 'string' } } : {},
              },
            },
          ],
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.kind === 'background'
            ? `started background subagent job ${value.jobId}`
            : value.kind === 'continuable'
              ? `started subagent ${value.subagentId}`
              : outputValueText(value.output) + renderChangedFilesNote(value.changedFiles) + renderUsageNote(value.usage)
                + (allowResume ? renderResumeNote(value.resumeId) : ''),
        }],
        // Gated on `allowResume`, not unconditionally present: a conditional
        // SPREAD of `presentationMeta` into `output` defeats `defineTool`'s
        // `const O`/`execute()` generic inference (confirmed empirically —
        // every downstream `execute` type collapses to `never`), so this uses
        // a conditional EXPRESSION instead. `exactOptionalPropertyTypes`
        // still rejects a ternary whose false branch is the literal
        // `undefined` for an optional function property, so that one branch
        // alone is cast (`undefined as never`, assignable to anything,
        // without touching the true branch's contextual inference). The net
        // effect: when `allowResume` is false (the default), `defineTool`
        // omits `output.presentationMeta` from the built `ToolDefinition`
        // entirely (see `defineTool`'s own conditional spread), so
        // `tool/result.meta` stays fully absent — byte-identical to a
        // pre-PR5 subagent call. Only an `allowResume: true` deployment ever
        // stamps `meta.subagentResume`.
        presentationMeta: allowResume
          ? (_args, value) =>
            value.kind === 'foreground' && value.resumeId !== undefined && value.resumeCwd !== undefined
              ? {
                [SUBAGENT_RESUME_META_KEY]: {
                  id: value.resumeId,
                  provider: config.provider,
                  permissionMode: config.permissionMode ?? 'read-only',
                  cwd: value.resumeCwd,
                },
              }
              : null
          : undefined as never,
      },
      // Children never mutate the parent session; the one parent-owned write
      // (tasks.start) is a synchronous commutative insertion.
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const parent = exec.agent
        if (!parent) {
          // Non-agent callers provide no parent for delegation ownership.
          throw new Error('subagent tool requires a calling agent (exec.agent was undefined)')
        }

        const maxDepth = typeof config.maxDepth === 'number' ? config.maxDepth : undefined
        // The validator permits undeclared keys even when `allowResume` is
        // false, so schema omission also needs execution-time enforcement —
        // the same rule `resolveDelegationRun` already applies to
        // `run_in_background`.
        const requestResume = allowResume && args.resume === true
        const resumeId = allowResume ? args.resume_id : undefined
        const request = {
          label: args.description,
          prompt: [{ type: 'text', text: args.prompt }] as ContentBlock[],
          parent,
          ...config.agentOptions !== undefined ? { agentOptions: config.agentOptions } : {},
          ...config.persona !== undefined ? { persona: config.persona } : {},
          ...config.toolFilter !== undefined ? { toolFilter: config.toolFilter } : {},
          ...maxDepth !== undefined ? { maxDepth } : {},
          ...config.permissionMode !== undefined ? { permissionMode: config.permissionMode } : {},
          ...requestResume ? { requestResume: true } : {},
          ...resumeId !== undefined ? { resumeId } : {},
        }

        // `timeoutMs <= 0` is `deadline()`'s own no-timer sentinel: an omitted
        // `timeoutSeconds` forwards the upstream signal by identity, so the
        // omitted-cap path never allocates a timer or a distinct signal.
        const timeoutMs = config.timeoutSeconds !== undefined ? config.timeoutSeconds * 1000 : 0

        const runSpec = resolveDelegationRun(args, { backgroundEnabled, continuable })
        if (runSpec.runInBackground) {
          // Only a FOREGROUND call logs the session-log issuance record a
          // later resume is verified against (`presentationMeta` above runs
          // only for the registry's own top-level result path). A background
          // resumable run would persist a provider-native thread with no
          // record ever written for it to resume against — reject clearly
          // instead of silently starting an unresumable "resumable" run.
          if (requestResume || resumeId !== undefined) {
            throw new Error('resume/resume_id is only available for a foreground call (run_in_background: false)')
          }
          if (continuable) {
            // Resolves at inbox acceptance: the child owns its own turns from
            // there, so this call neither waits for nor collects a result.
            const started = await ctx.subagents.startContinuable({
              provider: config.provider,
              label: args.description,
              request,
              signal: exec.signal,
            })
            return { kind: 'continuable' as const, subagentId: started.childId }
          }
          const jobs = ctx.get('jobs')
          if (jobs === undefined) {
            throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
          }
          // One-shot background child: job preflight finishes before the
          // starter can spawn, and the task-owned signal covers startup. This
          // tool owns the one-shot background run exactly as it owns the
          // foreground run, so the configured cap applies here too; the
          // generic task surface has no timeout-specific report (`aborted`
          // settles as `killed` either way — see the package README).
          const id = jobs.start({
            kind: 'subagent',
            label: args.description,
            owner: parent,
            run: () => {
              const controller = new AbortController()
              const runDeadline = deadline(controller.signal, timeoutMs, SUBAGENT_TIMEOUT_CODE)
              const start = ctx.subagents.start(config.provider, { ...request, signal: runDeadline.signal })
              return {
                cancel: (reason?: string) => {
                  controller.abort(reason ?? 'background subagent task killed')
                },
                done: settleStart(start, runDeadline.signal).finally(() => { runDeadline[Symbol.dispose]() }),
                // No readOutput: the child session owns intermediate detail.
              }
            },
          })
          return { kind: 'background' as const, jobId: id }
        }

        // The timer starts before `ctx.subagents.start()`, not after it
        // resolves, so a provider wedged during startup (an unauthenticated
        // backend's slow retry loop, the motivating case) is bounded too.
        // `await settleForegroundRun(...)` (not a bare `return`) keeps this
        // `using` block open until settlement so the timer is not cleared
        // before it can fire.
        using runDeadline = deadline(exec.signal, timeoutMs, SUBAGENT_TIMEOUT_CODE)
        let run: SubagentRun
        try {
          run = await ctx.subagents.start(config.provider, {
            ...request,
            signal: runDeadline.signal,
          })
        } catch (error: unknown) {
          const timedOut = timeoutOf(runDeadline.signal, SUBAGENT_TIMEOUT_CODE)
          if (timedOut !== undefined) throw new Error(timeoutHeadline(timedOut.timeoutMs))
          rethrowStartupFailure(error)
        }
        return await settleForegroundRun(run, runDeadline.signal, parent.session.header.cwd)
      },
    }))
  }

  // Register listeners before checking presence so no synchronous change is missed.
  // TODO(subagent-dup-toolname): two waiting one-shot fibers configured with the
  // same toolName collide when their provider appears, and the duplicate-name
  // throw rolls back the provider registration. Continuable instances reserve
  // their prompt-section name during apply() and fail earlier. Add an intent
  // registry if the late one-shot collision occurs in a shipped composition.
  ctx.on('subagent/provider-added', (provider) => {
    if (provider.name === config.provider && disposeTool === undefined) mount(provider)
  })
  ctx.on('subagent/provider-removed', (name) => {
    if (name !== config.provider || disposeTool === undefined) return
    disposeTool()
    disposeTool = undefined
  })
  const present = ctx.subagents.getProvider(config.provider)
  if (present !== undefined) {
    mount(present)
  } else {
    // A backend fiber may activate later; a misspelled provider remains visible in this log.
    ctx.logger.info(`subagent provider "${config.provider}" not registered yet; the "${config.toolName ?? 'subagent'}" tool will register when it appears`)
  }
  if (backgroundEnabled && continuable) {
    // The section follows provider availability without its own manual
    // lifecycle: empty text is omitted from rendered prompts while the tool is
    // absent, and the registration itself stays owned by this plugin fiber.
    ctx.systemPrompt.section({
      name: `tool:${toolName}`,
      order: SUBAGENT_SECTION_ORDER,
      text: context => disposeTool === undefined || ctx.tools.get(toolName, context.scope) === undefined
        ? ''
        : `Use ${toolName} in the background by default. Start independent delegations together in one assistant message and continue useful work while they run. Set \`run_in_background: false\` only when your next action depends on that subagent's result. When a background run settles, the runtime sends you a notice containing its outcome and any final assistant message.`,
    })
  }
}
