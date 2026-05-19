/**
 * Unit tests for WorkBuddyClient.
 *
 * Uses vi.fn() to mock global fetch since nock doesn't intercept
 * Node.js native fetch (undici-based).
 *
 * @module tests/unit/workbuddy/workbuddy-client
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkBuddyClient } from '@disclaude/core';
import type { WorkBuddyProjectConfig } from '@disclaude/core';

describe('WorkBuddyClient', () => {
  const baseUrl = 'http://workbuddy.local';
  const config: WorkBuddyProjectConfig = {
    url: baseUrl,
    apiKey: 'test-key',
    cwd: '/project',
  };

  let client: WorkBuddyClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    client = new WorkBuddyClient(config);
  });

  function mockResponse(data: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(typeof data === 'string' ? data : JSON.stringify(data)),
    } as Response;
  }

  describe('execute', () => {
    it('should send a command and return the response', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        success: true,
        stdout: 'Preview QR code generated',
        exitCode: 0,
      }));

      const result = await client.execute({ command: 'preview' });

      expect(result.success).toBe(true);
      expect(result.stdout).toBe('Preview QR code generated');
      expect(result.exitCode).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      // Verify request details
      expect(mockFetch).toHaveBeenCalledWith(
        'http://workbuddy.local/api/command',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-key',
            'Content-Type': 'application/json',
          }),
        })
      );
    });

    it('should return error response on command failure', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        success: false,
        stderr: 'Build failed: syntax error',
        exitCode: 1,
      }));

      const result = await client.execute({ command: 'build-npm' });

      expect(result.success).toBe(false);
      expect(result.stderr).toBe('Build failed: syntax error');
      expect(result.exitCode).toBe(1);
    });

    it('should return error on HTTP failure', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('Internal Server Error', 500));

      const result = await client.execute({ command: 'preview' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP 500');
    });

    it('should return error on network failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await client.execute({ command: 'preview' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('ECONNREFUSED');
    });

    it('should send command with args, cwd, and env', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ success: true, exitCode: 0 }));

      const result = await client.execute({
        command: 'upload',
        args: ['--version', '1.0.0'],
        cwd: '/custom/dir',
        env: { NODE_ENV: 'production' },
      });

      expect(result.success).toBe(true);

      // Verify the body sent
      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body as string);
      expect(body).toEqual({
        command: 'upload',
        args: ['--version', '1.0.0'],
        cwd: '/custom/dir',
        env: { NODE_ENV: 'production' },
      });
    });
  });

  describe('healthCheck', () => {
    it('should return healthy response on success', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        version: '1.0.0',
        cwd: '/project',
        tools: ['wechat-devtools'],
        uptime: 3600,
      }));

      const health = await client.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.version).toBe('1.0.0');
      expect(health.cwd).toBe('/project');
      expect(health.tools).toEqual(['wechat-devtools']);
      expect(health.uptime).toBe(3600);

      // Verify GET request to /api/health
      expect(mockFetch).toHaveBeenCalledWith(
        'http://workbuddy.local/api/health',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should return unhealthy on connection failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const health = await client.healthCheck();

      expect(health.healthy).toBe(false);
    });
  });

  describe('URL handling', () => {
    it('should strip trailing slash from URL', async () => {
      const clientWithSlash = new WorkBuddyClient({
        url: 'http://workbuddy.local/',
        apiKey: 'key',
      });

      mockFetch.mockResolvedValueOnce(mockResponse({ version: '1.0.0' }));

      await clientWithSlash.healthCheck();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://workbuddy.local/api/health',
        expect.anything()
      );
    });
  });

  describe('authentication', () => {
    it('should not send Authorization header when no apiKey', async () => {
      const noKeyClient = new WorkBuddyClient({ url: baseUrl });

      mockFetch.mockResolvedValueOnce(mockResponse({ version: '1.0.0' }));

      await noKeyClient.healthCheck();

      const call = mockFetch.mock.calls[0];
      const headers = call[1].headers as Record<string, string>;
      expect(headers['Authorization']).toBeUndefined();
    });
  });

  describe('timeout', () => {
    it('should use an AbortSignal for request cancellation', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ success: true }));

      await client.execute({ command: 'test' });

      const call = mockFetch.mock.calls[0];
      expect(call[1].signal).toBeDefined();
      expect(call[1].signal).toBeInstanceOf(AbortSignal);
    });

    it('should accept custom timeout', async () => {
      const fastClient = new WorkBuddyClient({ url: baseUrl }, 1000);

      mockFetch.mockResolvedValueOnce(mockResponse({ success: true }));

      await fastClient.execute({ command: 'test' });

      expect(mockFetch).toHaveBeenCalled();
    });
  });
});
