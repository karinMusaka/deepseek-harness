import { execFile } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type {
  Query,
  SDKMessage,
  SDKSystemMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { Context } from '@deepseek-ai/cordis'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as claudeCode from '../src/index.ts'
import {
  startMessagesFixture,
  type MessagesBehavior,
  type MessagesFixture,
} from './messages-fixture.ts'

const observedSdkMessages = vi.hoisted((): SDKMessage[] => [])

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@anthropic-ai/claude-agent-sdk')
  >()
  return {
    ...actual,
    query(options: Parameters<typeof actual.query>[0]): Query {
      const query = actual.query(options)
      // Observe the real SDK stream without replacing its protocol or CLI.
      return new Proxy(query, {
        get(target, property) {
          if (property === Symbol.asyncIterator) {
            return async function* (): AsyncGenerator<SDKMessage, void> {
              for await (const message of target) {
                observedSdkMessages.push(message)
                yield message
              }
            }
          }
          const value: unknown = Reflect.get(target, property, target)
          if (typeof value === 'function') {
            const method = value as (...args: unknown[]) => unknown
            return method.bind(target)
          }
          return value
        },
      })
    },
  }
})

const execFileAsync = promisify(execFile)
const sdkRoot = dirname(fileURLToPath(
  import.meta.resolve('@anthropic-ai/claude-agent-sdk'),
))
const sdkPackage = JSON.parse(readFileSync(
  join(sdkRoot, 'package.json'),
  'utf8',
)) as {
  version: string
  claudeCodeVersion: string
  optionalDependencies: Record<string, string>
}
const platformPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
const platformRoot = resolve(sdkRoot, '..', platformPackage.split('/')[1]!)
const claudeBin = join(
  platformRoot,
  process.platform === 'win32' ? 'claude.exe' : 'claude',
)
const settingsModel = 'dsh-settings-inheritance-marker'
const fakeKey = 'dsh-fake-anthropic-key'

const roots: string[] = []
const fixtures: MessagesFixture[] = []
const contexts: Context[] = []

// Ambient Anthropic model env leaks into the real CLI and overrides the
// fixture settings.json on developer machines; delete it for this file and
// restore it after, like the workspace-context USERPROFILE isolation.
const ambientAnthropicModel = process.env.ANTHROPIC_MODEL
const ambientAnthropicSmallFastModel = process.env.ANTHROPIC_SMALL_FAST_MODEL

beforeAll(() => {
  delete process.env.ANTHROPIC_MODEL
  delete process.env.ANTHROPIC_SMALL_FAST_MODEL
})

afterAll(() => {
  if (ambientAnthropicModel !== undefined) process.env.ANTHROPIC_MODEL = ambientAnthropicModel
  if (ambientAnthropicSmallFastModel !== undefined) process.env.ANTHROPIC_SMALL_FAST_MODEL = ambientAnthropicSmallFastModel
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()))
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  observedSdkMessages.length = 0
})

interface RealHarness {
  readonly ctx: Context
  readonly handles: SubprocessHandle[]
  readonly spawnSpecs: SubprocessSpawnSpec[]
  readonly parent: Agent
  readonly workspace: string
  readonly env: Record<string, string>
  readonly executable: string
}

