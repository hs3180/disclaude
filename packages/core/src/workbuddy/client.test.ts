/**
 * Unit tests for WorkBuddyClient
 * @see Issue #3442
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkBuddyClient } from './client.js';
import type { A2ACommand } from './types.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('WorkBuddyClient', () => {
  let client: WorkBuddyClient;

  beforeEach(() => {
    client = new WorkBuddyClient({
      endpoint: 'http://localhost:8080',
      authToken: 'test-token',
      timeoutMs: 5000,
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('sendCommand', () => {
    const sampleCommand: A2ACommand = {
      id: 'cmd-test-1',
      type: 'execute',
      payload: 'echo hello',
      projectKey: 'test-project',
      createdAt: '2026-05-14T00:00:00Z',
    };

    it('should send command and return response on success', async () => {
      const mockResponse = {
        commandId: 'cmd-test-1',
        success: true,
        payload: 'hello',
        completedAt: '2026-05-14T00:00:01Z',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await client.sendCommand(sampleCommand);

      expect(result).toEqual(mockResponse);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/command',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'Authorization': 'Bearer test-token',
          }),
        }),
      );
    });

    it('should throw error when WorkBuddy returns non-200 status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      await expect(client.sendCommand(sampleCommand)).rejects.toThrow(
        'WorkBuddy returned HTTP 500',
      );
    });

    it('should throw error when fetch fails (network error)', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(client.sendCommand(sampleCommand)).rejects.toThrow(
        'WorkBuddy command failed: Connection refused',
      );
    });

    it('should work without auth token', async () => {
      const noAuthClient = new WorkBuddyClient({
        endpoint: 'http://localhost:8080',
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          commandId: 'cmd-test-1',
          success: true,
          completedAt: '2026-05-14T00:00:01Z',
        }),
      });

      await noAuthClient.sendCommand(sampleCommand);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.not.objectContaining({
            Authorization: expect.anything(),
          }),
        }),
      );
    });

    it('should strip trailing slash from endpoint', async () => {
      const clientWithSlash = new WorkBuddyClient({
        endpoint: 'http://localhost:8080/',
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          commandId: 'cmd-test-1',
          success: true,
          completedAt: '2026-05-14T00:00:01Z',
        }),
      });

      await clientWithSlash.sendCommand(sampleCommand);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/command',
        expect.any(Object),
      );
    });
  });

  describe('checkHealth', () => {
    it('should return health status on success', async () => {
      const mockHealth = {
        projectKey: 'test-project',
        status: 'online',
        lastCheckedAt: '2026-05-14T00:00:00Z',
        uptimeSeconds: 3600,
        version: '1.0.0',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockHealth),
      });

      const result = await client.checkHealth('test-project');

      expect(result).toEqual(mockHealth);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/health?projectKey=test-project',
        expect.objectContaining({
          method: 'GET',
        }),
      );
    });

    it('should return error status on non-200 response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
      });

      const result = await client.checkHealth('test-project');

      expect(result.status).toBe('error');
      expect(result.projectKey).toBe('test-project');
    });

    it('should return offline status on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await client.checkHealth('test-project');

      expect(result.status).toBe('offline');
      expect(result.projectKey).toBe('test-project');
    });
  });
});
