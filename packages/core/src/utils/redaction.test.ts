import { describe, expect, it } from 'vitest';
import { redactSensitive, redactSensitiveText } from './redaction.js';

describe('credential value redaction', () => {
  it.each([
    'request Authorization: Bearer synthetic-credential failed',
    'https://example.test/path?api_key=synthetic-credential&operation=probe',
    'DSH_API_KEY="synthetic-credential"',
    "password='synthetic-credential'",
    'https://user:synthetic-credential@example.test/path',
    'cookie: sid=synthetic-credential; other=value',
    'set-cookie: sid=synthetic-credential; HttpOnly',
    '{"api_key":"synthetic-credential"}',
    '-----BEGIN PRIVATE KEY-----\nsynthetic-credential\n-----END PRIVATE KEY-----',
  ])('removes labelled values from %s', input => {
    const result = redactSensitiveText(input);
    expect(result).not.toContain('synthetic-credential');
    expect(result).toContain('[REDACTED]');
  });

  it.each(['ghs_synthetic123456789', 'github_pat_synthetic123456789', 'sk-proj-synthetic123456789'])('removes standalone credential forms', token => {
    expect(redactSensitiveText(`stderr: ${token}`)).toBe('stderr: [REDACTED]');
  });

  it('preserves diagnostic identity while redacting nested errors without mutation', () => {
    const cause = new Error('token=synthetic-credential');
    const error = Object.assign(new Error('HTTP request failed', { cause }), {
      status: 401, headers: { Authorization: 'synthetic-credential' },
    });
    const input = { runId: 'run-1', sessionKey: 'chat-1', error, nested: [{ api_key: 'synthetic-credential' }] };
    const output = redactSensitive(input);
    expect(JSON.stringify(output)).not.toContain('synthetic-credential');
    expect(output).toMatchObject({ runId: 'run-1', sessionKey: 'chat-1', error: { status: 401, type: 'Error', cause: { message: 'token=[REDACTED]' } } });
    expect(error.headers.Authorization).toBe('synthetic-credential');
    expect(cause.message).toBe('token=synthetic-credential');
  });

  it('handles cycles and repeated objects without invoking accessors', () => {
    const input: Record<string, unknown> = { token: 'secret' };
    input.self = input;
    Object.defineProperty(input, 'getter', { enumerable: true, get() { throw new Error('must not run'); } });
    expect(redactSensitive(input)).toMatchObject({ token: '[REDACTED]', self: '[Circular]', getter: '[Accessor]' });
    expect(redactSensitive([input, input])).toEqual([redactSensitive(input), redactSensitive(input)]);
  });
});
