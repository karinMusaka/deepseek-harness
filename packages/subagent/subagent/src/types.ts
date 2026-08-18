/**
 * The seam's consumer-facing contracts: request, result, and capability types
 * for {@link SubagentProvider}, plus the `subagent/start` and `subagent/end`
 * payloads that plugins and hosts observe. Internal control interfaces belong
 * with their implementation — the lifecycle observer in `./lifecycle.ts`, the
 * continuation host in `./continuation.ts` — so this module stays the published
 * surface rather than a bag of everything type-shaped.
 *
 * @module @deepseek-ai/dsh-subagent/types
 */

import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { ObjectJsonSchema, ToolRestriction } from '@deepseek-ai/dsh-tools'
import type { SubagentDescriptorData } from './descriptor.ts'

/** Identifies one accepted subagent run across its lifecycle event pair. */
export type SubagentRunId = Branded<'SubagentRunId'>

/**
 * Brand a string as a {@link SubagentRunId}.
 * @param id - the raw run id.
 * @returns the same string, branded.
 */
export function SubagentRunId(id: string): SubagentRunId {
  return id as SubagentRunId
}

/**
 * Observe-only identifying detail for a published subagent run, carried by
 * `subagent/start`. One-shot runs and continuable Activation epochs share this
 * payload, so an observer sees the same vocabulary for both.
 */
export interface SubagentRunInfo {
  /** Unique identity shared with the paired terminal event. */
  readonly runId: SubagentRunId
  /**
   * Provider name recorded when the child was first created. The provider may
   * be absent when an accepted one-shot run becomes ready or a persisted
   * Activation cold-resumes, because neither lifecycle depends on continued
   * registration.
   */
  readonly provider: string
  /** The child agent's id. */
  readonly id: SessionId
  /** Snapshot of whether `SubagentRun.localAgent` was present when start fulfilled. */
  readonly local: boolean
}

/**
 * Observe-only outcome detail for a settled subagent run, carried by
 * `subagent/end` and paired with one {@link SubagentRunInfo} by `runId`.
 */
export interface SubagentRunEndInfo {
  /** Unique identity shared with the paired start event. */
  readonly runId: SubagentRunId
  /** The same provider name carried by the paired start event. */
  readonly provider: string
  /** The child agent's id. */
  readonly id: SessionId
  /** Snapshot of whether `SubagentRun.localAgent` was present when start fulfilled. */
  readonly local: boolean
  /** The terminal stop reason. */
  readonly stopReason: SubagentResult['stopReason']
  /**
   * The child's final assistant output, selected by the same rule as
   * {@link SubagentResult.output}; absent on infrastructure rejection or when
   * the child produced none.
   */
  readonly lastAssistantMessage?: ContentBlock[]
}

/**
 * Which START-TIME features a provider supports. Checked by the service before delegating to
 * {@link SubagentProvider.start}: a request that needs a capability the chosen provider lacks
 * is rejected with a typed error rather than accepted-then-ignored (the "fail loud, no silent
 * degradation" rule). These flags describe the ONE-SHOT
 * {@link SubagentProvider.start} path, where the provider composes the child;
 * continuable children are composed by the continuation manager itself and are
 * gated by {@link SubagentProvider.prepareContinuable} instead. Each flag
 * corresponds one-to-one to a {@link SubagentStartRequest} option: `depthLimit`
 * to `maxDepth`; the other names match.
 */
export interface SubagentCapabilities {
  readonly outputSchema: boolean
  readonly depthLimit: boolean
  readonly toolFilter: boolean
  readonly persona: boolean
  readonly permissionMode: boolean
  /**
   * Whether this provider can keep a child's provider-native thread/session
   * alive past this run and resume it in a later call
   * ({@link SubagentStartRequest.requestResume}/{@link SubagentStartRequest.resumeId}).
   * An in-process provider shares the parent's own Cordis authority and has
   * no separate native thread to persist, so `spawn`/`fork`/`acp`/`dsh-sdk`
   * all declare `false`; `codex` and `claude-code` are the two providers with
   * a native resumable thread/session concept.
   */
  readonly resume: boolean
}

