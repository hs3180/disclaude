/**
 * Tests for auth/device-code-flow.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DeviceCodeFlow } from './device-code-flow.js';
import { TokenStore } from './token-store.js';
import type { DeviceCodeProviderConfig } from './types.js';

// Mock fetch for device code requests
const originalFetch = global.fetch;

describe('DeviceCodeFlow', () => {
  let tempDir: string;
  let tokenStore: TokenStore;
  let deviceCodeFlow: DeviceCodeFlow;

  const mockProvider: DeviceCodeProviderConfig = {
    name: 'test-provider',
    authUrl: 'https://example.com/oauth/authorize',
    tokenUrl: 'https://example.com/oauth/token',
    deviceCodeUrl: 'https://example.com/oauth/device/code',
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    scopes: ['read', 'write'],
    callbackUrl: '', // Not needed for device code flow
    supportsDeviceCode: true,
  };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'device-code-flow-test-'));
    const storagePath = path.join(tempDir, 'tokens.json');
    tokenStore = new TokenStore(storagePath);
    deviceCodeFlow = new DeviceCodeFlow(tokenStore);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    global.fetch = originalFetch;
    // Clean up any pending intervals
    vi.clearAllTimers();
  });

  describe('initiateDeviceCode', () => {
    it('should return error when provider does not support device code', async () => {
      const unsupportedProvider: DeviceCodeProviderConfig = {
        ...mockProvider,
        supportsDeviceCode: false,
        deviceCodeUrl: '',
      };

      const result = await deviceCodeFlow.initiateDeviceCode(unsupportedProvider, 'chat-1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not support Device Code Flow');
    });

    it('should initiate device code flow and return user code', async () => {
      // Mock fetch for device code request
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => ({
          device_code: 'test-device-code',
          user_code: 'ABCD-1234',
          verification_uri: 'https://example.com/device',
          expires_in: 900,
          interval: 5,
        }),
      });

      const result = await deviceCodeFlow.initiateDeviceCode(mockProvider, 'chat-1');

      expect(result.success).toBe(true);
      expect(result.userCode).toBe('ABCD-1234');
      expect(result.verificationUri).toBe('https://example.com/device');
      expect(result.stateId).toBeDefined();

      // Verify fetch was called with correct params
      expect(global.fetch).toHaveBeenCalledWith(
        mockProvider.deviceCodeUrl,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/x-www-form-urlencoded',
          }),
        })
      );
    });

    it('should handle device code request failure', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => 'Invalid client',
      });

      const result = await deviceCodeFlow.initiateDeviceCode(mockProvider, 'chat-1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to request device code');
    });

    it('should handle invalid response missing required fields', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => ({
          // Missing device_code, user_code, verification_uri
          expires_in: 900,
        }),
      });

      const result = await deviceCodeFlow.initiateDeviceCode(mockProvider, 'chat-1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('missing required fields');
    });
  });

  describe('pollForToken', () => {
    it('should return error for invalid state', async () => {
      const result = await deviceCodeFlow.pollForToken('invalid-state-id');

      expect(result.complete).toBe(true);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid or expired');
    });

    it('should return pending when authorization is pending', async () => {
      // First initiate a device code
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => ({
          device_code: 'test-device-code',
          user_code: 'ABCD-1234',
          verification_uri: 'https://example.com/device',
          expires_in: 900,
          interval: 5,
        }),
      });

      const initResult = await deviceCodeFlow.initiateDeviceCode(mockProvider, 'chat-1');
      expect(initResult.success).toBe(true);

      // Mock polling response - authorization pending
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => ({
          error: 'authorization_pending',
        }),
      });

      const pollResult = await deviceCodeFlow.pollForToken(initResult.stateId!);

      expect(pollResult.complete).toBe(false);
      expect(pollResult.errorType).toBe('authorization_pending');
    });

    it('should complete successfully when authorized', async () => {
      // First initiate a device code
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => ({
          device_code: 'test-device-code',
          user_code: 'ABCD-1234',
          verification_uri: 'https://example.com/device',
          expires_in: 900,
          interval: 5,
        }),
      });

      const initResult = await deviceCodeFlow.initiateDeviceCode(mockProvider, 'chat-1');
      expect(initResult.success).toBe(true);

      // Mock polling response - success
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => ({
          access_token: 'test-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'read write',
        }),
      });

      const pollResult = await deviceCodeFlow.pollForToken(initResult.stateId!);

      expect(pollResult.complete).toBe(true);
      expect(pollResult.success).toBe(true);

      // Verify token was stored
      const storedToken = await tokenStore.getToken('chat-1', 'test-provider');
      expect(storedToken).not.toBeNull();
      expect(storedToken!.accessToken).toBe('test-access-token');
    });

    it('should handle expired token error', async () => {
      // First initiate a device code
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => ({
          device_code: 'test-device-code',
          user_code: 'ABCD-1234',
          verification_uri: 'https://example.com/device',
          expires_in: 900,
          interval: 5,
        }),
      });

      const initResult = await deviceCodeFlow.initiateDeviceCode(mockProvider, 'chat-1');
      expect(initResult.success).toBe(true);

      // Mock polling response - expired
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => ({
          error: 'expired_token',
        }),
      });

      const pollResult = await deviceCodeFlow.pollForToken(initResult.stateId!);

      expect(pollResult.complete).toBe(true);
      expect(pollResult.success).toBe(false);
      expect(pollResult.errorType).toBe('expired_token');
    });

    it('should handle access denied error', async () => {
      // First initiate a device code
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => ({
          device_code: 'test-device-code',
          user_code: 'ABCD-1234',
          verification_uri: 'https://example.com/device',
          expires_in: 900,
          interval: 5,
        }),
      });

      const initResult = await deviceCodeFlow.initiateDeviceCode(mockProvider, 'chat-1');
      expect(initResult.success).toBe(true);

      // Mock polling response - access denied
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => ({
          error: 'access_denied',
        }),
      });

      const pollResult = await deviceCodeFlow.pollForToken(initResult.stateId!);

      expect(pollResult.complete).toBe(true);
      expect(pollResult.success).toBe(false);
      expect(pollResult.errorType).toBe('access_denied');
    });

    it('should increase interval on slow_down error', async () => {
      // First initiate a device code
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => ({
          device_code: 'test-device-code',
          user_code: 'ABCD-1234',
          verification_uri: 'https://example.com/device',
          expires_in: 900,
          interval: 5,
        }),
      });

      const initResult = await deviceCodeFlow.initiateDeviceCode(mockProvider, 'chat-1');
      expect(initResult.success).toBe(true);

      // Mock polling response - slow down
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => ({
          error: 'slow_down',
        }),
      });

      const pollResult = await deviceCodeFlow.pollForToken(initResult.stateId!);

      expect(pollResult.complete).toBe(false);
      expect(pollResult.errorType).toBe('slow_down');

      // Verify interval was increased
      const state = deviceCodeFlow.getState(initResult.stateId!);
      expect(state?.interval).toBe(10); // 5 * 2
    });
  });

  describe('cancelDeviceCode', () => {
    it('should cancel a pending device code flow', async () => {
      // First initiate a device code
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => ({
          device_code: 'test-device-code',
          user_code: 'ABCD-1234',
          verification_uri: 'https://example.com/device',
          expires_in: 900,
          interval: 5,
        }),
      });

      const initResult = await deviceCodeFlow.initiateDeviceCode(mockProvider, 'chat-1');
      expect(initResult.success).toBe(true);

      // Verify state exists
      let state = deviceCodeFlow.getState(initResult.stateId!);
      expect(state).toBeDefined();

      // Cancel
      deviceCodeFlow.cancelDeviceCode(initResult.stateId!);

      // Verify state is removed
      state = deviceCodeFlow.getState(initResult.stateId!);
      expect(state).toBeUndefined();
    });
  });

  describe('getState', () => {
    it('should return undefined for non-existent state', () => {
      const state = deviceCodeFlow.getState('non-existent-id');
      expect(state).toBeUndefined();
    });

    it('should return state for valid state ID', async () => {
      // First initiate a device code
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => ({
          device_code: 'test-device-code',
          user_code: 'ABCD-1234',
          verification_uri: 'https://example.com/device',
          expires_in: 900,
          interval: 5,
        }),
      });

      const initResult = await deviceCodeFlow.initiateDeviceCode(mockProvider, 'chat-1');
      expect(initResult.success).toBe(true);

      const state = deviceCodeFlow.getState(initResult.stateId!);
      expect(state).toBeDefined();
      expect(state?.userCode).toBe('ABCD-1234');
      expect(state?.provider).toBe('test-provider');
      expect(state?.chatId).toBe('chat-1');
    });
  });
});

describe('createDeviceCodeCard', () => {
  it('should create a valid Feishu card', async () => {
    const { createDeviceCodeCard } = await import('./device-code-flow.js');

    const card = createDeviceCodeCard('ABCD-1234', 'https://example.com/device', 'TestProvider');

    expect(card.config.wide_screen_mode).toBe(true);
    expect(card.header.title.content).toContain('TestProvider');
    expect(card.elements).toBeDefined();
    expect(card.elements.length).toBeGreaterThan(0);
  });
});
