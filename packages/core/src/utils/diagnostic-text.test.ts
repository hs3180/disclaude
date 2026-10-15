import { afterEach, expect, it, vi } from 'vitest';
import { sanitizeDiagnosticText } from './diagnostic-text.js';

afterEach(() => vi.unstubAllEnvs());
it('preserves a rejection reason while removing credentials and private URL parameters', () => {
  vi.stubEnv('OWNED_APP_SECRET', 'private-synthetic-secret');
  const result = sanitizeDiagnosticText('HTTP 400 chat id invalid; private-synthetic-secret; Bearer unknown-key; app_secret="another-secret"; https://user:pass@provider.example/v1?token=private#fragment');
  expect(result).toContain('HTTP 400 chat id invalid');
  for (const value of ['private-synthetic-secret', 'unknown-key', 'another-secret', 'user:pass', '?token=', '#fragment']) {expect(result).not.toContain(value);}
});
