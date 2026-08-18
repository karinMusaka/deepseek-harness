/** Package-local scripted child boundary for deterministic tool-subagent tests. */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ClassifiedSubagentFailure } from '@deepseek-ai/dsh-subagent'
import type {
  SubagentCapabilities,
  SubagentFailureDetail,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
  SubagentStopReason,
  SubagentUsage,
} from '@deepseek-ai/dsh-subagent'

const DEFAULT_CAPABILITIES: SubagentCapabilities = {
  outputSchema: true,
  depthLimit: true,
  toolFilter: true,
  persona: true,
  permissionMode: false,
  resume: false,
}

/** Options for one scripted provider fixture. */
export interface Config {
  /** Registry name to register under. */
  name: string
  /** Final text returned by the scripted child. */
  reply?: string
  /** Terminal result reason. */
  stopReason?: SubagentStopReason
  /** Start-time features advertised by the provider. */
  capabilities?: Partial<SubagentCapabilities>
  /** Whether tool descriptions say the child inherits completed turns. */
  inheritsParentContext?: boolean
  /** Structured value returned when the request asks for one. */
  structured?: unknown
  /** Classified failure detail attached to the result (only meaningful with `stopReason: 'error'`). */
  failure?: SubagentFailureDetail
  /** `authMode` attached to the result. */
  authMode?: SubagentResult['authMode']
  /** `changedFiles` attached to the result. */
  changedFiles?: readonly string[]
  /** `usage` attached to the result. */
  usage?: SubagentUsage
  /** Observes each start; the child's result additionally waits for the returned promise. */
  onStart?: (request: SubagentStartRequest) => Promise<void> | void
  /**
   * `resumeId` attached to the result when `request.requestResume` or
   * `request.resumeId` is set (requires `capabilities: { resume: true }`).
   * Receives the request so a scripted continuation can echo
   * `request.resumeId` back (simulating a provider-native thread that keeps
   * the SAME id across a resume) or mint a fresh one on first opt-in.
   */
  resumeId?: (request: SubagentStartRequest) => string
  /**
   * When set, `start()` rejects PRE-publication with a
   * {@link ClassifiedSubagentFailure} carrying this detail, instead of ever
   * returning a `SubagentRun` — simulates a native provider rejecting a
   * resume attempt (or any other startup call) before any thread/session is
   * ever published.
   */
  startThrows?: SubagentFailureDetail
}

/** Scripted provider whose result aborts if its signal or disposer wins first. */
class ScriptedSubagentProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities
  readonly inheritsParentContext: boolean

  constructor(
    readonly name: string,
    private readonly config: Config,
  ) {
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...config.capabilities }
    this.inheritsParentContext = config.inheritsParentContext ?? false
  }

  async start(request: SubagentStartRequest): Promise<SubagentRun> {
    if (request.signal.aborted) throw new Error('scripted subagent start aborted before publication')
    if (this.config.startThrows !== undefined) {
      throw new ClassifiedSubagentFailure(this.config.startThrows.message, this.config.startThrows)
    }
    const reply = this.config.reply ?? 'scripted subagent reply'
    const output: ContentBlock[] = [{ type: 'text', text: reply }]
    const wantsStructured = request.outputSchema !== undefined && this.capabilities.outputSchema
    const stopReason = this.config.stopReason ?? 'completed'
    const state = { cancelled: false }
    const onAbort = (): void => { state.cancelled = true }
    request.signal.addEventListener('abort', onAbort, { once: true })
    await Promise.resolve()
    if (state.cancelled) {
      request.signal.removeEventListener('abort', onAbort)
      throw new Error('scripted subagent start aborted before publication')
    }

    const wantsResume = request.requestResume === true || request.resumeId !== undefined
    const resumeId = wantsResume && this.config.resumeId !== undefined ? this.config.resumeId(request) : undefined
    const resultFor = (): SubagentResult => ({
      output,
      ...wantsStructured ? { structured: this.config.structured ?? { reply } } : {},
      stopReason: state.cancelled ? 'aborted' : stopReason,
      ...!state.cancelled && this.config.failure !== undefined ? { failure: this.config.failure } : {},
      ...this.config.authMode !== undefined ? { authMode: this.config.authMode } : {},
      ...!state.cancelled && this.config.changedFiles !== undefined ? { changedFiles: [...this.config.changedFiles] } : {},
      ...!state.cancelled && this.config.usage !== undefined ? { usage: this.config.usage } : {},
      ...!state.cancelled && resumeId !== undefined ? { resumeId } : {},
    })
    const gate = Promise.resolve(this.config.onStart?.(request))
    const result = gate.then(() => new Promise<SubagentResult>((resolve) => {
      setTimeout(() => { resolve(resultFor()) }, 0)
    })).finally(() => {
      request.signal.removeEventListener('abort', onAbort)
    })

    return {
      id: SessionId(`scripted-subagent:${this.name}:${request.parent.id}`),
      localAgent: undefined,
      result,
      dispose(): Promise<void> {
        state.cancelled = true
        request.signal.removeEventListener('abort', onAbort)
        return Promise.resolve()
      },
    }
  }
}

/**
 * Mount one scripted provider through an effect-scoped local plugin.
 * @param ctx - context carrying the real subagent registry.
 * @param config - scripted provider identity and outcome.
 * @returns the fixture plugin's disposable fiber.
 */
export function mountScriptedProvider(ctx: Context, config: Config) {
  return ctx.plugin({
    name: 'scripted-subagent-provider',
    inject: ['subagents'],
    apply(pluginCtx: Context): void {
      pluginCtx.subagents.registerProvider(new ScriptedSubagentProvider(config.name, config))
    },
  })
}
