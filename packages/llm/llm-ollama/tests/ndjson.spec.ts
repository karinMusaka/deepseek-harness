import { describe, expect, it, vi } from 'vitest'
import { parseNdjson } from '../src/ndjson.ts'

/**
 * Line framing only. Termination and every protocol code belong to
 * `translate`, so nothing here asserts a stream outcome.
 */

/** Build an NDJSON byte stream from string fragments (fragments = network reads). */
function bytes(...fragments: string[]): ReadableStream<Uint8Array<ArrayBuffer>> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const fragment of fragments) controller.enqueue(encoder.encode(fragment))
      controller.close()
    },
  })
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = []
  for await (const item of stream) out.push(item)
  return out
}

describe('parseNdjson', () => {
  it('yields one value per terminated line', async () => {
    expect(await collect(parseNdjson(bytes('{"a":1}\n{"b":2}\n')))).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('reassembles a line split across reads', async () => {
    expect(await collect(parseNdjson(bytes('{"a":', '1}\n{"b"', ':2}\n')))).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('reassembles a multibyte character split mid-sequence', async () => {
    const encoded = new TextEncoder().encode('{"a":"日"}\n')
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 8))
        controller.enqueue(encoded.slice(8))
        controller.close()
      },
    })
    expect(await collect(parseNdjson(stream))).toEqual(['{"a":"日"}'])
  })

  it('skips blank and whitespace-only lines and strips a CR terminator', async () => {
    expect(await collect(parseNdjson(bytes('\n{"a":1}\r\n   \n{"b":2}\n')))).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('drops a non-empty unterminated tail at end of stream', async () => {
    // Spec-strict framing: a healthy Ollama stream terminates its final line,
    // so an unterminated tail is truncation. `translate` turns the missing
    // terminal line into STREAM_CLOSED.
    expect(await collect(parseNdjson(bytes('{"a":1}\n{"b"')))).toEqual(['{"a":1}'])
  })

  it('yields nothing for an empty stream', async () => {
    expect(await collect(parseNdjson(bytes()))).toEqual([])
  })

  it('reports one activity callback per yielded line and none for blank lines', async () => {
    const onLine = vi.fn()
    await collect(parseNdjson(bytes('{"a":1}\n\n{"b":2}\n'), onLine))
    expect(onLine).toHaveBeenCalledTimes(2)
  })
})
