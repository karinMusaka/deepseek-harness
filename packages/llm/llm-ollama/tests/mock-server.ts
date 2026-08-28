import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

/** One scripted behavior for the next request the mock server receives. */
export type Behavior =
  | { kind: 'ndjson'; lines: string[]; delayMs?: number }
  | { kind: 'http-error'; status: number; body: string; contentType?: string }
  | { kind: 'close-early'; lines: string[] }

export interface MockServer {
  url: string
  /** Bodies of received requests, in order. */
  requests: unknown[]
  /** Header bags of received requests, in order (parallel to `requests`). */
  headers: IncomingMessage['headers'][]
  script: Behavior[]
  close(): Promise<void>
}

const servers: Server[] = []

/** Close every server opened since the last call; run from each spec's afterEach. */
export async function closeMockServers(): Promise<void> {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
}

/** A minimal complete text generation, reused by request-shape assertions. */
export const textLines = [
  '{"model":"m","message":{"role":"assistant","content":""},"done":false}',
  '{"model":"m","message":{"role":"assistant","content":"hello"},"done":false}',
  '{"model":"m","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop"'
  + ',"prompt_eval_count":3,"eval_count":1}',
]

/** Local `/api/chat` stand-in: replays scripted behaviors per request, one JSON object per line. */
export async function mockServer(script: Behavior[]): Promise<MockServer> {
  const requests: unknown[] = []
  const headers: IncomingMessage['headers'][] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      headers.push(request.headers)
      const behavior = script.shift()
      if (!behavior) {
        response.writeHead(500).end('mock script exhausted')
        return
      }
      if (behavior.kind === 'http-error') {
        response.writeHead(behavior.status, { 'content-type': behavior.contentType ?? 'application/json' })
        response.end(behavior.body)
        return
      }
      response.writeHead(200, { 'content-type': 'application/x-ndjson' })
      const write = (index: number): void => {
        if (index >= behavior.lines.length) {
          if (behavior.kind === 'ndjson') response.end()
          else response.destroy() // close-early: drop the socket mid-stream
          return
        }
        response.write(`${behavior.lines[index]}\n`)
        setTimeout(() => { write(index + 1) }, behavior.kind === 'ndjson' ? behavior.delayMs ?? 0 : 5)
      }
      write(0)
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    headers,
    script,
    close: () => new Promise(resolve => server.close(() => { resolve() })),
  }
}
