import { describe, expect, it } from 'vitest'
import { parseToolCallResponse } from '../src/tool-protocol.ts'

describe('parseToolCallResponse', () => {
  it('parses an unfenced JSON object with one call and no prose', () => {
    const result = parseToolCallResponse('{"tool_calls":[{"name":"get_time","arguments":{}}]}')
    expect(result).toEqual({ prose: '', calls: [{ name: 'get_time', arguments: {} }] })
  })

  it('parses a fenced ```json block with no prose', () => {
    const result = parseToolCallResponse('```json\n{"tool_calls":[{"name":"get_time","arguments":{"tz":"UTC"}}]}\n```')
    expect(result).toEqual({ prose: '', calls: [{ name: 'get_time', arguments: { tz: 'UTC' } }] })
  })

  it('extracts prose surrounding a fenced block', () => {
    const result = parseToolCallResponse('Sure, one moment.\n```json\n{"tool_calls":[{"name":"get_time","arguments":{}}]}\n```\nThanks for waiting.')
    expect(result?.prose).toBe('Sure, one moment.\n\nThanks for waiting.')
    expect(result?.calls).toEqual([{ name: 'get_time', arguments: {} }])
  })

  it('parses multiple calls in one array', () => {
    const result = parseToolCallResponse(JSON.stringify({
      tool_calls: [
        { name: 'get_time', arguments: {} },
        { name: 'get_weather', arguments: { city: 'Tokyo' } },
      ],
    }))
    expect(result?.calls).toHaveLength(2)
    expect(result?.calls[1]).toEqual({ name: 'get_weather', arguments: { city: 'Tokyo' } })
  })

  it('returns undefined for plain prose with no JSON at all', () => {
    expect(parseToolCallResponse('I do not need any tools for that.')).toBeUndefined()
  })

  it('returns undefined for invalid JSON inside a fence', () => {
    expect(parseToolCallResponse('```json\n{not valid json\n```')).toBeUndefined()
  })

  it('returns undefined for well-formed JSON missing tool_calls', () => {
    expect(parseToolCallResponse('{"answer":"no tools needed"}')).toBeUndefined()
  })

  it('returns undefined for an empty tool_calls array', () => {
    expect(parseToolCallResponse('{"tool_calls":[]}')).toBeUndefined()
  })

  it('returns undefined when tool_calls is not an array', () => {
    expect(parseToolCallResponse('{"tool_calls":"get_time"}')).toBeUndefined()
  })

  it('returns undefined when a call is missing a string name', () => {
    expect(parseToolCallResponse('{"tool_calls":[{"arguments":{}}]}')).toBeUndefined()
  })

  it('returns undefined when a call name is empty', () => {
    expect(parseToolCallResponse('{"tool_calls":[{"name":"","arguments":{}}]}')).toBeUndefined()
  })

  it('returns undefined when arguments is missing', () => {
    expect(parseToolCallResponse('{"tool_calls":[{"name":"get_time"}]}')).toBeUndefined()
  })

  it('returns undefined when arguments is not an object', () => {
    expect(parseToolCallResponse('{"tool_calls":[{"name":"get_time","arguments":"now"}]}')).toBeUndefined()
  })

  it('returns undefined when arguments is an array', () => {
    expect(parseToolCallResponse('{"tool_calls":[{"name":"get_time","arguments":[]}]}')).toBeUndefined()
  })

  it('returns undefined for a top-level JSON array instead of an object', () => {
    expect(parseToolCallResponse('[1,2,3]')).toBeUndefined()
  })

  it('returns undefined for a top-level JSON primitive (not an object at all)', () => {
    expect(parseToolCallResponse('42')).toBeUndefined()
    expect(parseToolCallResponse('"hello"')).toBeUndefined()
  })

  it('returns undefined when a tool_calls entry is not an object', () => {
    expect(parseToolCallResponse('{"tool_calls":["not-an-object"]}')).toBeUndefined()
  })

  it('returns undefined for an empty or whitespace-only response', () => {
    expect(parseToolCallResponse('')).toBeUndefined()
    expect(parseToolCallResponse('   \n  ')).toBeUndefined()
  })

  it('tolerates a fence with no trailing newline before the closing marker', () => {
    const result = parseToolCallResponse('```json\n{"tool_calls":[{"name":"get_time","arguments":{}}]}```')
    expect(result?.calls).toEqual([{ name: 'get_time', arguments: {} }])
  })
})
