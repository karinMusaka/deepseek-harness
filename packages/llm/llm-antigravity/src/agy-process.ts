/**
 * Subprocess transport for one agy turn: spawns the binary, frames its NDJSON
 * stdout into an ordered event queue alongside process exit and spawn
 * failure, and bounds the retained stderr tail. Kept separate from
 * `adapter.ts` so the wire/process concerns can be tested without a real
 * `agy` binary via a fake spawned executable.
 * @module @deepseek-ai/dsh-llm-antigravity/agy-process
 */

import { spawn } from 'node:child_process'
import * as readline from 'node:readline'

/** Bound on retained stderr: the complete emitted error text, not per-chunk. */
export const STDERR_TAIL_BYTES = 4096

/** One event observed from a running agy process, in arrival order. */
export type AgyProcessEvent =
  | { kind: 'line'; line: string }
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null }
  | { kind: 'spawn-error'; error: Error }

/** A running agy process: its ordered event stream, a kill switch, and the retained stderr tail. */
export interface AgyProcessHandle {
  /** NDJSON lines, exit, and spawn-error events in arrival order; ends after `exit` or one `spawn-error`. */
  events: AsyncGenerator<AgyProcessEvent, void, void>
  /** Send SIGTERM when the process is still running; a no-op once it has exited. */
  kill: () => void
  /** The last {@link STDERR_TAIL_BYTES} bytes of stderr decoded as UTF-8, at time of call. */
  stderrTail: () => string
}

/** One agy invocation's spawn facts. */
export interface AgySpawnOptions {
  /** Path or bare `PATH`-resolved command for the agy executable. */
  binaryPath: string
  /** Complete argument list, in order. */
  args: readonly string[]
  /** Working directory; MUST be a fresh untrusted directory — see `adapter.ts`. */
  cwd: string
  /** Complete stdin payload; written and closed immediately. */
  input: string
}

/**
 * Append `chunk` to `buffer`, keeping only the last {@link STDERR_TAIL_BYTES}
 * bytes of the COMPLETE result (not a per-chunk bound): a chunk larger than
 * the whole budget still leaves exactly the budget's worth of its tail.
 * @param buffer - bytes retained so far.
 * @param chunk - newly received bytes to append.
 * @returns the bounded, concatenated buffer.
 */
export function boundedAppend(buffer: Buffer, chunk: Buffer): Buffer {
  const combined = Buffer.concat([buffer, chunk])
  return combined.length > STDERR_TAIL_BYTES
    ? combined.subarray(combined.length - STDERR_TAIL_BYTES)
    : combined
}

/**
 * Spawn one agy process and expose its output as an ordered async event
 * stream. Listeners attach synchronously (before this function returns) so a
 * same-tick ENOENT spawn failure is never missed.
 * @param options - binary, arguments, working directory, and stdin payload.
 * @returns a handle over the running process; consuming `events` to
 *   completion or calling `kill()` are both safe teardown paths.
 */
export function spawnAgy(options: AgySpawnOptions): AgyProcessHandle {
  const child = spawn(options.binaryPath, [...options.args], {
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let stderrTail: Buffer = Buffer.alloc(0)
  const queue: AgyProcessEvent[] = []
  // Only ever resolved with a real event: `close()` marks `closed` instead of
  // resolving a waiter, because it always runs right after the one `push()`
  // for the terminal event, by which point no waiter is left outstanding.
  const waiters: Array<(event: AgyProcessEvent) => void> = []
  let closed = false

  const push = (event: AgyProcessEvent): void => {
    const waiter = waiters.shift()
    if (waiter !== undefined) waiter(event)
    else queue.push(event)
  }
  // Always called immediately after the one `push()` for the terminal event
  // (the 'close' handler below), so that push() has already resolved any
  // waiter that was outstanding; nothing here needs to drain a second one.
  const close = (): void => {
    closed = true
  }

  // A failed spawn (ENOENT, EACCES, …) emits 'error' on the child itself;
  // without this handler Node treats it as an uncaught exception and crashes
  // the process instead of letting this adapter report it.
  child.on('error', (error) => {
    push({ kind: 'spawn-error', error })
  })
  // Writing to a process that failed to spawn raises EPIPE/ERR_STREAM_DESTROYED
  // on stdin; the 'error' handler above already reports the one underlying failure.
  child.stdin.on('error', () => {})
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = boundedAppend(stderrTail, chunk)
  })
  child.on('close', (code, signal) => {
    push({ kind: 'exit', code, signal })
    close()
  })

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', (line) => {
    push({ kind: 'line', line })
  })

  child.stdin.write(options.input)
  child.stdin.end()

  async function* generate(): AsyncGenerator<AgyProcessEvent, void, void> {
    try {
      while (true) {
        const queued = queue.shift()
        if (queued !== undefined) {
          yield queued
          continue
        }
        if (closed) return
        const event = await new Promise<AgyProcessEvent>((resolve) => {
          waiters.push(resolve)
        })
        yield event
      }
    } finally {
      rl.close()
    }
  }

  return {
    events: generate(),
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    },
    stderrTail: () => stderrTail.toString('utf8'),
  }
}