async function realHarness(
  script: readonly MessagesBehavior[] | ((workspace: string) => readonly MessagesBehavior[]),
  options: { readonly omitApiKey?: boolean } = {},
): Promise<{
  readonly harness: RealHarness
  readonly fixture: MessagesFixture
}> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-claude-code-real-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const claudeConfig = join(root, 'claude-config')
  const xdgConfig = join(root, 'xdg')
  const nativeBin = join(root, 'native&%literal%!bang!bin')
  mkdirSync(workspace)
  mkdirSync(claudeConfig)
  mkdirSync(xdgConfig)
  mkdirSync(nativeBin)
  const executable = join(nativeBin, process.platform === 'win32' ? 'claude.cmd' : 'claude')
  if (process.platform === 'win32') {
    writeFileSync(executable, `@echo off\r\n"${claudeBin}" %*\r\n`)
  } else {
    symlinkSync(claudeBin, executable)
  }
  writeFileSync(
    join(claudeConfig, 'settings.json'),
    `${JSON.stringify({ model: settingsModel }, null, 2)}\n`,
  )
  const fixture = await startMessagesFixture(typeof script === 'function' ? script(workspace) : script)
  fixtures.push(fixture)
  const env = {
    PATH: `${nativeBin}${delimiter}${process.env.PATH ?? ''}`,
    ...options.omitApiKey === true ? {} : { ANTHROPIC_API_KEY: fakeKey },
    ANTHROPIC_BASE_URL: fixture.baseUrl,
    CLAUDE_CONFIG_DIR: claudeConfig,
    HOME: root,
    XDG_CONFIG_HOME: xdgConfig,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    NO_PROXY: '127.0.0.1,localhost',
  }
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  const handles: SubprocessHandle[] = []
  const spawnSpecs: SubprocessSpawnSpec[] = []
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
    spawnSpecs.push(spec)
    const handle = spawn(spec)
    handles.push(handle)
    return handle
  })
  await ctx.plugin(claudeCode, { env, disposeGraceMs: 3_000 })
  const parent = {
    id: 'real-parent',
    session: { header: { cwd: workspace } },
  } as unknown as Agent
  return {
    harness: { ctx, handles, spawnSpecs, parent, workspace, env, executable },
    fixture,
  }
}

async function expectQuiescent(
  handles: readonly SubprocessHandle[],
): Promise<void> {
  expect(handles.length).toBeGreaterThan(0)
  for (const handle of handles) {
    await expect(handle.waitForExit()).resolves.toBe(true)
    const outcome = await handle.done
    expect(outcome).toHaveProperty('exitCode')
    expect(outcome).toHaveProperty('signal')
  }
}

/** Extract every `tool_result` content string across a script of requests. */
function toolResultTexts(requests: readonly { readonly body: Record<string, unknown> }[]): string[] {
  return requests.flatMap((request): string[] => {
    const messages = request.body.messages
    if (!Array.isArray(messages)) return []
    return messages.flatMap((message): string[] => {
      if (message === null || typeof message !== 'object' || (message as { role?: unknown }).role !== 'user') return []
      const content = (message as { content?: unknown }).content
      if (!Array.isArray(content)) return []
      return content.flatMap((block): string[] =>
        block !== null
        && typeof block === 'object'
        && (block as { type?: unknown }).type === 'tool_result'
        && typeof (block as { content?: unknown }).content === 'string'
          ? [(block as { content: string }).content]
          : [])
    })
  })
}

function startRequest(
  harness: RealHarness,
  prompt: string,
  signal = new AbortController().signal,
  permissionMode?: 'read-only' | 'workspace-write',
) {
  return harness.ctx.subagents.start('claude-code', {
    prompt: [{ type: 'text', text: prompt }],
    parent: harness.parent,
    signal,
    ...permissionMode !== undefined ? { permissionMode } : {},
  })
}

