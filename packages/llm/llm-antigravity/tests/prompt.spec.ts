import { describe, expect, it } from 'vitest'
import {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ImageBlock } from '@deepseek-ai/dsh-llm'
import { buildPrompt, COMPLETION_BACKEND_PREAMBLE, TOOL_CALL_PROTOCOL } from '../src/prompt.ts'

function baseOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'antigravity',
    model: 'gemini-3.8-flash-high',
    messages: [
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }),
    ],
    ...overrides,
  }
}

describe('buildPrompt', () => {
  it('always leads with the fixed completion-backend preamble', () => {
    const { text } = buildPrompt(baseOptions())
    expect(text.startsWith(COMPLETION_BACKEND_PREAMBLE)).toBe(true)
  })

  it('includes system text when present and omits it when absent', () => {
    const withSystem = buildPrompt(baseOptions({ system: 'Be terse.' }))
    expect(withSystem.text).toContain('[System]\nBe terse.')

    const withoutSystem = buildPrompt(baseOptions())
    expect(withoutSystem.text).not.toContain('[System]')
  })

  it('omits an empty system string the same as an absent one', () => {
    const { text } = buildPrompt(baseOptions({ system: '' }))
    expect(text).not.toContain('[System]')
  })

  it('reports toolsRequested false and appends nothing when no tools are given', () => {
    const { text, toolsRequested } = buildPrompt(baseOptions())
    expect(toolsRequested).toBe(false)
    expect(text).not.toContain('[Available Tools]')
    expect(text).not.toContain(TOOL_CALL_PROTOCOL)
  })

  it('reports toolsRequested false for an empty tools array', () => {
    const { toolsRequested } = buildPrompt(baseOptions({ tools: [] }))
    expect(toolsRequested).toBe(false)
  })

  it('appends the tool schema JSON and the fixed calling protocol when tools are given', () => {
    const { text, toolsRequested } = buildPrompt(baseOptions({
      tools: [{ name: 'get_time', description: 'Get the time', parameters: { type: 'object', properties: {} } }],
    }))
    expect(toolsRequested).toBe(true)
    expect(text).toContain('[Available Tools]')
    expect(text).toContain('"get_time"')
    expect(text).toContain(TOOL_CALL_PROTOCOL)
  })

  it('renders a user message under a USER label', () => {
    const { text } = buildPrompt(baseOptions())
    expect(text).toContain('[USER]\nhello')
  })

  it('renders an assistant message under an ASSISTANT label', () => {
    const { text } = buildPrompt(baseOptions({
      messages: [
        createAssistantMessage({
          content: [{ type: 'text', text: 'hi there' }],
          source: { provider: 'antigravity', model: 'gemini-3.8-flash-high' },
        }),
      ],
    }))
    expect(text).toContain('[ASSISTANT]\nhi there')
  })

  it('falls back to the provider-neutral role, uppercased, for an unrecognized merge-extended source kind', () => {
    const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] })
    const withUnknownSource = { ...message, source: { kind: 'future-producer' } } as unknown as typeof message
    const { text } = buildPrompt(baseOptions({ messages: [withUnknownSource] }))
    expect(text).toContain('[USER]\nx')
  })

  it('renders a plugin-sourced message under a CONTEXT label', () => {
    const { text } = buildPrompt(baseOptions({
      messages: [
        createUserMessage({
          source: { kind: 'plugin', plugin: 'todo' },
          content: [{ type: 'text', text: 'todo list' }],
        }),
      ],
    }))
    expect(text).toContain('[CONTEXT]\ntodo list')
  })

  it('renders reasoning blocks as bracketed text rather than dropping them', () => {
    const { text } = buildPrompt(baseOptions({
      messages: [
        createAssistantMessage({
          content: [{ type: 'reasoning', text: 'thinking it through' }],
          source: { provider: 'antigravity', model: 'gemini-3.8-flash-high' },
        }),
      ],
    }))
    expect(text).toContain('[reasoning] thinking it through')
  })

  it('renders a tool-call block with its id and name inline', () => {
    const { text } = buildPrompt(baseOptions({
      messages: [
        createAssistantMessage({
          content: [{ type: 'tool-call', id: CallId('call-1'), name: 'get_time', arguments: '{}' }],
          source: { provider: 'antigravity', model: 'gemini-3.8-flash-high' },
        }),
      ],
    }))
    expect(text).toContain('[tool-call call-1 get_time] {}')
  })

  it('renders a tool-result message under a labeled TOOL RESULT header, with an error marker when failed', () => {
    const ok = buildPrompt(baseOptions({
      messages: [createToolResultMessage({ callId: CallId('call-1'), content: [{ type: 'text', text: '12:00' }], isError: false })],
    }))
    expect(ok.text).toContain('[TOOL RESULT (call-1)]')
    expect(ok.text).toContain('[tool-result call-1] 12:00')

    const failed = buildPrompt(baseOptions({
      messages: [createToolResultMessage({ callId: CallId('call-2'), content: [{ type: 'text', text: 'boom' }], isError: true })],
    }))
    expect(failed.text).toContain('[tool-result call-2 error] boom')
  })

  it('throws UNSUPPORTED_CONTENT for an image block anywhere in history', () => {
    const imageBlock: ImageBlock = { type: 'image', attachment: { id: 'att-1' } as unknown as ImageBlock['attachment'] }
    try {
      buildPrompt(baseOptions({
        messages: [createUserMessage({ source: { kind: 'user' }, content: [imageBlock] })],
      }))
      expect.fail('buildPrompt must throw for image content')
    } catch (error) {
      expect(error).toBeInstanceOf(LlmError)
      expect((error as LlmError).code).toBe('UNSUPPORTED_CONTENT')
    }
  })

  it('throws UNSUPPORTED_CONTENT for an image nested inside a tool result', () => {
    const imageBlock: ImageBlock = { type: 'image', attachment: { id: 'att-1' } as unknown as ImageBlock['attachment'] }
    try {
      buildPrompt(baseOptions({
        messages: [createToolResultMessage({ callId: CallId('call-1'), content: [imageBlock], isError: false })],
      }))
      expect.fail('buildPrompt must throw for a nested image tool result')
    } catch (error) {
      expect(error).toBeInstanceOf(LlmError)
      expect((error as LlmError).code).toBe('UNSUPPORTED_CONTENT')
    }
  })
})
