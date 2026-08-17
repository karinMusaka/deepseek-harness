import { execFile } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { deadline } from '@deepseek-ai/dsh-timeout'
import * as codex from '../src/index.ts'
import {
  startResponsesFixture,
  type ResponsesBehavior,
  type ResponsesFixture,
} from './responses-fixture.ts'

const execFileAsync = promisify(execFile)
const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const codexBinDir = join(packageRoot, 'node_modules', '.bin')
const codexEntry = join(packageRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
const codexPackage = JSON.parse(readFileSync(
  join(packageRoot, 'node_modules', '@openai', 'codex', 'package.json'),
  'utf8',
)) as { version: string }

const roots: string[] = []
const fixtures: ResponsesFixture[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()))
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

interface RealHarness {
  readonly ctx: Context
  readonly handles: SubprocessHandle[]
  readonly parent: Agent
  readonly env: Record<string, string>
  readonly workspace: string
}

async function realHarness(script: readonly ResponsesBehavior[]): Promise<{
  readonly harness: RealHarness
  readonly fixture: ResponsesFixture
}> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-codex-real-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const codexHome = join(root, 'codex-home')
  const fixture = await startResponsesFixture(script)
  fixtures.push(fixture)
  mkdirSync(workspace)
  mkdirSync(codexHome)
  writeFileSync(join(codexHome, 'config.toml'), [
    'model = "fixture-model"',
    'model_provider = "fixture"',
    'approval_policy = "on-request"',
    'sandbox_mode = "read-only"',
    'disable_response_storage = true',
    'check_for_update_on_startup = false',
    '',
    '[model_providers.fixture]',
    'name = "Fixture Responses"',
    `base_url = "${fixture.baseUrl}"`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
    '[analytics]',
    'enabled = false',
    '',
  ].join('\n'))
  const env = {
    OPENAI_API_KEY: 'dsh-fake-openai-key',
    CODEX_HOME: codexHome,
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'xdg'),
    PATH: `${codexBinDir}${delimiter}${process.env.PATH ?? ''}`,
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
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
    const handle = spawn(spec)
    handles.push(handle)
    return handle
  })
  await ctx.plugin(codex, { env, disposeGraceMs: 2_000 })
  const parent = {
    id: 'real-parent',
    session: { header: { cwd: workspace } },
  } as unknown as Agent
  return { harness: { ctx, handles, parent, env, workspace }, fixture }
}

async function expectQuiescent(handles: readonly SubprocessHandle[]): Promise<void> {
  expect(handles.length).toBeGreaterThan(0)
  for (const handle of handles) {
    await expect(handle.waitForExit()).resolves.toBe(true)
    const outcome = await handle.done
    expect(outcome).toHaveProperty('exitCode')
    expect(outcome).toHaveProperty('signal')
  }
}

function responseInputTexts(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.input)) return []
  return body.input.flatMap((item): string[] => {
    if (item === null || typeof item !== 'object') return []
    const content = (item as Record<string, unknown>).content
    if (!Array.isArray(content)) return []
    return content.flatMap((part): string[] => (
      part !== null
      && typeof part === 'object'
      && typeof (part as Record<string, unknown>).text === 'string'
        ? [(part as Record<string, unknown>).text as string]
        : []
    ))
  })
}

