import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { boundedAppend, spawnAgy, STDERR_TAIL_BYTES } from '../src/agy-process.ts'
import type { AgyProcessEvent } from '../src/agy-process.ts'
import { installFakeAgy } from './support/fake-agy.ts'
import type { FakeAgy } from './support/fake-agy.ts'

describe('boundedAppend', () => {
  it('keeps the whole buffer when under the bound', () => {
    const result = boundedAppend(Buffer.from('ab'), Buffer.from('cd'))
    expect(result.toString('utf8')).toBe('abcd')
  })

  it('keeps exactly the bound when the total lands on it', () => {
    const first = Buffer.alloc(STDERR_TAIL_BYTES - 2, 'x')
    const result = boundedAppend(first, Buffer.from('yz'))
    expect(result.length).toBe(STDERR_TAIL_BYTES)
    expect(result.toString('utf8')).toBe(`${'x'.repeat(STDERR_TAIL_BYTES - 2)}yz`)
  })

  it('keeps only the tail of one chunk larger than the whole bound', () => {
    const oversized = Buffer.alloc(STDERR_TAIL_BYTES + 100, 'x')
    const result = boundedAppend(Buffer.alloc(0), oversized)
    expect(result.length).toBe(STDERR_TAIL_BYTES)
    expect(result.toString('utf8')).toBe('x'.repeat(STDERR_TAIL_BYTES))
  })

  it('does not throw when the byte cutoff falls inside a multibyte character, and decodes the rest cleanly', () => {
    // 'あ' is 3 UTF-8 bytes (0xE3 0x81 0x82). Pad so the STDERR_TAIL_BYTES-from-
    // the-end cutoff lands one byte into that sequence, then confirm the
    // decode does not throw and the trailing ASCII survives intact.
    const padLength = STDERR_TAIL_BYTES - 1
    const chunk = Buffer.concat([Buffer.alloc(padLength, 'x'), Buffer.from('あ', 'utf8'), Buffer.from('tail', 'utf8')])
    const result = boundedAppend(Buffer.alloc(0), chunk)
    expect(result.length).toBe(STDERR_TAIL_BYTES)
    expect(() => result.toString('utf8')).not.toThrow()
    expect(result.toString('utf8').endsWith('tail')).toBe(true)
  })
})

describe('spawnAgy', () => {
  let fake: FakeAgy | undefined

  afterEach(async () => {
    await fake?.cleanup()
    fake = undefined
  })

  async function collect(events: AsyncGenerator<AgyProcessEvent, void, void>): Promise<AgyProcessEvent[]> {
    const collected: AgyProcessEvent[] = []
    for await (const event of events) collected.push(event)
    return collected
  }

  it('emits ordered NDJSON line events followed by a clean exit', async () => {
    fake = await installFakeAgy()
    const cwd = tmpdir()
    const handle = spawnAgy({
      binaryPath: fake.binaryPath,
      args: ['--model', 'text-stream', '--input-format', 'stream-json', '--output-format', 'stream-json'],
      cwd,
      input: `${JSON.stringify({ event: 'user', message: { content: [{ type: 'text', text: 'hi' }] } })}\n`,
    })
    const events = await collect(handle.events)
    const kinds = events.map(event => event.kind)
    expect(kinds.slice(0, -1).every(kind => kind === 'line')).toBe(true)
    expect(kinds.at(-1)).toBe('exit')
    const exit = events.at(-1)
    expect(exit).toEqual({ kind: 'exit', code: 0, signal: null })
    expect(handle.stderrTail()).toBe('')
  })

  it('reports a spawn-error event for a missing binary, before any exit event', async () => {
    const handle = spawnAgy({
      binaryPath: join(tmpdir(), 'dsh-agy-does-not-exist-xyz'),
      args: [],
      cwd: tmpdir(),
      input: '',
    })
    const events = await collect(handle.events)
    // Node emits 'error' then 'close' for a failed spawn; the spawn-error
    // event must arrive first so the adapter reports the actionable cause.
    expect(events[0]?.kind).toBe('spawn-error')
    if (events[0]?.kind === 'spawn-error') {
      expect((events[0].error as NodeJS.ErrnoException).code).toBe('ENOENT')
    }
    expect(events.at(-1)?.kind).toBe('exit')
  })

  it('kill() is a no-op after the process has already exited', async () => {
    fake = await installFakeAgy()
    const handle = spawnAgy({
      binaryPath: fake.binaryPath,
      args: ['--model', 'text-stream'],
      cwd: tmpdir(),
      input: `${JSON.stringify({ event: 'user', message: { content: [{ type: 'text', text: 'hi' }] } })}\n`,
    })
    await collect(handle.events)
    expect(() => { handle.kill() }).not.toThrow()
  })

  it('kill() terminates a hung process and the exit event reports the signal', async () => {
    fake = await installFakeAgy()
    const handle = spawnAgy({
      binaryPath: fake.binaryPath,
      args: ['--model', 'hang'],
      cwd: tmpdir(),
      input: `${JSON.stringify({ event: 'user', message: { content: [{ type: 'text', text: 'hi' }] } })}\n`,
    })
    const first = await handle.events.next()
    expect(first.done).toBe(false)
    handle.kill()
    const events: AgyProcessEvent[] = []
    for await (const event of handle.events) events.push(event)
    const exit = events.at(-1)
    expect(exit?.kind).toBe('exit')
    if (exit?.kind === 'exit') {
      expect(exit.code === null || exit.signal === 'SIGTERM').toBe(true)
    }
  })

  it('captures a bounded stderr tail from a failing process', async () => {
    fake = await installFakeAgy()
    const handle = spawnAgy({
      binaryPath: fake.binaryPath,
      args: ['--model', 'nonzero-exit'],
      cwd: tmpdir(),
      input: `${JSON.stringify({ event: 'user', message: { content: [{ type: 'text', text: 'hi' }] } })}\n`,
    })
    const events = await collect(handle.events)
    const exit = events.at(-1)
    expect(exit).toEqual({ kind: 'exit', code: 3, signal: null })
    expect(handle.stderrTail()).toContain('agy: fatal transport error')
  })

  it('closing the generator early (a break) does not hang the caller', async () => {
    fake = await installFakeAgy()
    const handle = spawnAgy({
      binaryPath: fake.binaryPath,
      args: ['--model', 'text-stream'],
      cwd: tmpdir(),
      input: `${JSON.stringify({ event: 'user', message: { content: [{ type: 'text', text: 'hi' }] } })}\n`,
    })
    for await (const _event of handle.events) {
      break
    }
    await expect(handle.events.next()).resolves.toEqual({ value: undefined, done: true })
  })

  it('does not crash when a large stdin write races a child that exits without reading it (EPIPE)', async () => {
    fake = await installFakeAgy()
    const handle = spawnAgy({
      binaryPath: fake.binaryPath,
      args: ['--model', 'exit-without-reading-stdin'],
      cwd: tmpdir(),
      // ~1 MiB: large enough that the write is still in flight (or buffered)
      // when the child's already-closed stdin pipe rejects it.
      input: 'x'.repeat(1024 * 1024),
    })
    const events = await collect(handle.events)
    expect(events.at(-1)?.kind).toBe('exit')
  })
})
