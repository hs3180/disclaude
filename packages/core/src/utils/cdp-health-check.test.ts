/**
 * Tests for CDP health check utility (packages/core/src/utils/cdp-health-check.ts)
 *
 * Tests Chrome DevTools Protocol endpoint health checking:
 * - parseCdpEndpoint: Parse CDP endpoint from CLI args
 * - checkCdpEndpointHealth: Verify CDP endpoint availability
 * - formatCdpHealthError: Format error messages for display
 *
 * Issue #1617: test: 提升单元测试覆盖率至 70%
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  parseCdpEndpoint,
  checkCdpEndpointHealth,
  formatCdpHealthError,
  type CdpHealthCheckResult,
} from './cdp-health-check.js';

describe('parseCdpEndpoint', () => {
  it('should return undefined for empty args', () => {
    expect(parseCdpEndpoint()).toBeUndefined();
    expect(parseCdpEndpoint([])).toBeUndefined();
  });

  it('should parse --cdp-endpoint=<url> format', () => {
    expect(parseCdpEndpoint(['--cdp-endpoint=http://localhost:9222']))
      .toBe('http://localhost:9222');
  });

  it('should parse --cdp-endpoint <url> format (separate args)', () => {
    expect(parseCdpEndpoint(['--cdp-endpoint', 'http://localhost:9222']))
      .toBe('http://localhost:9222');
  });

  it('should return undefined when --cdp-endpoint is last arg with no value', () => {
    expect(parseCdpEndpoint(['--cdp-endpoint'])).toBeUndefined();
  });

  it('should handle endpoint with path', () => {
    expect(parseCdpEndpoint(['--cdp-endpoint=http://localhost:9222/devtools']))
      .toBe('http://localhost:9222/devtools');
  });

  it('should ignore unrelated args', () => {
    expect(parseCdpEndpoint(['--port', '3000', '--verbose']))
      .toBeUndefined();
  });

  it('should find endpoint among other args', () => {
    expect(parseCdpEndpoint(['--port', '3000', '--cdp-endpoint=http://chrome:9222', '--verbose']))
      .toBe('http://chrome:9222');
  });

  it('should handle empty value after = sign', () => {
    expect(parseCdpEndpoint(['--cdp-endpoint=']))
      .toBe('');
  });
});

describe('checkCdpEndpointHealth', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should return healthy when endpoint responds with 200', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ Browser: 'Chrome/120.0' }),
    });

    const result = await checkCdpEndpointHealth('http://localhost:9222');

    expect(result.healthy).toBe(true);
    expect(result.endpoint).toBe('http://localhost:9222');
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:9222/json/version',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('should strip trailing slash from endpoint URL', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ Browser: 'Chrome' }),
    });

    await checkCdpEndpointHealth('http://localhost:9222/');

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:9222/json/version',
      expect.anything()
    );
  });

  it('should return unhealthy when endpoint returns non-200 status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({}),
    });

    const result = await checkCdpEndpointHealth('http://localhost:9222');

    expect(result.healthy).toBe(false);
    expect(result.error).toContain('503');
    expect(result.suggestion).toContain('Chrome is running');
  });

  it('should return unhealthy on connection refused', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(
      new Error('connect ECONNREFUSED 127.0.0.1:9222')
    );

    const result = await checkCdpEndpointHealth('http://localhost:9222');

    expect(result.healthy).toBe(false);
    expect(result.error).toContain('Connection refused');
    expect(result.suggestion).toContain('remote debugging');
  });

  it('should return unhealthy on timeout (AbortError)', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    globalThis.fetch = vi.fn().mockRejectedValue(abortError);

    const result = await checkCdpEndpointHealth('http://localhost:9222');

    expect(result.healthy).toBe(false);
    expect(result.error).toContain('timeout');
  });

  it('should return unhealthy on DNS failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(
      new Error('getaddrinfo ENOTFOUND chrome.example.com')
    );

    const result = await checkCdpEndpointHealth('http://chrome.example.com:9222');

    expect(result.healthy).toBe(false);
    expect(result.error).toContain('DNS');
  });

  it('should return unhealthy with generic error for unknown errors', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(
      new Error('Something unexpected happened')
    );

    const result = await checkCdpEndpointHealth('http://localhost:9222');

    expect(result.healthy).toBe(false);
    expect(result.error).toBe('Something unexpected happened');
  });
});

describe('formatCdpHealthError', () => {
  it('should format error with suggestion', () => {
    const result: CdpHealthCheckResult = {
      healthy: false,
      error: 'Connection refused',
      suggestion: 'Start Chrome with remote debugging',
      endpoint: 'http://localhost:9222',
    };

    const formatted = formatCdpHealthError(result);

    expect(formatted).toContain('Connection refused');
    expect(formatted).toContain('http://localhost:9222');
    expect(formatted).toContain('Start Chrome with remote debugging');
    expect(formatted).toContain('CDP Endpoint Unavailable');
  });

  it('should format error without suggestion', () => {
    const result: CdpHealthCheckResult = {
      healthy: false,
      error: 'Unknown error',
      endpoint: 'http://localhost:9222',
    };

    const formatted = formatCdpHealthError(result);

    expect(formatted).toContain('Unknown error');
    expect(formatted).toContain('http://localhost:9222');
  });

  it('should format error without endpoint', () => {
    const result: CdpHealthCheckResult = {
      healthy: false,
      error: 'No endpoint configured',
    };

    const formatted = formatCdpHealthError(result);

    expect(formatted).toContain('unknown');
  });

  it('should handle multi-line suggestions with indentation', () => {
    const result: CdpHealthCheckResult = {
      healthy: false,
      error: 'Connection refused',
      suggestion: 'Line 1\nLine 2\nLine 3',
      endpoint: 'http://localhost:9222',
    };

    const formatted = formatCdpHealthError(result);

    expect(formatted).toContain('  Line 1');
    expect(formatted).toContain('  Line 2');
    expect(formatted).toContain('  Line 3');
  });
});