describe('real @openai/codex 0.147.0 product', () => {
  it('passes the exact task and fake authentication to local Responses and returns exact text', async () => {
    const sentinel = 'REAL_CODEX_SENTINEL_0_147_0'
    const task = 'Return the fixture sentinel exactly.'
    const { harness, fixture } = await realHarness([
      { kind: 'complete', text: sentinel },
    ])
    expect(codexPackage.version).toBe('0.147.0')
    const version = await execFileAsync(process.execPath, [codexEntry, '--version'], {
      env: { ...process.env, ...harness.env },
    })
    expect(version.stdout.trim()).toBe('codex-cli 0.147.0')

    const run = await harness.ctx.subagents.start('codex', {
      prompt: [{ type: 'text', text: task }],
      parent: harness.parent,
      signal: new AbortController().signal,
    })
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: sentinel }],
      stopReason: 'completed',
      // realHarness's env sets a credential-shaped `OPENAI_API_KEY`.
      authMode: 'api-key',
    })
    await run.dispose()

    expect(fixture.requests).toHaveLength(1)
    const recorded = fixture.requests[0]!
    expect(recorded.method).toBe('POST')
    expect(recorded.path).toBe('/v1/responses')
    expect(recorded.headers.authorization).toBe('Bearer dsh-fake-openai-key')
    expect(responseInputTexts(recorded.body)).toContain(task)
    await expectQuiescent(harness.handles)
  }, 60_000)

  it('rejects an escalated command outright under the pinned never approval policy, without executing it', async () => {
    // Fixed `approvalPolicy: 'never'` (never left to the host's
    // `~/.codex/config.toml`) means codex-core itself rejects a command that
    // requires escalated permissions before ever asking the client — the
    // wire's own approval-decline handling (`unattendedDecision`, covered at
    // the protocol level in subagent-codex.spec.ts) is unreached on this path.
    // A second scripted turn lets the run settle immediately instead of
    // retrying against an exhausted fixture script.
    const command = process.platform === 'win32'
      ? 'cmd /c type nul > approval-side-effect'
      : 'touch approval-side-effect'
    const commandCalls = [
      {
        name: 'exec_command',
        arguments: {
          cmd: command,
          sandbox_permissions: 'require_escalated',
          justification: 'exercise the unattended approval boundary',
        },
      },
      {
        name: 'shell_command',
        arguments: {
          command,
          sandbox_permissions: 'require_escalated',
          justification: 'exercise the unattended approval boundary',
        },
      },
    ] as const
    const acknowledgement = 'acknowledged: the command was rejected'
    const { harness, fixture } = await realHarness([
      {
        kind: 'advertisedFunctionCall',
        choices: commandCalls,
      },
      { kind: 'complete', text: acknowledgement },
    ])
    const sideEffect = join(harness.workspace, 'approval-side-effect')
    const run = await harness.ctx.subagents.start('codex', {
      prompt: [{ type: 'text', text: 'Attempt the fixture command.' }],
      parent: harness.parent,
      signal: new AbortController().signal,
    })
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: acknowledgement }],
      stopReason: 'completed',
      // realHarness's env sets a credential-shaped `OPENAI_API_KEY`.
      authMode: 'api-key',
    })
    await run.dispose()

    // Verify the world, not the model's self-report: the command never ran.
    expect(existsSync(sideEffect)).toBe(false)
    expect(fixture.requests).toHaveLength(2)
    const tools = fixture.requests[0]!.body.tools as Array<Record<string, unknown>>
    expect(commandCalls.some(call => tools.some(tool => (
      tool.type === 'function' && tool.name === call.name
    )))).toBe(true)
    // The rejection reaches the model as the function's own output — codex-core
    // rejected it before the app-server ever asked this provider for a decision.
    expect(JSON.stringify(fixture.requests[1]!.body)).toContain(
      'approval policy is Never; reject command',
    )
    expect(fixture.requests.every(requestEntry =>
      requestEntry.headers.authorization === 'Bearer dsh-fake-openai-key',
    )).toBe(true)
    await expectQuiescent(harness.handles)
  }, 60_000)

  it('settles cancellation locally and leaves the real app-server tree quiescent', async () => {
    const { harness, fixture } = await realHarness([{ kind: 'hold' }])
    const controller = new AbortController()
    const run = await harness.ctx.subagents.start('codex', {
      prompt: [{ type: 'text', text: 'Wait for cancellation.' }],
      parent: harness.parent,
      signal: controller.signal,
    })
    await fixture.requestStarted
    controller.abort(new Error('real product cancellation'))
    await expect(run.result).resolves.toMatchObject({ stopReason: 'aborted' })
    await run.dispose()
    await expectQuiescent(harness.handles)
  }, 60_000)

  it('settles a caller-owned wall-clock deadline exactly like a manual cancellation and leaves the tree quiescent', async () => {
    // A consuming tool (dsh-tool-subagent's `timeoutSeconds`) composes its own
    // deadline into `request.signal` — never a change to this provider. This
    // proves that composed signal reaches real teardown to actual process
    // exit (not just a requested kill) exactly like the manual-cancellation
    // case above, using the same `dsh-timeout` deadline() the consuming tool
    // uses, firing on a real elapsed timer instead of an explicit `abort()`.
    const { harness, fixture } = await realHarness([{ kind: 'hold' }])
    // Long enough that real app-server startup and the first held request
    // reliably land before it elapses (proven by awaiting `requestStarted`
    // below); short enough to keep the test fast. The deadline still owns the
    // eventual abort — nothing here calls `abort()` explicitly.
    using timeout = deadline(undefined, 1_500, 'REAL_PRODUCT_DEADLINE_TEST')
    const run = await harness.ctx.subagents.start('codex', {
      prompt: [{ type: 'text', text: 'Wait for the deadline to elapse.' }],
      parent: harness.parent,
      signal: timeout.signal,
    })
    await fixture.requestStarted
    await expect(run.result).resolves.toMatchObject({ stopReason: 'aborted' })
    await run.dispose()
    await expectQuiescent(harness.handles)
  }, 60_000)
})