/**
 * Closed permission vocabulary for a child fixed at delegation. A widening
 * decision always belongs to the parent side ([pinned-approval Agent
 * Note](../../../../.agents/notes/implemented/feature/2026-08-10-subagent-approval-pinned-never.md)),
 * so this is never a model-facing tool argument — only a deployment (cordis.yml
 * or preset) selects it. Closed, not merge-extensible: widening the vocabulary
 * itself is the same parent-side decision the Note reserves.
 */
export type SubagentPermissionMode = 'read-only' | 'workspace-write'

/**
 * What a caller asks for when starting a ONE-SHOT subagent. The tool layer
 * builds this from the model's `{ description, prompt }` plus its own config;
 * the service validates {@link SubagentCapabilities} against the named provider
 * and resolves the durable descriptor before dispatching to
 * {@link SubagentProvider.start}.
 */
export interface SubagentStartRequest {
  /** Optional short display label persisted with a session-backed child. */
  readonly label?: string
  /** Content delivered as the child's user message. */
  readonly prompt: ContentBlock[]
  /**
   * The spawning agent. In-process providers derive workspace, lineage, and
   * delegation depth from its durable session state. ACP reads only its cwd,
   * and only when no deployment `cwd` override is configured.
   */
  readonly parent: Agent
  /**
   * Cancellation signal from the spawning context (the tool's `exec.signal`).
   * This is the canonical cancellation channel both before and after startup:
   * a provider rejects `start()` after cleaning partial resources when it
   * fires before the run is published, and cancels the published run's
   * remaining turn work when it fires afterward.
   */
  readonly signal: AbortSignal
  readonly agentOptions?: AgentOptions
  /**
   * Object-rooted JSON Schema within `assertObjectJsonSchema`'s enforced subset. Start rejects
   * unsupported schemas or providers without the capability. Data must be plain host-realm JSON;
   * a successful child returns the matching value as {@link SubagentResult.structured}.
   */
  readonly outputSchema?: ObjectJsonSchema
  /**
   * Optional absolute delegation-depth cap for the child being started: its
   * computed depth must be less than or equal to this non-negative safe
   * integer. Requires {@link SubagentCapabilities.depthLimit}; rejected at
   * start otherwise.
   */
  readonly maxDepth?: number
  /**
   * Optional child tool scoping. Requires {@link SubagentCapabilities.toolFilter};
   * rejected at start otherwise. In-process backends apply it as a scoped
   * `tools.restrict()` in the child's creation window: the named tools vanish
   * from the child's prompt AND refuse to execute (one visibility), with loud
   * unknown-name validation.
   */
  readonly toolFilter?: ToolRestriction
  /**
   * Optional per-child persona. Requires {@link SubagentCapabilities.persona};
   * rejected at start otherwise. In-process backends register it as a scoped
   * `deployment:persona` section on the child, SHADOWING the deployment's
   * persona for this child alone — same template semantics as the deployment
   * persona (strict `{{…}}` interpolation against the registered variables).
   */
  readonly persona?: string
  /**
   * Optional permission scope fixed for the child at delegation. Requires
   * {@link SubagentCapabilities.permissionMode}; rejected at start otherwise.
   * `read-only` forbids every write-capable operation; `workspace-write`
   * confines writes to the child's working directory. Absent means the
   * provider's own default, which every provider defines as `read-only`.
   */
  readonly permissionMode?: SubagentPermissionMode
  /**
   * Opt-in request that THIS run's provider-native thread/session remain
   * resumable after it ends, so a later call can continue it with
   * {@link resumeId}. Requires {@link SubagentCapabilities.resume}; rejected at
   * start otherwise. Ignored when {@link resumeId} is set (a resumed run is
   * already resumable by construction — see each provider's own behavior).
   * This is the model's own legitimate call to make: requesting continuation
   * is not a scope widening, unlike {@link permissionMode}, which only a
   * deployment may set ([Agent
   * Note](../../../../.agents/notes/implemented/feature/2026-08-18-subagent-delegation-resume.md)).
   * The deployment still gates whether this field is ever reachable at all
   * (`dsh-tool-subagent`'s `allowResume`, default `false`): the seam accepts
   * the field unconditionally when the provider supports it, and the
   * model-facing tool is what decides whether the parameter exists in the
   * first place.
   */
  readonly requestResume?: boolean
  /**
   * A resume id from a PRIOR run's {@link SubagentResult.resumeId}, naming the
   * provider-native thread/session to continue instead of starting fresh.
   * Requires {@link SubagentCapabilities.resume}; rejected at start otherwise.
   *
   * ★ SECURITY: this value is UNTRUSTED model output. The child inherits the
   * delegating process's `HOME`, so a provider's own thread/session store
   * (`~/.codex`, `~/.claude/projects/`) holds the USER's own private
   * conversations — resuming an unverified id would let a delegated model
   * load one of those into its own context. `SubagentRuntime.start` verifies
   * this id, BEFORE dispatching to the provider, against a same-harness
   * -session, same-scope issuance record derived from the session's own
   * event log (never an in-process-only cache — a harness session survives
   * process restarts). A provider's `start()` implementation never needs to
   * (and must not be relied on to) re-verify this field; by the time it is
   * called, the id is authorized for this exact `(provider, permissionMode,
   * cwd)` scope. See the [Agent
   * Note](../../../../.agents/notes/implemented/feature/2026-08-18-subagent-delegation-resume.md).
   */
  readonly resumeId?: string
}

