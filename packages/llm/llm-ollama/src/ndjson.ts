/**
 * Decode an NDJSON byte stream into complete lines. Framing only: chunk
 * reassembly and UTF-8 continuation across reads are `TextDecoderStream`'s,
 * and this module adds line splitting, `\r\n` tolerance, and blank-line
 * skipping. It knows nothing about the Ollama protocol — the terminal line is
 * identified by a JSON field, so {@link translate} owns termination and every
 * protocol failure code.
 *
 * @module dsh-llm-ollama/ndjson
 */

/**
 * Parse an NDJSON byte stream into complete lines.
 *
 * A line is yielded only once its `\n` terminator arrives, so a non-empty
 * unterminated tail at end of stream is dropped as truncation. Dropping it
 * cannot hide a complete response: a healthy Ollama stream terminates its
 * final line, and a consumer that never saw a terminal line fails with
 * `STREAM_CLOSED`.
 * @param stream - raw NDJSON bytes; reads may split anywhere, including mid-UTF-8 sequence and mid-line.
 * @param onLine - optional transport-activity callback, invoked once per yielded line. Every line
 *   is a payload here, so a line that translates to no chunk still has to rearm a caller's idle watchdog.
 * @returns each non-blank line in arrival order, terminator stripped.
 */
export async function* parseNdjson(
  stream: ReadableStream<BufferSource>,
  onLine?: () => void,
): AsyncGenerator<string> {
  let buffered = ''
  for await (const text of stream.pipeThrough(new TextDecoderStream())) {
    buffered += text
    let terminator = buffered.indexOf('\n')
    while (terminator >= 0) {
      const line = buffered.slice(0, terminator).trim()
      buffered = buffered.slice(terminator + 1)
      if (line.length > 0) {
        onLine?.()
        yield line
      }
      terminator = buffered.indexOf('\n')
    }
  }
}
