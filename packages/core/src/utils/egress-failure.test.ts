import { describe, expect, it } from 'vitest';
import { isEgressConnectivityFailure } from './egress-failure.js';

describe('isEgressConnectivityFailure (Issue #5409)', () => {
  it.each([
    // The field case: Codex account/workspace discovery dies before the model runs.
    'Codex turn failed: workspace routing discovery failed',
    'codex app-server: workspace routing timed out',
    // Node fetch/socket errno surfaces from any provider transport.
    'fetch failed',
    'connect ECONNREFUSED 127.0.0.1:443',
    'connect ETIMEDOUT 104.18.7.10:443',
    'getaddrinfo ENOTFOUND auth.openai.com',
    'socket hang up',
    'network error: unable to reach upstream',
    'unable to connect to the proxy server',
    'TLS handshake failed',
    'SSL_ERROR_SYSCALL',
  ])('classifies %j as an egress failure', text => {
    expect(isEgressConnectivityFailure(text)).toBe(true);
  });

  it.each([
    // Credentials/quota/capacity: a network hint here would misdirect users.
    'workspace routing unauthorized (401)',
    'unauthorized',
    'usage limit reached',
    'the model is at capacity',
    'insufficient permissions for tool',
    // Ambiguous timing: a bare timeout can be model latency, not egress.
    'request timed out after 60000ms',
    'tool execution exceeded the deadline',
    // Ordinary provider failures.
    'invalid request: unknown model id',
    'turn aborted by user',
  ])('does not classify %j as an egress failure', text => {
    expect(isEgressConnectivityFailure(text)).toBe(false);
  });
});