/**
 * Provider-facing one-shot request after {@link SubagentRuntime.start} resolves
 * the durable child descriptor.
 */
export interface ResolvedSubagentStartRequest extends SubagentStartRequest {
  /** Detached descriptor a session-backed provider persists in the child log. */
  readonly descriptor: SubagentDescriptorData
}

/**
 * What the continuation manager asks a provider for while materializing one
 * continuable child's FIRST activation. The manager has already reserved the
 * durable child identity and owns every later operation, so this request
 * carries only what distinguishes a fresh child from one seeded with parent
 * history.
 */
export interface ContinuableCreateRequest {
  /** The reserved durable child session id, for provider diagnostics. */
  readonly sessionId: SessionId
  /** The delegating parent agent whose history a seeding provider reads. */
  readonly parent: Agent
  /**
   * Caller cancellation, which owns preparation only until the manager accepts
   * the initial prompt into the child's inbox.
   */
  readonly signal: AbortSignal
}

/**
 * A provider's detached contribution to one continuable child's creation. This
 * is DATA, never a capability: it carries no Agent, `AgentHandle`, prompt
 * delivery, result, disposal, or resume operation, because the continuation
 * manager owns the child's whole lifecycle after preparation.
 */
export interface ContinuableCreateSpec {
  /**
   * Completed-turn prefix of the parent's log to seed the child session with,
   * or absent for a fresh child. Same durable contract as
   * `CreateAgentOptions.seed`: contiguous from seq 0, lossless JSON, balanced.
   */
  readonly seed?: readonly SessionEvent[]
}

/**
 * Why a subagent run ended. Merge-extensible (a backend may add variants);
 * consumers branch on the known cases and fall through `default`. The known
 * cases mirror the harness turn-end vocabulary so the tool layer can map a
 * non-`completed` result to an `isError` tool result.
 */
export interface SubagentStopReasonMap {
  /** The child finished its turn normally. */
  completed: 'completed'
  /** Cancelled through the request signal or disposal. */
  aborted: 'aborted'
  /** Model or transport failure. */
  error: 'error'
  /** The child hit its token ceiling before finishing. */
  'max-tokens': 'max-tokens'
  /** The child declined the task. */
  refusal: 'refusal'
}