describe('real Claude Agent SDK 0.3.220 and its distributed Claude Code 2.1.220 fixture', {
  timeout: 60_000,
}, () => {
  it('does not inherit host settings (settingSources: []) and sends the exact task and fake key to local Messages', async () => {
    const sentinel = 'REAL_CLAUDE_CODE_SENTINEL_2_1_220'
    const task = 'Return the fixture sentinel exactly.'
    const { harness, fixture } = await realHarness([{
      kind: 'complete',
      text: sentinel,
    }])
    expect(sdkPackage.version).toBe('0.3.220')
    expect(sdkPackage.claudeCodeVersion).toBe('2.1.220')
    expect(sdkPackage.optionalDependencies[platformPackage]).toBe('0.3.220')
    const version = await execFileAsync(process.platform === 'win32' ? claudeBin : harness.executable, ['--version'], {
      env: { ...process.env, ...harness.env },
    })
    expect(version.stdout.trim()).toBe('2.1.220 (Claude Code)')

    const run = await startRequest(harness, task)
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: sentinel }],
      stopReason: 'completed',
      // realHarness's env sets a credential-shaped `ANTHROPIC_API_KEY`.
      authMode: 'api-key',
    })
    await run.dispose()

    const initMessage = observedSdkMessages.find(
      (message): message is SDKSystemMessage =>
        message.type === 'system' && message.subtype === 'init',
    )
    expect(initMessage?.claude_code_version).toBe('2.1.220')
    if (process.platform === 'win32') {
      expect(harness.spawnSpecs[0]?.argv.slice(0, 6)).toEqual([
        'cmd.exe', '/d', '/v:off', '/s', '/c', '%DSH_CLAUDE_CODE_EXECUTABLE%',
      ])
      const batchExecutable = harness.spawnSpecs[0]?.env?.DSH_CLAUDE_CODE_EXECUTABLE
      expect(batchExecutable?.startsWith('"')).toBe(true)
      expect(batchExecutable?.endsWith('"')).toBe(true)
      expect(batchExecutable?.slice(1, -1).toLowerCase())
        .toBe(harness.executable.toLowerCase())
    } else {
      expect(harness.spawnSpecs[0]?.argv[0]).toBe(harness.executable)
    }

    expect(fixture.requests).toHaveLength(1)
    const recorded = fixture.requests[0]!
    expect(recorded.method).toBe('POST')
    expect(recorded.path).toMatch(/^\/v1\/messages(?:\?.*)?$/)
    expect(recorded.headers['x-api-key']).toBe(fakeKey)
    // `settingSources: []` (fixed at delegation) means the child never reads
    // `claude-config/settings.json`; without it, the model would be the
    // fixture's `settingsModel` marker (empirically confirmed pre-fix). The
    // real CLI falls back to its own bundled default instead.
    expect(recorded.body.model).not.toBe(settingsModel)
    expect(recorded.body.model).toBe('claude-opus-5')
    expect(Array.isArray(recorded.body.messages)).toBe(true)
    const messageTexts = (
      recorded.body.messages as Array<{ content?: unknown }>
    ).flatMap((message): unknown[] =>
      Array.isArray(message.content) ? message.content as unknown[] : [])
      .filter((block): block is { type: string; text: string } =>
        typeof block === 'object'
        && block !== null
        && 'type' in block
        && block.type === 'text'
        && 'text' in block
        && typeof block.text === 'string')
      .map(block => block.text)
    expect(messageTexts.filter(text => text.includes(task))).toEqual([task])
    await expectQuiescent(harness.handles)
  })

  it('maps a real CLI process failure to error', async () => {
    const { harness, fixture } = await realHarness([{ kind: 'hold' }])
    const run = await startRequest(harness, 'Exercise the failure path.')
    await fixture.requestStarted
    expect(harness.handles).toHaveLength(1)
    harness.handles[0]!.terminate()
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.output).toEqual([])
    expect(result.authMode).toBe('api-key')
    // The real SDK reports a terminal `is_error: true` result (not a stream
    // rejection) for a killed process, with no `api_error_status` and no
    // assistant-message cause — classifies as the generic `provider` default.
    expect(result.failure?.code).toBe('provider')
    await run.dispose()
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.requests[0]!.headers['x-api-key']).toBe(fakeKey)
    await expectQuiescent(harness.handles)
  })

  it('settles cancellation and leaves the real SDK-spawned CLI tree quiescent', async () => {
    const { harness, fixture } = await realHarness([{ kind: 'hold' }])
    const controller = new AbortController()
    const run = await startRequest(
      harness,
      'Wait for cancellation.',
      controller.signal,
    )
    await fixture.requestStarted
    controller.abort(new Error('real product cancellation'))
    await expect(run.result).resolves.toEqual({
      output: [],
      stopReason: 'aborted',
      authMode: 'api-key',
    })
    await run.dispose()
    await expectQuiescent(harness.handles)
  })
})

