/**
 * Tests for CDP (Chrome DevTools Protocol) endpoint health check utility.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseCdpEndpoint, checkCdpEndpointHealth, formatCdpHealthError } from './cdp-health-check.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('CDP Health Check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('parseCdpEndpoint', () => {
    it('should parse --cdp-endpoint=<url> format', () => {
      const args = ['--cdp-endpoint=http://localhost:9222'];
      expect(parseCdpEndpoint(args)).toBe('http://localhost:9222');
    });

    it('should parse --cdp-endpoint <url> format', () => {
      const args = ['--cdp-endpoint', 'http://localhost:9222'];
      expect(parseCdpEndpoint(args)).toBe('http://localhost:9222');
    });

    it('should return undefined if no CDP endpoint found', () => {
      const args = ['--other-arg', 'value'];
      expect(parseCdpEndpoint(args)).toBeUndefined();
    });

    it('should return undefined for empty args', () => {
      expect(parseCdpEndpoint([])).toBeUndefined();
      expect(parseCdpEndpoint(undefined as unknown as string[])).toBeUndefined();
    });

    it('should handle various endpoint formats', () => {
      expect(parseCdpEndpoint(['--cdp-endpoint=http://192.168.1.1:9222'])).toBe('http://192.168.1.1:9222');
      expect(parseCdpEndpoint(['--cdp-endpoint', 'http://127.0.0.1:9223'])).toBe('http://127.0.0.1:9223');
    });
  });

  describe('checkCdpEndpointHealth', () => {
    it('should return healthy when endpoint responds with OK', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ Browser: 'Chrome/120.0.0' }),
      });

      const result = await checkCdpEndpointHealth('http://localhost:9222');

      expect(result.healthy).toBe(true);
      expect(result.endpoint).toBe('http://localhost:9222');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:9222/json/version',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should return unhealthy when endpoint returns non-OK status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const result = await checkCdpEndpointHealth('http://localhost:9222');

      expect(result.healthy).toBe(false);
      expect(result.error).toContain('404');
      expect(result.suggestion).toBeDefined();
    });

    it('should return unhealthy with suggestion on connection refused', async () => {
      const error = new Error('ECONNREFUSED');
      error.name = 'Error';
      mockFetch.mockRejectedValueOnce(error);

      const result = await checkCdpEndpointHealth('http://localhost:9222');

      expect(result.healthy).toBe(false);
      expect(result.error).toContain('Connection refused');
      expect(result.suggestion).toContain('remote-debugging-port');
    });

    it('should return unhealthy on timeout', async () => {
      mockFetch.mockImplementationOnce(() => {
        return new Promise((_, reject) => {
          const error = new Error('Aborted');
          error.name = 'AbortError';
          setTimeout(() => reject(error), 100);
        });
      });

      const resultPromise = checkCdpEndpointHealth('http://localhost:9222');

      // Advance timers to trigger timeout
      await vi.advanceTimersByTimeAsync(5000);

      const result = await resultPromise;

      expect(result.healthy).toBe(false);
      expect(result.error).toContain('timeout');
    });

    it('should handle endpoints with trailing slash', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ Browser: 'Chrome/120.0.0' }),
      });

      const result = await checkCdpEndpointHealth('http://localhost:9222/');

      expect(result.healthy).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:9222/json/version',
        expect.objectContaining({ method: 'GET' })
      );
    });
  });

  describe('formatCdpHealthError', () => {
    it('should format error with all fields', () => {
      const result = {
        healthy: false,
        error: 'Connection refused',
        suggestion: 'Start Chrome with --remote-debugging-port=9222',
        endpoint: 'http://localhost:9222',
      };

      const formatted = formatCdpHealthError(result);

      expect(formatted).toContain('Playwright MCP: CDP Endpoint Unavailable');
      expect(formatted).toContain('Connection refused');
      expect(formatted).toContain('http://localhost:9222');
      expect(formatted).toContain('Start Chrome');
    });

    it('should handle missing suggestion', () => {
      const result = {
        healthy: false,
        error: 'Unknown error',
        endpoint: 'http://localhost:9222',
      };

      const formatted = formatCdpHealthError(result);

      expect(formatted).toContain('Unknown error');
      expect(formatted).toContain('http://localhost:9222');
    });
  });
});