/** The union over {@link SubagentStopReasonMap} — widens automatically as backends merge in variants. */
export type SubagentStopReason = SubagentStopReasonMap[keyof SubagentStopReasonMap]

/**
 * Closed vocabulary for WHICH KIND of native product failure ended a run.
 * Orthogonal to {@link SubagentStopReasonMap}: stop reason answers "why did
 * the run end" (completed/aborted/error/…), this answers "what kind of
 * failure was it", and is meaningful only when {@link SubagentResult.stopReason}
 * is `'error'`. Closed, not merge-extensible — unlike {@link SubagentStopReason},
 * which a backend may widen, a provider maps its own product-specific error
 * vocabulary (Codex's `codexErrorInfo`, Claude's `SDKAssistantMessageError`)
 * onto these four buckets rather than this union growing per provider, so a
 * consumer switch over it stays exhaustive and MUST close with `assertNever`.
 */
export type SubagentFailureCode = 'auth' | 'quota' | 'provider' | 'protocol'

/**
 * One classified native product failure: a routable {@link SubagentFailureCode}
 * plus the provider's own actionable diagnostic text. A provider populating
 * this MUST have already screened `message` is not required here — screening
 * for credential-shaped text happens once, at the model-facing surface
 * (`dsh-tool-subagent`), not at every provider that can populate this field.
 */
export interface SubagentFailureDetail {
  /** Routable failure class; switch on this and close the default case with `assertNever`. */
  readonly code: SubagentFailureCode
  /** The provider's own actionable diagnostic text (e.g. "Not logged in · Please run /login"). */
  readonly message: string
}

/**
 * Token accounting common to both out-of-process product providers, using ONE
 * normalized meaning per field so a consumer never needs to know which
 * provider produced it. Measured against real Codex `thread/tokenUsage/updated`
 * and Claude `SDKResultMessage.usage` (see the
 * [Agent Note](../../../../.agents/notes/implemented/feature/2026-08-17-subagent-delegation-changed-files-and-usage.md)):
 * Codex's own `inputTokens` already INCLUDES its `cachedInputTokens` subset
 * (`totalTokens = inputTokens + outputTokens`), while Claude's own
 * `usage.input_tokens` EXCLUDES `cache_creation_input_tokens` and
 * `cache_read_input_tokens` (they are separate, additive counts). `inputTokens`
 * below is defined as the CACHE-INCLUSIVE total — Codex needs no adjustment;
 * Claude's three native fields are summed to reach it. Neither provider's
 * money field (Codex has none; Claude has `total_cost_usd`) is in this
 * contract — it is provider-specific, not a common meaning.
 */
export interface SubagentUsage {
  /**
   * Total input tokens the model processed for this run, INCLUSIVE of any
   * cache read or cache write portion counted in {@link cacheReadTokens} and
   * {@link cacheWriteTokens} below (both are subsets of this total, never
   * additional to it).
   */
  readonly inputTokens: number
  /** Output tokens the model produced. Provider-native; neither provider needs adjustment. */
  readonly outputTokens: number
  /** Of {@link inputTokens}, how many were served from a cache entry this run did not itself create. */
  readonly cacheReadTokens: number
  /** Of {@link inputTokens}, how many were newly written to a cache entry during this run. */
  readonly cacheWriteTokens: number
}

/**
 * The terminal outcome of a subagent run, resolved by {@link SubagentRun.result}.
 */