describe('real Claude Agent SDK permission scope (fixed at delegation)', { timeout: 60_000 }, () => {
  it('a read-only child can read a file through the real CLI\'s own Read tool', async () => {
    const sentinel = 'REAL_CLAUDE_CODE_READ_ONLY_READ_SENTINEL'
    const { harness, fixture } = await realHarness(workspace => [
      { kind: 'toolUse', name: 'Read', input: { file_path: join(workspace, 'probe.txt') } },
      { kind: 'complete', text: 'read the probe file' },
    ])
    writeFileSync(join(harness.workspace, 'probe.txt'), sentinel)
    const run = await startRequest(harness, 'Read probe.txt and report it.', undefined, 'read-only')
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'read the probe file' }],
      stopReason: 'completed',
      authMode: 'api-key',
    })
    await run.dispose()

    expect(fixture.requests).toHaveLength(2)
    // The real CLI actually ran Read; its result crosses back to the model
    // as the tool's own output, not the model's self-report.
    expect(JSON.stringify(fixture.requests[1]!.body)).toContain(sentinel)
    await expectQuiescent(harness.handles)
  })

  it('a read-only child cannot create a file — Write is denied, and a Bash bypass attempt is also denied', async () => {
    const { harness, fixture } = await realHarness(workspace => [
      { kind: 'toolUse', name: 'Write', input: { file_path: join(workspace, 'marker.txt'), content: 'WROTE' }, id: 'toolu_dsh_fixture_write' },
      { kind: 'toolUse', name: 'Bash', input: { command: 'printf WROTE > marker2.txt' }, id: 'toolu_dsh_fixture_bash' },
      { kind: 'complete', text: 'both attempts were denied' },
    ])
    const run = await startRequest(harness, 'Create marker.txt.', undefined, 'read-only')
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'both attempts were denied' }],
      stopReason: 'completed',
      authMode: 'api-key',
    })
    await run.dispose()

    // Verify the world, not the model's self-report: neither path created a file.
    expect(existsSync(join(harness.workspace, 'marker.txt'))).toBe(false)
    expect(existsSync(join(harness.workspace, 'marker2.txt'))).toBe(false)
    expect(fixture.requests).toHaveLength(3)
    const denials = toolResultTexts(fixture.requests.slice(1)).join('\n')
    expect(denials).toContain('"Write" is outside the delegated child\'s fixed "read-only" permission scope')
    expect(denials).toContain('"Bash" is outside the delegated child\'s fixed "read-only" permission scope')
    await expectQuiescent(harness.handles)
  })

  it('a workspace-write child can create a file through the real CLI\'s own Write tool', async () => {
    const { harness, fixture } = await realHarness(workspace => [
      { kind: 'toolUse', name: 'Write', input: { file_path: join(workspace, 'marker.txt'), content: 'WROTE' } },
      { kind: 'complete', text: 'created the file' },
    ])
    const run = await startRequest(harness, 'Create marker.txt.', undefined, 'workspace-write')
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'created the file' }],
      stopReason: 'completed',
      authMode: 'api-key',
    })
    await run.dispose()

    expect(existsSync(join(harness.workspace, 'marker.txt'))).toBe(true)
    expect(readFileSync(join(harness.workspace, 'marker.txt'), 'utf8')).toBe('WROTE')
    expect(fixture.requests).toHaveLength(2)
    await expectQuiescent(harness.handles)
  })
})

describe('real Claude Agent SDK 0.3.220 failure classification', { timeout: 60_000 }, () => {
  it('classifies a logged-out run as auth, never trusting subtype: "success"', async () => {
    // Measured against the real CLI with no `ANTHROPIC_API_KEY` at all (empty
    // `HOME`, no credential store): `is_error: true` while `subtype` stays
    // `'success'` — see the failure-classification Agent Note. No network
    // call reaches the fixture at all.
    const { harness, fixture } = await realHarness([], { omitApiKey: true })
    const run = await startRequest(harness, 'Say hello.')
    const result = await run.result
    await run.dispose()

    expect(result.stopReason).toBe('error')
    expect(result.failure?.code).toBe('auth')
    expect(result.failure?.message).toBe('Not logged in · Please run /login')
    // No credential-shaped entry in `Config.env` (the key was omitted above).
    expect(result.authMode).toBe('subscription')
    expect(fixture.requests).toHaveLength(0)
    await expectQuiescent(harness.handles)
  })
})
