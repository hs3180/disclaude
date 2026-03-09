/**
 * Tests for Device Code Flow implementation (RFC 8628).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  initiateDeviceCode,
  pollForToken,
  DeviceCodeFlowManager,
  getDeviceCodeFlowManager,
} from './device-code-flow.js';
import type { DeviceCodeProviderConfig, DeviceCodeResponse } from './types.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock token store
vi.mock('./token-store.js', () => ({
  getTokenStore: vi.fn(() => ({
    setToken: vi.fn().mockResolvedValue(undefined),
    getToken: vi.fn().mockResolvedValue(null),
    getAccessToken: vi.fn().mockResolvedValue(null),
    deleteToken: vi.fn().mockResolvedValue(true),
    listProviders: vi.fn().mockResolvedValue([]),
  })),
}));

describe('Device Code Flow', () => {
  const mockProviderConfig: DeviceCodeProviderConfig = {
    name: 'github',
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    deviceCodeUrl: 'https://github.com/login/device/code',
    deviceTokenUrl: 'https://github.com/login/oauth/access_token',
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    scopes: ['repo', 'user'],
    callbackUrl: 'http://localhost:3000/auth/callback',
    supportsDeviceCode: true,
  };

  const mockDeviceCodeResponse: DeviceCodeResponse = {
    device_code: 'test-device-code-12345',
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    expires_in: 900,
    interval: 5,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initiateDeviceCode', () => {
    it('should request device code from provider', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDeviceCodeResponse,
      });

      const result = await initiateDeviceCode(mockProviderConfig);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://github.com/login/device/code',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/x-www-form-urlencoded',
          }),
        })
      );

      expect(result).toEqual(mockDeviceCodeResponse);
    });

    it('should throw error when device code URL is not configured', async () => {
      const configWithoutDeviceUrl: DeviceCodeProviderConfig = {
        ...mockProviderConfig,
        deviceCodeUrl: undefined,
      };

      await expect(initiateDeviceCode(configWithoutDeviceUrl)).rejects.toThrow(
        'does not have a device code URL configured'
      );
    });

    it('should throw error on failed request', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Bad Request',
      });

      await expect(initiateDeviceCode(mockProviderConfig)).rejects.toThrow(
        'Failed to request device code: 400'
      );
    });
  });

  describe('pollForToken', () => {
    it('should poll until authorization is complete', async () => {
      // First poll: pending
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ error: 'authorization_pending' }),
      });

      // Second poll: success
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'test-access-token',
          token_type: 'Bearer',
          scope: 'repo user',
          expires_in: 3600,
        }),
      });

      const result = await pollForToken(
        mockProviderConfig,
        'test-device-code',
        0 // No delay for testing
      );

      expect(result.accessToken).toBe('test-access-token');
      expect(result.tokenType).toBe('Bearer');
      expect(result.scope).toBe('repo user');
    });

    it('should handle slow_down error by increasing interval', async () => {
      const statusUpdates: string[] = [];

      // First poll: slow_down
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ error: 'slow_down' }),
      });

      // Second poll: success
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'test-access-token',
          token_type: 'Bearer',
        }),
      });

      const result = await pollForToken(
        mockProviderConfig,
        'test-device-code',
        0,
        (status) => statusUpdates.push(status)
      );

      expect(result.accessToken).toBe('test-access-token');
      expect(statusUpdates).toContainEqual(expect.stringContaining('slow_down'));
    });

    it('should throw error on expired token', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ error: 'expired_token' }),
      });

      await expect(
        pollForToken(mockProviderConfig, 'test-device-code', 0)
      ).rejects.toThrow('Device code has expired');
    });

    it('should throw error on access denied', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ error: 'access_denied' }),
      });

      await expect(
        pollForToken(mockProviderConfig, 'test-device-code', 0)
      ).rejects.toThrow('Authorization was denied');
    });
  });

  describe('DeviceCodeFlowManager', () => {
    it('should start a device code flow', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDeviceCodeResponse,
      });

      const manager = new DeviceCodeFlowManager();
      const state = await manager.startFlow(mockProviderConfig, 'test-chat-id');

      expect(state.chatId).toBe('test-chat-id');
      expect(state.provider).toBe('github');
      expect(state.userCode).toBe('ABCD-1234');
      expect(state.deviceCode).toBe('test-device-code-12345');
      expect(state.verificationUri).toBe('https://github.com/login/device');
    });

    it('should complete a device code flow', async () => {
      // Start flow
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDeviceCodeResponse,
      });

      const manager = new DeviceCodeFlowManager();
      const state = await manager.startFlow(mockProviderConfig, 'test-chat-id');

      // Complete flow with success
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'test-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      });

      const result = await manager.completeFlow(state.id);

      expect(result.chatId).toBe('test-chat-id');
      expect(result.provider).toBe('github');
    });

    it('should cancel a pending flow', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDeviceCodeResponse,
      });

      const manager = new DeviceCodeFlowManager();
      const state = await manager.startFlow(mockProviderConfig, 'test-chat-id');

      manager.cancelFlow(state.id);

      const retrievedState = manager.getFlowState(state.id);
      expect(retrievedState).toBeUndefined();
    });

    it('should throw error for invalid flow ID', async () => {
      const manager = new DeviceCodeFlowManager();

      await expect(manager.completeFlow('invalid-id')).rejects.toThrow(
        'Invalid or expired device code flow'
      );
    });
  });

  describe('getDeviceCodeFlowManager', () => {
    it('should return singleton instance', () => {
      const instance1 = getDeviceCodeFlowManager();
      const instance2 = getDeviceCodeFlowManager();

      expect(instance1).toBe(instance2);
    });
  });
});