export interface SubagentResult {
  /**
   * The child's final assistant output is the content of its last non-empty
   * assistant message. Empty-content messages, including usage-only messages,
   * are skipped. Without a non-empty message, the output is its accumulated
   * assistant text stream, or `[]` when the child produced neither.
   */
  readonly output: ContentBlock[]
  /**
   * The structured result after a requested `outputSchema` was successfully
   * satisfied. Requesting a schema does not guarantee presence: a provider can
   * end with `stopReason: 'error'` when the child fails or finishes without a
   * valid capture. The structured value is validated against the requested
   * output schema by the provider; `unknown` here because the seam is
   * schema-agnostic.
   */
  readonly structured?: unknown
  /** Why the run ended. A non-`completed` reason means `output` may be partial. */
  readonly stopReason: SubagentStopReason
  /**
   * Classified native failure detail. Present only when {@link stopReason} is
   * `'error'` AND the provider could classify the cause from its own product's
   * diagnostics; absent on every other stop reason, on success, and on a
   * provider that has no classification for this failure (the stop reason
   * alone still reports the run as failed).
   */
  readonly failure?: SubagentFailureDetail
  /**
   * How the child authenticated with its own product backend: `'api-key'` when
   * the provider's deployment `Config.env` explicitly sets a credential-shaped
   * variable, `'subscription'` otherwise — derived purely from that
   * deployment configuration, never by reading a credential store file
   * (`~/.claude`, `~/.codex`). Present only for providers that compose a
   * distinct product identity out of process (`codex`, `claude-code`); absent
   * for an in-process provider, which shares the harness's own already
   * -authenticated LLM service and has no separate child identity to report.
   */
  readonly authMode?: 'subscription' | 'api-key'
  /**
   * Absolute paths of files the child actually wrote, created, or deleted
   * during this run, deduplicated, or absent when the provider observed none
   * (including every in-process provider, which never populates this field —
   * see below). Both out-of-process providers report ONLY a successful
   * change: Codex from an `item/completed` `fileChange` item whose own
   * `status` is `'completed'` (never a `declined`/`failed`/`inProgress` one);
   * Claude from a `Write`/`Edit`/`NotebookEdit` `tool_use` block whose
   * matching `tool_result` reports no error AND whose id is absent from
   * `SDKResultMessage.permission_denials` — a denied or failed call is never
   * reported (a naive `tool_use`-only collector would misreport a read-only
   * run as having written files; see the Agent Note). Claude resolves a
   * relative `tool_use` path against the child's own working directory before
   * reporting it (Claude's `file_path`/`notebook_path` argument can be
   * relative to the child's cwd despite the SDK's own type documentation
   * saying absolute — measured, see the Agent Note); Codex's `fileChange`
   * path already arrives absolute. Present only for a `completed` or
   * `max-tokens` result; an `aborted` or unclassified `error` result does not
   * carry partial file accounting (Known Limitations). A change a child made
   * through `Bash`/shell has no inspectable path argument and is never
   * reported by Claude; Codex's OS-level sandbox still captures a shell
   * write's effect as its own `fileChange` item.
   */
  readonly changedFiles?: readonly string[]
  /**
   * Token usage for THIS call, normalized to {@link SubagentUsage}'s common
   * meaning, or absent when the provider observed none. Present only for a
   * `completed` or `max-tokens` result (same scope as {@link changedFiles});
   * an `aborted` or unclassified `error` result does not carry partial usage
   * accounting (Known Limitations). Codex's `thread/tokenUsage/updated`
   * notification carries two distinct fields: `total` is the THREAD's
   * lifetime-cumulative usage (never resets across a `thread/resume`, so a
   * resumed call's own first notification already carries the prior call's
   * total baked in — measured, see the Agent Note) and `last` is the
   * individual model call's own usage, non-cumulative even within one turn.
   * This field sums each notification's `last` across the current turn only,
   * never reading `total` — the only construction that reports THIS call's
   * own usage correctly on both a fresh thread and a resumed one.
   */
  readonly usage?: SubagentUsage
  /**
   * Resume id for THIS run's provider-native thread/session, present only
   * when the run was opted into resumability ({@link
   * SubagentStartRequest.requestResume} or a successful {@link
   * SubagentStartRequest.resumeId} continuation) and the provider published
   * one. Always the PROVIDER's own reported identity (Codex's `thread.id`,
   * Claude's `session_id`) — never an echo of a model-supplied
   * {@link SubagentStartRequest.resumeId} — so a later resume request is
   * verified against what the provider actually created, not what the model
   * merely asked for. Pass this value back as {@link
   * SubagentStartRequest.resumeId} to continue this exact run. Absent for
   * every in-process provider and for an out-of-process provider that was not
   * asked to resume.
   */
  readonly resumeId?: string
}

