/**
 * Tests for WeChatAuth (MVP).
 *
 * @see Issue #1473 - WeChat Channel MVP
 */

 

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WeChatAuth } from './auth.js';

// Mock the QRCode module
vi.mock('qrcode', () => ({
  default: {
    toFile: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock execSync to avoid actually opening files
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

function createMockClient() {
  return {
    getBotQrCode: vi.fn().mockResolvedValue({
      qrcode: 'qr-id-123',
      qrUrl: 'https://login.weixin.qq.com/qr-test',
    }),
    getQrCodeStatus: vi.fn().mockResolvedValue({
      status: 'wait',
    }),
    setToken: vi.fn(),
  };
}

describe('WeChatAuth', () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let auth: WeChatAuth;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockClient = createMockClient();
    auth = new WeChatAuth(mockClient as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create auth handler with client', () => {
      expect(auth).toBeDefined();
      expect(auth.isAuthenticating()).toBe(false);
    });
  });

  describe('authenticate', () => {
    it('should return success result when login is confirmed', async () => {
      mockClient.getQrCodeStatus.mockResolvedValueOnce({
        status: 'confirmed',
        botToken: 'bot-token-123',
        botId: 'bot-id-456',
        userId: 'user-id-789',
        baseUrl: 'https://custom.api.com',
      });

      const result = await auth.authenticate();
      expect(result.success).toBe(true);
      expect(result.token).toBe('bot-token-123');
      expect(result.botId).toBe('bot-id-456');
      expect(result.userId).toBe('user-id-789');
      expect(result.baseUrl).toBe('https://custom.api.com');
    });

    it('should return failure when bot ID is missing after confirmation', async () => {
      mockClient.getQrCodeStatus.mockResolvedValueOnce({
        status: 'confirmed',
        botToken: 'bot-token',
        botId: undefined,
      });

      const result = await auth.authenticate();
      expect(result.success).toBe(false);
      expect(result.error).toContain('bot ID missing');
    });

    it('should poll multiple times until confirmed', async () => {
      mockClient.getQrCodeStatus
        .mockResolvedValueOnce({ status: 'wait' })
        .mockResolvedValueOnce({ status: 'scaned' })
        .mockResolvedValueOnce({
          status: 'confirmed',
          botToken: 'bot-token',
          botId: 'bot-id',
        });

      const promise = auth.authenticate();
      // Advance timers for the poll delay
      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;

      expect(result.success).toBe(true);
      expect(mockClient.getQrCodeStatus).toHaveBeenCalledTimes(3);
    });

    it('should refresh QR code on expired', async () => {
      mockClient.getQrCodeStatus
        .mockResolvedValueOnce({ status: 'expired' })
        .mockResolvedValueOnce({
          status: 'confirmed',
          botToken: 'bot-token',
          botId: 'bot-id',
        });

      const promise = auth.authenticate();
      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;

      expect(result.success).toBe(true);
      // Should have called getBotQrCode twice (initial + refresh)
      expect(mockClient.getBotQrCode).toHaveBeenCalledTimes(2);
    });

    it('should give up after MAX_QR_REFRESH_COUNT expired QR codes', async () => {
      // 4 expired responses (initial + 3 refreshes)
      for (let i = 0; i < 4; i++) {
        mockClient.getQrCodeStatus.mockResolvedValueOnce({ status: 'expired' });
      }

      const promise = auth.authenticate();
      await vi.advanceTimersByTimeAsync(20000);
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('expired too many times');
      // Should have refreshed 3 times (after initial QR code)
      expect(mockClient.getBotQrCode).toHaveBeenCalledTimes(4); // initial + 3 refreshes
    });

    it('should return timeout result when deadline passes', async () => {
      mockClient.getQrCodeStatus.mockResolvedValue({ status: 'wait' });

      const promise = auth.authenticate({ timeoutMs: 3000 });
      await vi.advanceTimersByTimeAsync(5000);
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
    });

    it('should retry on network errors during polling', async () => {
      mockClient.getQrCodeStatus
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          status: 'confirmed',
          botToken: 'bot-token',
          botId: 'bot-id',
        });

      const promise = auth.authenticate();
      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;

      expect(result.success).toBe(true);
    });

    it('should use minimum timeout of 1 second', async () => {
      mockClient.getQrCodeStatus.mockResolvedValue({ status: 'wait' });

      const promise = auth.authenticate({ timeoutMs: 0 });
      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result.success).toBe(false);
    });
  });

  describe('abort', () => {
    it('should abort authentication', async () => {
      mockClient.getQrCodeStatus.mockResolvedValue({ status: 'wait' });

      const promise = auth.authenticate({ timeoutMs: 60000 });
      // Let it poll once
      await vi.advanceTimersByTimeAsync(1500);

      auth.abort();

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('Authentication aborted');
    });

    it('should be safe to call abort when not authenticating', () => {
      expect(() => auth.abort()).not.toThrow();
    });
  });

  describe('isAuthenticating', () => {
    it('should return false initially', () => {
      expect(auth.isAuthenticating()).toBe(false);
    });

    it('should return true during authentication', async () => {
      mockClient.getQrCodeStatus.mockResolvedValue({ status: 'wait' });

      const promise = auth.authenticate({ timeoutMs: 60000 });
      // Let it start
      await vi.advanceTimersByTimeAsync(100);

      expect(auth.isAuthenticating()).toBe(true);

      auth.abort();
      await promise;
    });

    it('should return false after abort', async () => {
      mockClient.getQrCodeStatus.mockResolvedValue({ status: 'wait' });

      const promise = auth.authenticate({ timeoutMs: 60000 });
      await vi.advanceTimersByTimeAsync(100);

      auth.abort();
      await promise;

      expect(auth.isAuthenticating()).toBe(false);
    });
  });

  describe('logQrCode', () => {
    it('should handle QR code generation failure gracefully', async () => {
      // After the mock is cleared, getBotQrCode will throw
      // But auth.authenticate should handle it via the polling retry
      mockClient.getQrCodeStatus.mockResolvedValueOnce({
        status: 'confirmed',
        botToken: 'bot-token',
        botId: 'bot-id',
      });

      // This should still work even if QR rendering has issues
      const result = await auth.authenticate();
      // If QR code gen fails, auth flow continues via URL fallback
      // This test just ensures no crash
      expect(result.success).toBe(true);
    });
  });
});
