/**
 * Model-facing memory tools over the durable cross-session `ctx.memory`
 * service. Gives the agent the ability to remember facts/preferences/
 * decisions about the user and the current project, and to recall them in
 * later sessions. A runtime-context contribution delivers the most relevant
 * stored memories as a logged user-role snapshot, re-emitted only when the
 * rendered recall changes, so memory is acted on without an explicit call.
 * @module @deepseek-ai/dsh-tool-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { MemoryKind, MemoryScope } from '@deepseek-ai/dsh-memory'
import { MemoryId as brandMemoryId } from '@deepseek-ai/dsh-memory'

export const name = 'tool-memory'
export const inject = ['memory', 'tools', 'systemPrompt']

/** Model-facing memory tool configuration. */
export interface Config {
  /** Maximum number of entries the runtime-context snapshot lists; `0` disables the snapshot. */
  contextLimit: number
  /** Upper bound applied to a model-requested `memory_recall` limit. */
  maxRecallLimit: number
}

/** Schemastery configuration for the memory tool consumer. */
export const Config: z<Config> = z.object({
  contextLimit: z.natural().default(10),
  maxRecallLimit: z.natural().min(1).default(50),
})

const KINDS: MemoryKind[] = ['fact', 'preference', 'decision', 'note']
const PROJECT_PREFIX = 'project:'

/** Project scope for one agent's current working directory. */
function projectScopeOf(agent: Agent): MemoryScope {
  const cwd = agent.session.header.cwd ?? process.cwd()
  return `${PROJECT_PREFIX}${cwd}`
}

/** The current project scope for one tool execution, or `undefined` outside an agent. */
function projectScopeOfExec(exec: ToolRunContext): MemoryScope | undefined {
  const agent = exec.agent
  return agent === undefined ? undefined : projectScopeOf(agent)
}

/**
 * The scopes one tool execution may read/modify: the current project (which
 * carries user memory too) in an agent context, otherwise personal memory only.
 */
function allowedScopesOfExec(exec: ToolRunContext): Set<string> {
  const project = projectScopeOfExec(exec)
  return new Set(project === undefined ? ['user'] : ['user', project])
}

/**
 * Whether this tool execution may touch an entry with the given scope. Callers
 * check only entries that exist; an unknown id reaches the service, which
 * reports it as absent.
 */
function scopeAllowed(exec: ToolRunContext, entryScope: string): boolean {
  return allowedScopesOfExec(exec).has(entryScope)
}

/** Compact text for one memory entry, shown to the model. */
function entryLine(entry: {
  id: string
  kind: MemoryKind
  scope: string
  content: string
  tags: string[]
}): string {
  const tags = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : ''
  return `- [${entry.kind}] ${entry.scope}${tags}: ${entry.content}  (id: ${entry.id})`
}

/** Generic, args-only presentation shared by the memory tools. */
function present(title: string, rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, ...rawInput === undefined ? {} : { rawInput } }
}

/** One memory row rendered as a text content block. */
function entryBlock(value: unknown): { type: 'text'; text: string } {
  return { type: 'text', text: JSON.stringify(value) }
}

/** Output for remember: id + scope + message. */
const REMEMBER_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      id: { type: 'string', required: true },
      scope: { type: 'string', required: true },
      message: { type: 'string', required: true },
    },
  } as const,
  render: (_args: unknown, value: unknown) => [entryBlock(value)],
}

/** Output for recall: memories array. */
const RECALL_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      memories: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            kind: { type: 'string', required: true },
            scope: { type: 'string', required: true },
            content: { type: 'string', required: true },
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
        required: true,
      },
      total: { type: 'integer', required: true },
    },
  } as const,
  render: (_args: unknown, value: unknown) => [entryBlock(value)],
}

/** Output for list / status: string array or ok/message. */
const LINES_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { memories: { type: 'array', items: { type: 'string' }, required: true } },
  } as const,
  render: (_args: unknown, value: unknown) => [entryBlock(value)],
}

const STATUS_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      message: { type: 'string', required: true },
    },
  } as const,
  render: (_args: unknown, value: unknown) => [entryBlock(value)],
}

