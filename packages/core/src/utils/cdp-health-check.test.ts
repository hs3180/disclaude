/**
 * Tests for CDP health check utility (packages/core/src/utils/cdp-health-check.ts)
 *
 * Validates CDP endpoint parsing, health checking, and error formatting.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseCdpEndpoint,
  checkCdpEndpointHealth,
  formatCdpHealthError,
  type CdpHealthCheckResult,
} from './cdp-health-check.js';

describe('CDP Health Check', () => {
  describe('parseCdpEndpoint', () => {
    it('should return undefined for empty args', () => {
      expect(parseCdpEndpoint([])).toBeUndefined();
    });

    it('should return undefined when no cdp-endpoint arg present', () => {
      expect(parseCdpEndpoint(['--other', 'value'])).toBeUndefined();
    });

    it('should parse --cdp-endpoint=<url> format', () => {
      const result = parseCdpEndpoint(['--cdp-endpoint=http://localhost:9222']);
      expect(result).toBe('http://localhost:9222');
    });

    it('should parse --cdp-endpoint <url> format', () => {
      const result = parseCdpEndpoint(['--cdp-endpoint', 'http://localhost:9222']);
      expect(result).toBe('http://localhost:9222');
    });

    it('should return undefined when --cdp-endpoint is last arg without value', () => {
      expect(parseCdpEndpoint(['--cdp-endpoint'])).toBeUndefined();
    });

    it('should find cdp-endpoint among other args', () => {
      const result = parseCdpEndpoint(['--port', '3000', '--cdp-endpoint=http://localhost:9222', '--verbose']);
      expect(result).toBe('http://localhost:9222');
    });

    it('should handle HTTPS URLs', () => {
      const result = parseCdpEndpoint(['--cdp-endpoint=https://remote:9222']);
      expect(result).toBe('https://remote:9222');
    });
  });

  describe('checkCdpEndpointHealth', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    it('should return healthy when endpoint responds OK', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ Browser: 'Chrome/120.0' }),
      }));

      const result = await checkCdpEndpointHealth('http://localhost:9222');
      expect(result.healthy).toBe(true);
      expect(result.endpoint).toBe('http://localhost:9222');
      expect(result.error).toBeUndefined();
    });

    it('should return unhealthy when endpoint returns non-OK status', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: () => Promise.resolve({}),
      }));

      const result = await checkCdpEndpointHealth('http://localhost:9222');
      expect(result.healthy).toBe(false);
      expect(result.error).toContain('503');
      expect(result.suggestion).toBeTruthy();
    });

    it('should return unhealthy on connection refused', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
        new Error('connect ECONNREFUSED 127.0.0.1:9222')
      ));

      const result = await checkCdpEndpointHealth('http://localhost:9222');
      expect(result.healthy).toBe(false);
      expect(result.error).toContain('Connection refused');
      expect(result.suggestion).toContain('remote debugging');
    });

    it('should return unhealthy on DNS failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
        new Error('getaddrinfo ENOTFOUND invalid.host')
      ));

      const result = await checkCdpEndpointHealth('http://invalid.host:9222');
      expect(result.healthy).toBe(false);
      expect(result.error).toContain('DNS');
    });

    // P0 fix (#2243): Use vi.useFakeTimers + signal-aware fetch mock to test the
    // real setTimeout(5000) → AbortController.abort() → AbortError chain.
    // Previously, a global beforeEach mock made setTimeout synchronous, bypassing
    // the abort mechanism entirely — the test only passed because the mock reject
    // value happened to match, not because the timeout logic was verified.
    it('should return unhealthy on timeout', async () => {
      vi.useFakeTimers();

      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((_url: string, options?: RequestInit) => {
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          });
        }),
      );

      try {
        const resultPromise = checkCdpEndpointHealth('http://localhost:9222');
        // Advance past the 5s timeout threshold to trigger controller.abort()
        await vi.advanceTimersByTimeAsync(5100);
        const result = await resultPromise;

        expect(result.healthy).toBe(false);
        expect(result.error).toContain('timeout');
      } finally {
        vi.useRealTimers();
      }
    });

    it('should return unhealthy on generic error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
        new Error('Something unexpected happened')
      ));

      const result = await checkCdpEndpointHealth('http://localhost:9222');
      expect(result.healthy).toBe(false);
      expect(result.error).toContain('Something unexpected happened');
    });

    it('should strip trailing slash from endpoint URL', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ Browser: 'Chrome' }),
      }));

      await checkCdpEndpointHealth('http://localhost:9222/');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://localhost:9222/json/version',
        expect.objectContaining({ method: 'GET' })
      );
    });
  });

  describe('formatCdpHealthError', () => {
    it('should include error title', () => {
      const result: CdpHealthCheckResult = {
        healthy: false,
        error: 'Connection refused',
        endpoint: 'http://localhost:9222',
      };
      const formatted = formatCdpHealthError(result);
      expect(formatted).toContain('CDP Endpoint Unavailable');
    });

    it('should include error message', () => {
      const result: CdpHealthCheckResult = {
        healthy: false,
        error: 'Test error',
        endpoint: 'http://localhost:9222',
      };
      const formatted = formatCdpHealthError(result);
      expect(formatted).toContain('Test error');
    });

    it('should include endpoint URL', () => {
      const result: CdpHealthCheckResult = {
        healthy: false,
        error: 'Error',
        endpoint: 'http://localhost:9222',
      };
      const formatted = formatCdpHealthError(result);
      expect(formatted).toContain('http://localhost:9222');
    });

    it('should include suggestion when provided', () => {
      const result: CdpHealthCheckResult = {
        healthy: false,
        error: 'Error',
        endpoint: 'http://localhost:9222',
        suggestion: 'Start Chrome with --remote-debugging-port=9222',
      };
      const formatted = formatCdpHealthError(result);
      expect(formatted).toContain('Start Chrome');
    });

    it('should handle multi-line suggestions', () => {
      const result: CdpHealthCheckResult = {
        healthy: false,
        error: 'Error',
        endpoint: 'http://localhost:9222',
        suggestion: 'Line 1\nLine 2\nLine 3',
      };
      const formatted = formatCdpHealthError(result);
      expect(formatted).toContain('  Line 1');
      expect(formatted).toContain('  Line 2');
      expect(formatted).toContain('  Line 3');
    });

    it('should handle unknown endpoint', () => {
      const result: CdpHealthCheckResult = {
        healthy: false,
        error: 'Error',
      };
      const formatted = formatCdpHealthError(result);
      expect(formatted).toContain('unknown');
    });
  });
});
