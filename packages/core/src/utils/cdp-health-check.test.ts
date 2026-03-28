/**
 * Unit tests for CDP Health Check utility.
 *
 * Tests CDP endpoint parsing, health checking, and error formatting.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseCdpEndpoint,
  checkCdpEndpointHealth,
  formatCdpHealthError,
  type CdpHealthCheckResult,
} from './cdp-health-check.js';

describe('CDP Health Check', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

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

    it('should parse endpoint from args with other flags', () => {
      const args = ['--verbose', '--cdp-endpoint=http://chrome:9222', '--other-flag'];
      expect(parseCdpEndpoint(args)).toBe('http://chrome:9222');
    });

    it('should return undefined when --cdp-endpoint is last arg with no value', () => {
      expect(parseCdpEndpoint(['--cdp-endpoint'])).toBeUndefined();
    });

    it('should handle HTTPS URLs', () => {
      expect(parseCdpEndpoint(['--cdp-endpoint=https://localhost:9222']))
        .toBe('https://localhost:9222');
    });

    it('should handle URLs with paths', () => {
      expect(parseCdpEndpoint(['--cdp-endpoint=http://localhost:9222/json']))
        .toBe('http://localhost:9222/json');
    });

    it('should ignore args that start with --cdp-endpoint but are different flags', () => {
      expect(parseCdpEndpoint(['--cdp-endpoint-extra=foo'])).toBeUndefined();
    });

    it('should return the first matching endpoint', () => {
      const args = ['--cdp-endpoint=http://first:9222', '--cdp-endpoint=http://second:9222'];
      expect(parseCdpEndpoint(args)).toBe('http://first:9222');
    });
  });

  describe('checkCdpEndpointHealth', () => {
    it('should return healthy when endpoint responds with 200', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ Browser: 'Chrome/120.0' }),
      });

      const result = await checkCdpEndpointHealth('http://localhost:9222');

      expect(result.healthy).toBe(true);
      expect(result.endpoint).toBe('http://localhost:9222');
      expect(result.error).toBeUndefined();
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://localhost:9222/json/version',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should return unhealthy when endpoint returns non-200 status', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const result = await checkCdpEndpointHealth('http://localhost:9222');

      expect(result.healthy).toBe(false);
      expect(result.error).toContain('500');
      expect(result.suggestion).toBeDefined();
    });

    it('should return unhealthy on connection refused', async () => {
      const connError = new Error('connect ECONNREFUSED 127.0.0.1:9999');
      (connError as Error & { code?: string }).code = 'ECONNREFUSED';
      globalThis.fetch = vi.fn().mockRejectedValue(connError);

      const result = await checkCdpEndpointHealth('http://localhost:9999');

      expect(result.healthy).toBe(false);
      expect(result.error).toContain('Connection refused');
      expect(result.suggestion).toBeDefined();
    });

    it('should return unhealthy on DNS failure', async () => {
      const dnsError = new Error('getaddrinfo ENOTFOUND nonexistent.invalid');
      (dnsError as Error & { code?: string }).code = 'ENOTFOUND';
      globalThis.fetch = vi.fn().mockRejectedValue(dnsError);

      const result = await checkCdpEndpointHealth('http://nonexistent.invalid:9222');

      expect(result.healthy).toBe(false);
      expect(result.error).toContain('DNS');
      expect(result.suggestion).toBeDefined();
    });

    it('should return unhealthy on timeout (AbortError)', async () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      globalThis.fetch = vi.fn().mockRejectedValue(abortError);

      const result = await checkCdpEndpointHealth('http://localhost:9222');

      expect(result.healthy).toBe(false);
      expect(result.error).toContain('timeout');
      expect(result.suggestion).toBeDefined();
    });

    it('should strip trailing slash from endpoint URL', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ Browser: 'Chrome' }),
      });

      await checkCdpEndpointHealth('http://localhost:9222/');

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://localhost:9222/json/version',
        expect.any(Object)
      );
    });

    it('should handle generic errors', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Unexpected error'));

      const result = await checkCdpEndpointHealth('http://localhost:9222');

      expect(result.healthy).toBe(false);
      expect(result.error).toContain('Unexpected error');
      expect(result.suggestion).toBeDefined();
    });

    it('should handle connection refused with lowercase message', async () => {
      const connError = new Error('connection refused');
      globalThis.fetch = vi.fn().mockRejectedValue(connError);

      const result = await checkCdpEndpointHealth('http://localhost:9222');

      expect(result.healthy).toBe(false);
      expect(result.error).toContain('Connection refused');
    });

    it('should handle DNS error with lowercase message', async () => {
      const dnsError = new Error('dns lookup failed');
      globalThis.fetch = vi.fn().mockRejectedValue(dnsError);

      const result = await checkCdpEndpointHealth('http://badhost:9222');

      expect(result.healthy).toBe(false);
      expect(result.error).toContain('DNS');
    });
  });

  describe('formatCdpHealthError', () => {
    it('should format error with all fields', () => {
      const result: CdpHealthCheckResult = {
        healthy: false,
        error: 'Connection refused',
        suggestion: 'Start Chrome with remote debugging',
        endpoint: 'http://localhost:9222',
      };

      const formatted = formatCdpHealthError(result);

      expect(formatted).toContain('Playwright MCP: CDP Endpoint Unavailable');
      expect(formatted).toContain('Connection refused');
      expect(formatted).toContain('http://localhost:9222');
      expect(formatted).toContain('Start Chrome with remote debugging');
    });

    it('should handle missing suggestion', () => {
      const result: CdpHealthCheckResult = {
        healthy: false,
        error: 'Unknown error',
        endpoint: 'http://localhost:9222',
      };

      const formatted = formatCdpHealthError(result);

      expect(formatted).toContain('Unknown error');
      expect(formatted).toContain('http://localhost:9222');
    });

    it('should handle missing endpoint', () => {
      const result: CdpHealthCheckResult = {
        healthy: false,
        error: 'Some error',
      };

      const formatted = formatCdpHealthError(result);

      expect(formatted).toContain('unknown');
    });

    it('should handle multiline suggestions with proper indentation', () => {
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
});
