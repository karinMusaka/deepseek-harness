/**
 * Local `/api/chat` stand-in for the real `llm-ollama` adapter: replays one
 * scripted NDJSON answer per request and records the request bodies, so a
 * composition test can assert the exact wire content the vision route received.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

/** One received request body, parsed. */
interface OllamaRequestBody {
  model: string
  messages: { role: string; content: string; images?: string[] }[]
  options?: { num_predict?: number }
}

export interface MockOllamaServer {
  url: string
  /** Bodies of received requests, in order. */
  requests: OllamaRequestBody[]
  close(): Promise<void>
}

const servers: Server[] = []

/** Close every server opened since the last call; run from each spec's afterEach. */
export async function closeMockOllamaServers(): Promise<void> {
  await Promise.all(servers.splice(0).map(server => new Promise((resolve) => { server.close(resolve) })))
}

/** The NDJSON lines Ollama emits for one complete text answer. */
function answerLines(content: string): string[] {
  return [
    JSON.stringify({ model: 'm', message: { role: 'assistant', content }, done: false }),
    JSON.stringify({
      model: 'm',
      message: { role: 'assistant', content: '' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 3,
      eval_count: 8,
    }),
  ]
}

/**
 * Start a scripted Ollama chat endpoint.
 * @param answers - one complete answer per expected request, in order.
 * @returns the running server's base URL, recorded requests, and closer.
 */
export async function mockOllamaServer(answers: readonly string[]): Promise<MockOllamaServer> {
  const script = [...answers]
  const requests: OllamaRequestBody[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      requests.push(JSON.parse(body) as OllamaRequestBody)
      const answer = script.shift()
      if (answer === undefined) {
        response.writeHead(500).end('mock script exhausted')
        return
      }
      response.writeHead(200, { 'content-type': 'application/x-ndjson' })
      response.end(answerLines(answer).map(line => `${line}\n`).join(''))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock Ollama server has no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => { server.close(() => { resolve() }) }),
  }
}
