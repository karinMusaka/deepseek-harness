import { describe, expect, it } from 'vitest'
import { redactCredentialShapedText } from '../src/index.ts'

describe('redactCredentialShapedText', () => {
  it('redacts the value half of a credential-shaped label/value pair, screening it before it reaches the model or the session log', () => {
    // This PR is the first to route native provider text into a model-visible
    // result and, through it, the `tool/result` session event — see the
    // failure-classification Agent Note.
    expect(redactCredentialShapedText('api_key=sk-should-not-leak-1234'))
      .toBe('api_key=[REDACTED]')
    expect(redactCredentialShapedText('Authorization failed: API_KEY: sk-abc-123'))
      .toBe('Authorization failed: API_KEY: [REDACTED]')
    expect(redactCredentialShapedText('auth_token="ghp_leaked_token_value"'))
      .toBe('auth_token="[REDACTED]"')
    expect(redactCredentialShapedText('client_secret=super-secret-value-here'))
      .toBe('client_secret=[REDACTED]')
    expect(redactCredentialShapedText('password=hunter2'))
      .toBe('password=[REDACTED]')
  })

  it('never redacts non-credential-shaped operational identifiers', () => {
    // The exact measured Codex 401 text carries `cf-ray` and a `request id`
    // — not secrets, but the property under test is that redaction is
    // scoped to the credential-shaped vocabulary, not "anything after a colon".
    const measured = 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, '
      + 'url: http://127.0.0.1:1/v1/responses, cf-ray: fake-cf-ray-measure, request id: req_measure'
    expect(redactCredentialShapedText(measured)).toBe(measured)
  })

  it('leaves text with no credential-shaped label unchanged', () => {
    const plain = 'Not logged in · Please run /login'
    expect(redactCredentialShapedText(plain)).toBe(plain)
  })

  it('redacts every occurrence in text with more than one credential-shaped pair', () => {
    const text = 'api_key=leak-one and also refresh_token=leak-two'
    const redacted = redactCredentialShapedText(text)
    expect(redacted).not.toContain('leak-one')
    expect(redacted).not.toContain('leak-two')
    expect(redacted).toBe('api_key=[REDACTED] and also refresh_token=[REDACTED]')
  })
})