describe('real @openai/codex 0.147.0 failure classification', () => {
  it('classifies a real 401 as auth from the error-notification stream, not the terminal turn\'s degraded "other"', async () => {
    // The real app-server retries the Responses stream five times against a
    // persistent 401 (codex-core's own reconnect ladder — see the
    // failure-classification Agent Note), then gives up: the terminal
    // `turn/completed` reports `codexErrorInfo: "other"`. A naive
    // terminal-only classifier would report `provider`, never `auth`.
    const { harness, fixture } = await realHarness([{ kind: 'unauthorized' }])
    const run = await harness.ctx.subagents.start('codex', {
      prompt: [{ type: 'text', text: 'Say hello.' }],
      parent: harness.parent,
      signal: new AbortController().signal,
    })
    const result = await run.result
    await run.dispose()

    expect(result.stopReason).toBe('error')
    expect(result.failure?.code).toBe('auth')
    // The provider's own actionable text reaches the result verbatim
    // (redaction happens once, later, at `dsh-tool-subagent`).
    expect(result.failure?.message).toContain('401 Unauthorized')
    expect(result.failure?.message).toContain('Missing bearer or basic authentication in header')
    // realHarness's env sets a credential-shaped `OPENAI_API_KEY`.
    expect(result.authMode).toBe('api-key')
    expect(fixture.requests.length).toBeGreaterThanOrEqual(2)
    await expectQuiescent(harness.handles)
  }, 60_000)
})

/** Shell/exec function-call choices real codex advertises for a plain (non-escalated) command. */
function shellCallChoices(command: string): readonly { name: string; arguments: Record<string, unknown> }[] {
  return [
    { name: 'exec_command', arguments: { cmd: command } },
    { name: 'shell_command', arguments: { command } },
  ] as const
}

describe('real @openai/codex 0.147.0 permission scope (fixed at delegation)', () => {
  it('a read-only child can read a file through the real sandboxed shell', async () => {
    const sentinel = 'REAL_CODEX_READ_ONLY_READ_SENTINEL'
    const { harness, fixture } = await realHarness([
      { kind: 'advertisedFunctionCall', choices: shellCallChoices('cat probe.txt') },
      { kind: 'complete', text: 'read the probe file' },
    ])
    writeFileSync(join(harness.workspace, 'probe.txt'), sentinel)
    const run = await harness.ctx.subagents.start('codex', {
      prompt: [{ type: 'text', text: 'Read probe.txt and report it.' }],
      parent: harness.parent,
      permissionMode: 'read-only',
      signal: new AbortController().signal,
    })
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'read the probe file' }],
      stopReason: 'completed',
      // realHarness's env sets a credential-shaped `OPENAI_API_KEY`.
      authMode: 'api-key',
    })
    await run.dispose()

    expect(fixture.requests).toHaveLength(2)
    // The real sandboxed shell actually ran `cat`; its output crosses back to
    // the model as the function's own result, not the model's self-report.
    expect(JSON.stringify(fixture.requests[1]!.body)).toContain(sentinel)
    await expectQuiescent(harness.handles)
  }, 60_000)

  it('a read-only child cannot create a file — the real OS sandbox blocks a plain (non-escalated) shell write', async () => {
    const { harness, fixture } = await realHarness([
      { kind: 'advertisedFunctionCall', choices: shellCallChoices('printf WROTE > marker.txt') },
      { kind: 'complete', text: 'attempted the write' },
    ])
    const marker = join(harness.workspace, 'marker.txt')
    const run = await harness.ctx.subagents.start('codex', {
      prompt: [{ type: 'text', text: 'Create marker.txt.' }],
      parent: harness.parent,
      permissionMode: 'read-only',
      signal: new AbortController().signal,
    })
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'attempted the write' }],
      stopReason: 'completed',
      // realHarness's env sets a credential-shaped `OPENAI_API_KEY`.
      authMode: 'api-key',
    })
    await run.dispose()

    // Verify the world, not the model's self-report: the file was never created.
    expect(existsSync(marker)).toBe(false)
    expect(fixture.requests).toHaveLength(2)
    // `sandbox: 'read-only'` on `thread/start` blocks the write at the OS
    // level (seatbelt/landlock) — no approval ask, and no per-tool-name
    // bypass exists in codex's shell surface the way `Bash` bypassed a
    // Claude Code `disallowedTools` denylist (see the Agent Note).
    expect(JSON.stringify(fixture.requests[1]!.body)).toContain('operation not permitted')
    await expectQuiescent(harness.handles)
  }, 60_000)

  it('a workspace-write child can create a file inside its own working directory', async () => {
    const { harness, fixture } = await realHarness([
      { kind: 'advertisedFunctionCall', choices: shellCallChoices('printf WROTE > marker.txt') },
      { kind: 'complete', text: 'created the file' },
    ])
    const marker = join(harness.workspace, 'marker.txt')
    const run = await harness.ctx.subagents.start('codex', {
      prompt: [{ type: 'text', text: 'Create marker.txt.' }],
      parent: harness.parent,
      permissionMode: 'workspace-write',
      signal: new AbortController().signal,
    })
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'created the file' }],
      stopReason: 'completed',
      // realHarness's env sets a credential-shaped `OPENAI_API_KEY`.
      authMode: 'api-key',
    })
    await run.dispose()

    expect(existsSync(marker)).toBe(true)
    expect(readFileSync(marker, 'utf8')).toBe('WROTE')
    expect(fixture.requests).toHaveLength(2)
    await expectQuiescent(harness.handles)
  }, 60_000)
})
