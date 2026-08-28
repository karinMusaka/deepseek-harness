import { describe, expect, it } from 'vitest'
import { EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { mapDoneReason, mapUsage, translate } from '../src/translate.ts'

async function* lines(...values: string[]): AsyncGenerator<string> {
  for (const value of values) yield value
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

const done = (extra: string = ''): string =>
  `{"message":{"role":"assistant","content":""},"done":true,"done_reason":"stop"${extra}}`

describe('mapDoneReason', () => {
  it('maps the measured vocabulary and an absent reason', () => {
    expect(mapDoneReason('stop')).toEqual({ kind: 'stop' })
    expect(mapDoneReason(undefined)).toEqual({ kind: 'stop' })
    expect(mapDoneReason('length')).toEqual({ kind: 'max-tokens' })
  })

  it('surfaces an unrecognized reason as an error finish keyed by its uppercased value', () => {
    expect(mapDoneReason('load')).toEqual({
      kind: 'error',
      failure: { message: 'model stopped: load', code: 'LOAD' },
    })
  })
})

describe('mapUsage', () => {
  it('reports both counts as disjoint harness usage', () => {
    expect(mapUsage({ prompt_eval_count: 12, eval_count: 3 })).toEqual({ inputTokens: 12, outputTokens: 3 })
  })

  it('treats a single missing count as zero', () => {
    expect(mapUsage({ prompt_eval_count: 12 })).toEqual({ inputTokens: 12, outputTokens: 0 })
    expect(mapUsage({ eval_count: 3 })).toEqual({ inputTokens: 0, outputTokens: 3 })
  })

  it('reports no usage at all when the terminal line carried neither count', () => {
    expect(mapUsage({})).toBeUndefined()
  })
})

describe('translate', () => {
  it('streams text deltas and defers block-end, usage, and finish to the done line', async () => {
    const chunks = await collect(translate(lines(
      '{"message":{"role":"assistant","content":""},"done":false}',
      '{"message":{"role":"assistant","content":"he"},"done":false}',
      '{"message":{"role":"assistant","content":"llo"},"done":false}',
      done(',"prompt_eval_count":12,"eval_count":2'),
    )))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'he' },
      { type: 'text-delta', index: 0, text: 'llo' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
      { type: 'usage', usage: { inputTokens: 12, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('emits text carried by the terminal line before closing the block', async () => {
    const chunks = await collect(translate(lines(
      '{"message":{"content":"tail"},"done":true,"done_reason":"stop"}',
    )))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'tail' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'tail' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('opens no block for a line without a message', async () => {
    const chunks = await collect(translate(lines('{"done":false}', done())))
    expect(chunks).toEqual([{
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
      },
    }])
  })

  it('reports a completed stop with no content as EMPTY_RESPONSE', async () => {
    const chunks = await collect(translate(lines(done(',"prompt_eval_count":5,"eval_count":0'))))
    expect(chunks).toEqual([
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 0 } },
      {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
        },
      },
    ])
  })

  it('keeps a non-stop reason for a stream that opened no block', async () => {
    const chunks = await collect(translate(lines('{"done":true,"done_reason":"length"}')))
    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'max-tokens' } }])
  })

  it('reports the output cap as max-tokens', async () => {
    const chunks = await collect(translate(lines(
      '{"message":{"content":"Roman"},"done":false}',
      '{"message":{"content":""},"done":true,"done_reason":"length","prompt_eval_count":20,"eval_count":5}',
    )))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('aborts on a line that is not JSON', async () => {
    await expect(collect(translate(lines('not json')))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    await expect(collect(translate(lines('not json')))).rejects.toThrow(/malformed NDJSON line: not json/)
  })

  it('aborts on an in-band generation failure as a retryable server failure', async () => {
    await expect(collect(translate(lines(
      '{"message":{"content":"partial"},"done":false}',
      '{"error":"an error was encountered while running the model"}',
    )))).rejects.toMatchObject({
      code: 'SERVER',
      message: 'Ollama reported a generation failure: an error was encountered while running the model',
    })
  })

  it('aborts when the lines end without a done line', async () => {
    await expect(collect(translate(lines('{"message":{"content":"partial"},"done":false}'))))
      .rejects.toMatchObject({ code: 'STREAM_CLOSED' })
    await expect(collect(translate(lines()))).rejects.toThrow(LlmError)
  })
})
