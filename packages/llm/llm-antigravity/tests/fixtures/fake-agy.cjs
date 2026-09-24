// Scripted fake agy CLI for llm-antigravity tests. Not executed directly from
// git (no shebang, no exec bit committed): `tests/support/fake-agy.ts` writes
// a fresh runtime copy with a `#!/usr/bin/env node` shebang and 0o755 mode per
// test run, so behavior never depends on git preserving a file mode.
//
// Scenario selection: `agy models` (argv[0] === 'models') reads
// FAKE_AGY_MODELS_SCENARIO ('ok' | 'empty' | 'fail'; default 'ok'). Every
// other invocation reads `--model <scenario>` and answers with the matching
// canned NDJSON sequence (see the switch below for the full scenario list).
'use strict'

const fs = require('node:fs')

function writeLine(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

function readModelArg(argv) {
  const idx = argv.indexOf('--model')
  return idx >= 0 ? argv[idx + 1] : undefined
}

function readStdin() {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { data += chunk })
    process.stdin.on('end', () => resolve(data))
  })
}

function runModelsSubcommand() {
  const scenario = process.env.FAKE_AGY_MODELS_SCENARIO ?? 'ok'
  if (scenario === 'fail') {
    process.stderr.write('agy: could not reach the model catalog\n')
    process.exitCode = 1
    return
  }
  if (scenario === 'crash') {
    process.kill(process.pid, 'SIGKILL')
    return
  }
  process.stdout.write('Fetching available models...\n')
  if (scenario === 'ok') {
    // A blank/whitespace-only line (no tab-separated id/name pair) is banner
    // or log noise a real deployment could emit; it must be skipped, not
    // parsed as a model.
    process.stdout.write('  \t  \n')
    process.stdout.write('gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n')
    process.stdout.write('claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n')
  }
  // 'empty' prints only the banner line, exercising a catalog with no rows.
}

async function runScenario(model) {
  if (model === 'exit-without-reading-stdin') {
    // Exits before ever consuming stdin, so a large write from the parent
    // lands on a pipe whose reader is already gone (EPIPE).
    process.exit(0)
  }
  if (model === 'self-kill') {
    // Dies by signal with no output at all, unrelated to any caller abort.
    process.kill(process.pid, 'SIGKILL')
  }
  await readStdin()
  writeLine({ event: 'init', init: { model: model ?? '', cwd: process.cwd(), tools: [], permission_mode: 'default' } })

  switch (model) {
    case 'text-stream': {
      // A state-only update with no text_delta (a step starting/finishing
      // with nothing to show) must be skipped rather than yielding an empty delta.
      writeLine({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: 0, state: 'ACTIVE', step_type: 'agent_response' } })
      process.stdout.write('\n') // blank line: framing noise, must be skipped
      writeLine({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: 0, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Hello, ' } })
      writeLine({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: 0, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'world!', usage: { input_tokens: 6, output_tokens: 2, total_tokens: 8 } } })
      writeLine({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'Hello, world!', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, cache_read_tokens: 2, thinking_tokens: 1 } } })
      break
    }
    case 'text-no-delta': {
      // No text_delta lines at all; only the terminal result carries the text.
      writeLine({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'whole response at once', usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 } } })
      break
    }
    case 'text-stream-no-response-field': {
      // The terminal result omits `response` entirely; the streamed deltas are authoritative.
      writeLine({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: 0, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'streamed only' } })
      writeLine({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS' } })
      break
    }
    case 'tool-fenced': {
      writeLine({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: 0, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'thinking...' } })
      const payload = `\`\`\`json\n${JSON.stringify({ tool_calls: [{ name: 'get_time', arguments: {} }] })}\n\`\`\``
      writeLine({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: payload, usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 } } })
      break
    }
    case 'tool-fenced-prose': {
      const payload = `Sure, let me check.\n\`\`\`json\n${JSON.stringify({ tool_calls: [{ name: 'get_time', arguments: { tz: 'UTC' } }] })}\n\`\`\``
      writeLine({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: payload } })
      break
    }
    case 'tool-unfenced': {
      const payload = JSON.stringify({
        tool_calls: [
          { name: 'get_time', arguments: {} },
          { name: 'get_weather', arguments: { city: 'Tokyo' } },
        ],
      })
      writeLine({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: payload } })
      break
    }
    case 'tool-invalid-json': {
      writeLine({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: '```json\n{not valid json\n```', usage: { input_tokens: 12, output_tokens: 9, total_tokens: 21 } } })
      break
    }
    case 'tool-non-json-reply': {
      writeLine({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'I do not need any tools for that.' } })
      break
    }
    case 'result-error': {
      writeLine({ event: 'result', result: { conversation_id: 'c1', status: 'ERROR', error: 'agy: generation failed' } })
      break
    }
    case 'result-error-no-message': {
      writeLine({ event: 'result', result: { conversation_id: 'c1', status: 'ERROR' } })
      break
    }
    case 'denied-empty': {
      writeLine({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: '', denied_actions: [{ action: 'run_command', display_name: 'Run Command' }] } })
      break
    }
    case 'empty-no-denial': {
      writeLine({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: '', usage: { input_tokens: 5, output_tokens: 0, total_tokens: 5 } } })
      break
    }
    case 'empty-no-denial-no-usage': {
      writeLine({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: '' } })
      break
    }
    case 'nonzero-exit': {
      process.stderr.write('agy: fatal transport error\n')
      process.exitCode = 3
      break
    }
    case 'missing-result': {
      writeLine({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: 0, state: 'DONE', step_type: 'agent_response', text_delta: 'partial' } })
      break
    }
    case 'malformed-line': {
      process.stdout.write('not-json-at-all\n')
      break
    }
    case 'cwd-echo': {
      writeLine({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: process.cwd() } })
      break
    }
    case 'hang': {
      await new Promise(() => {})
      break
    }
    case 'hang-after-delta': {
      writeLine({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: 0, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'partial...' } })
      await new Promise(() => {})
      break
    }
    default: {
      writeLine({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: `unknown scenario: ${String(model)}` } })
    }
  }
}

async function main() {
  const cwdMarker = process.env.FAKE_AGY_CWD_MARKER
  if (cwdMarker !== undefined && cwdMarker.length > 0) fs.writeFileSync(cwdMarker, process.cwd())

  const argv = process.argv.slice(2)
  if (argv[0] === 'models') {
    runModelsSubcommand()
    return
  }
  await runScenario(readModelArg(argv))
}

main()