/**
 * ONE-SHOT child handle returned after publication. Prompt submission, turn
 * work, and infrastructure faults after that boundary belong to {@link result}.
 * Consumers await that result and must always {@link dispose} to cancel
 * remaining work and reach quiescence. A run is one disposable foreground
 * delegation with one result; continuable conversations have no run — the
 * continuation manager holds their `AgentHandle` directly and orders every
 * turn through the child's own inbox.
 */
export interface SubagentRun {
  /**
   * Parent-scoped run id. For a local run, this MUST equal the published child
   * session id, whose `parentSession` records `request.parent.session.id`; a
   * remote provider mints an id unique in the parent namespace.
   */
  readonly id: SessionId
  /**
   * The exact published in-process child, or `undefined` for a remote run.
   * When present, its id is {@link id}; the provider retains no ownership
   * implication beyond the run's ordinary {@link dispose} contract.
   */
  readonly localAgent: Agent | undefined
  /**
   * Resolves with the child's terminal {@link SubagentResult} when the run
   * settles. Does NOT reject on a child-level failure — a model/transport
   * failure resolves with `stopReason: 'error'` so the consumer maps it to an
   * `isError` tool result. Rejects on an infrastructure fault the seam cannot
   * represent as a stop reason.
   */
  readonly result: Promise<SubagentResult>
  /**
   * Cancel remaining work, reach child quiescence, and release resources.
   * Idempotent.
   */
  dispose(): Promise<void>
}

/**
 * One registered transport for running child agents. Providers are trusted
 * same-process implementations; callers treat descriptors and returned values
 * as borrowed immutable data. The service may call one provider concurrently
 * for distinct children. Providers isolate operation-local mutable state; a
 * shared capacity controller may delay an operation but must not couple its
 * settlement or cleanup to a sibling.
 */
export interface SubagentProvider {
  /** Unique registry name (e.g. `spawn`, `fork`, `acp`). */
  readonly name: string
  /** The start-time features this provider supports (see {@link SubagentCapabilities}). */
  readonly capabilities: SubagentCapabilities
  /**
   * Whether the child sees the parent's completed-turn prefix. This is descriptive, not a
   * service-validated start capability: the model-facing tool derives truthful wording from it.
   * It says nothing about tool registration, injected services, or authority inheritance.
   */
  readonly inheritsParentContext: boolean
  /**
   * Establish a ONE-SHOT child and return its handle after publication.
   * The service has already validated that every requested start-time
   * capability is supported and resolved `request.descriptor`, so a
   * session-backed implementation appends that descriptor inside the child's
   * initial turn. Before fulfillment, the provider owns setup and cleans any
   * unpublished partial resources before rejecting. Ownership transfers on
   * fulfillment; subsequent turn or infrastructure failure settles through
   * the returned run. Distinct starts may overlap; cancellation, failure,
   * result settlement, and disposal remain independent for each run.
   */
  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>
  /**
   * OPTIONAL (continuable-creation capability): contribute the detached
   * creation inputs that distinguish this provider's continuable children —
   * only whether the child session is seeded with parent history. Method
   * presence IS the capability: the service rejects continuable starts on
   * providers without it, while a provider that has it may still serve
   * ordinary one-shot delegations.
   *
   * This is the provider's ONLY participation in a continuable child. The
   * continuation manager owns identity reservation, composition, Agent
   * creation, prompt delivery, cold resume, ownership, and disposal, so a
   * provider never sees the child's Agent, handle, turns, or teardown.
   * Distinct preparations may overlap; each follows its own signal and returns
   * data belonging only to `request.sessionId`.
   */
  prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>
}