/**
 * Register the memory tools and their runtime-context contribution.
 * @param ctx - plugin context carrying `memory`, `tools`, and `systemPrompt`.
 * @param config - validated tool configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'memory_remember',
    description:
      'Store a durable cross-session memory about the user or the current project. Use this when the user '
      + 'states a preference, fact, or decision you should remember and honor in later sessions. '
      + 'kind is "fact" (standing fact), "preference" (durable choice), "decision" (a made decision + rationale), '
      + 'or "note" (general note). scope defaults to the current project.',
    parameters: {
      content: {
        type: 'string',
        required: true,
        description: 'The memory text, written as a standalone statement another session can act on.',
      },
      kind: { type: 'string', enum: KINDS, required: true, description: 'fact | preference | decision | note.' },
      scope: {
        type: 'string',
        enum: ['user', 'project'],
        description: 'Defaults to the current working directory project; "user" stores personal memory.',
      },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional search labels.' },
    },
    output: REMEMBER_OUTPUT,
    async execute(args, exec) {
      const project = projectScopeOfExec(exec)
      const scope = args.scope === 'user' || project === undefined ? 'user' : project
      const entry = await ctx.memory.remember({
        scope,
        kind: args.kind,
        content: args.content,
        tags: args.tags ?? [],
      })
      return {
        ok: true,
        id: entry.id,
        scope: entry.scope,
        message: `Stored as ${entry.kind} memory${entry.scope === 'user' ? ' (user)' : ' in ' + entry.scope}.`,
      }
    },
    presentCall: args => present('Remember', args.content),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description:
      'Search stored memory (personal and current-project). Use this when you suspect the user or project '
      + 'has a remembered preference, fact, or decision relevant to the current task. Free-text search over '
      + 'content and tags, optionally narrowed by scope and kind.',
    parameters: {
      text: { type: 'string', description: 'Free-form search text; empty returns the most-used memories.' },
      scope: { type: 'string', enum: ['user', 'project'], description: 'Restrict a scope; omitted searches both.' },
      kind: { type: 'string', enum: KINDS, description: 'Restrict a kind.' },
      limit: { type: 'integer', description: 'Max results (default 12).' },
    },
    output: RECALL_OUTPUT,
    async execute(args, exec) {
      const project = projectScopeOfExec(exec)
      // Default scope is the current project (surfacing user memory too), never
      // "everything": without a project context, fall back to personal memory.
      const scope = args.scope === 'user' ? 'user' : project ?? 'user'
      const hits = ctx.memory.recall({
        ...args.text === undefined ? {} : { text: args.text },
        scope,
        ...args.kind === undefined ? {} : { kind: args.kind },
        // A negative or unbounded model-supplied limit would invert slice()
        // semantics or return the whole table.
        ...args.limit === undefined
          ? {}
          : { limit: Math.max(1, Math.min(config.maxRecallLimit, args.limit)) },
      })
      // Surfaced hits rank higher in later recalls and runtime-context snapshots.
      await Promise.all(hits.map(hit => ctx.memory.touch(hit.id)))
      return {
        memories: hits.map(hit => ({
          id: hit.id,
          kind: hit.kind,
          scope: hit.scope,
          content: hit.content,
          tags: hit.tags,
        })),
        total: hits.length,
      }
    },
    presentCall: args => present('Recall', args.text),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_list',
    description: 'List stored memories in the current scope, newest first.',
    parameters: {
      kind: { type: 'string', enum: KINDS, description: 'Only list a kind.' },
    },
    output: LINES_OUTPUT,
    execute(args, exec) {
      const scope = projectScopeOfExec(exec) ?? 'user'
      const rows = ctx.memory.list(scope, args.kind)
      return Promise.resolve({ memories: rows.map(entryLine) })
    },
    presentCall: () => present('List memories'),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: 'Delete one stored memory by its id. Use ids returned by memory_recall or memory_list.',
    parameters: {
      id: { type: 'string', required: true, description: 'The memory id to delete.' },
    },
    output: STATUS_OUTPUT,
    async execute(args, exec) {
      const entry = ctx.memory.get(brandMemoryId(args.id))
      if (entry !== undefined && !scopeAllowed(exec, entry.scope)) {
        return { ok: false, message: 'That memory belongs to another project and cannot be deleted here.' }
      }
      const deleted = await ctx.memory.forget(brandMemoryId(args.id))
      return {
        ok: deleted,
        message: deleted ? 'Memory deleted.' : 'No memory with that id.',
      }
    },
    presentCall: args => present('Forget memory', args.id),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_edit',
    description: 'Replace the content and/or tags of one stored memory by id.',
    parameters: {
      id: { type: 'string', required: true, description: 'The memory id to update.' },
      content: { type: 'string', description: 'New memory text.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Replacement tags.' },
    },
    output: STATUS_OUTPUT,
    execute(args, exec) {
      const entry = ctx.memory.get(brandMemoryId(args.id))
      if (entry !== undefined && !scopeAllowed(exec, entry.scope)) {
        return Promise.resolve({ ok: false, message: 'That memory belongs to another project and cannot be edited here.' })
      }
      return ctx.memory.edit(brandMemoryId(args.id), {
        ...args.content === undefined ? {} : { content: args.content },
        ...args.tags === undefined ? {} : { tags: args.tags },
      }).then(updated => ({
        ok: updated !== undefined,
        message: updated === undefined ? 'No memory with that id.' : 'Memory updated.',
      }))
    },
    presentCall: args => present('Edit memory', args.id),
  }))

  // A project-scoped recall surfaces user memory alongside project memory, so
  // one call covers both. The agent loop commits the rendered text as a
  // runtime-context snapshot only when it differs from the retained one.
  if (config.contextLimit === 0) return
  ctx.systemPrompt.context({
    name: 'tool:memory',
    order: 117,
    // Stored memory entries are arbitrary user-authored text, so this context
    // carries data, not a template: a `{{…}}` in a memory entry stays literal.
    interpolate: false,
    text(context) {
      const agent = context.agent
      if (agent === undefined) return ''
      const rows = ctx.memory.recall({ scope: projectScopeOf(agent), limit: config.contextLimit })
      if (rows.length === 0) return ''
      return [
        'Stored memory about the user and this project (act on it; update via memory_remember when it changes):',
        ...rows.map(entryLine),
      ].join('\n')
    },
  })
}
