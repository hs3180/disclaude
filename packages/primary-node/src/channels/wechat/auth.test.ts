/**
 * Tests for WeChat Auth Handler.
 *
 * Tests the QR code login flow.
 * Uses mocked API client to avoid real network dependency.
 *
 * @see Issue #1023 - Unit tests should not depend on external environment
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WeChatAuthHandler } from './auth.js';
import type { WeChatApiClient } from './api-client.js';

// Create mock logger
const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
}));

vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@disclaude/core')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

// Create mock API client
const mockApiClient = vi.hoisted(() => ({
  isAuthenticated: vi.fn(() => false),
  getToken: vi.fn(() => undefined),
  setToken: vi.fn(),
  getQRCode: vi.fn(),
  getQRCodeStatus: vi.fn(),
  sendMessage: vi.fn(),
}));

describe('WeChatAuthHandler', () => {
  let authHandler: WeChatAuthHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockApiClient.isAuthenticated.mockReturnValue(false);
    mockApiClient.getToken.mockReturnValue(undefined);
    authHandler = new WeChatAuthHandler(mockApiClient as unknown as WeChatApiClient, {
      timeout: 60000,
      pollInterval: 1000,
    });
  });

  afterEach(() => {
    authHandler.cancelLogin();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create instance with default config', () => {
      expect(authHandler).toBeDefined();
      expect(authHandler.getState()).toBe('unauthenticated');
    });

    it('should create instance with custom config', () => {
      authHandler = new WeChatAuthHandler(mockApiClient as unknown as WeChatApiClient, {
        timeout: 120000,
        pollInterval: 5000,
      });
      expect(authHandler).toBeDefined();
    });
  });

  describe('state management', () => {
    it('should return unauthenticated initially', () => {
      expect(authHandler.getState()).toBe('unauthenticated');
    });

    it('should return undefined credentials initially', () => {
      expect(authHandler.getCredentials()).toBeUndefined();
    });

    it('should return false for isAuthenticated initially', () => {
      expect(authHandler.isAuthenticated()).toBe(false);
    });
  });

  describe('startLogin', () => {
    it('should emit qrcode event on login start', async () => {
      mockApiClient.getQRCode.mockResolvedValueOnce({
        qrid: 'qr-123',
        qrurl: 'https://example.com/qr/qr-123',
        expire: 300,
      });

      // Mock status to return confirmed on first poll
      mockApiClient.getQRCodeStatus.mockResolvedValueOnce({
        status: 'confirmed',
        bot_token: 'test-token',
        ilink_bot_id: 'bot-123',
      });

      const qrcodeHandler = vi.fn();
      const authenticatedHandler = vi.fn();

      authHandler.on('qrcode', qrcodeHandler);
      authHandler.on('authenticated', authenticatedHandler);

      const loginPromise = authHandler.startLogin();

      // Wait for QR code event
      await vi.waitFor(() => {
        expect(qrcodeHandler).toHaveBeenCalled();
      });

      expect(qrcodeHandler).toHaveBeenCalledWith({
        url: 'https://example.com/qr/qr-123',
        id: 'qr-123',
      });

      // Advance timers to trigger polling
      await vi.advanceTimersByTimeAsync(1000);

      await loginPromise;

      expect(authenticatedHandler).toHaveBeenCalledWith({
        token: 'test-token',
        botId: 'bot-123',
      });
    });

    it('should skip login if already authenticated via config', async () => {
      mockApiClient.isAuthenticated.mockReturnValue(true);
      mockApiClient.getToken.mockReturnValue('config-token' as unknown as undefined);

      const authenticatedHandler = vi.fn();
      authHandler.on('authenticated', authenticatedHandler);

      await authHandler.startLogin();

      expect(authHandler.getState()).toBe('authenticated');
      expect(authenticatedHandler).toHaveBeenCalled();
      expect(mockApiClient.getQRCode).not.toHaveBeenCalled();
    });

    it('should not start login if already pending', async () => {
      mockApiClient.getQRCode.mockResolvedValueOnce({
        qrid: 'qr-123',
        qrurl: 'https://example.com/qr/qr-123',
        expire: 300,
      });

      // Start first login (don't await)
      void authHandler.startLogin();

      // Try to start another login immediately
      void authHandler.startLogin();

      // Both should resolve without error, but QR code should only be called once
      await vi.advanceTimersByTimeAsync(100);
      await authHandler.cancelLogin();

      expect(mockApiClient.getQRCode).toHaveBeenCalledTimes(1);
    });

    it('should emit error on QR code fetch failure', async () => {
      mockApiClient.getQRCode.mockRejectedValueOnce(new Error('Network error'));

      const errorHandler = vi.fn();
      authHandler.on('error', errorHandler);

      await expect(authHandler.startLogin()).rejects.toThrow('Network error');

      expect(errorHandler).toHaveBeenCalled();
      expect(authHandler.getState()).toBe('error');
    });
  });

  describe('polling', () => {
    it('should poll status until confirmed', async () => {
      mockApiClient.getQRCode.mockResolvedValueOnce({
        qrid: 'qr-123',
        qrurl: 'https://example.com/qr/qr-123',
        expire: 300,
      });

      // First poll: wait
      mockApiClient.getQRCodeStatus.mockResolvedValueOnce({
        status: 'wait',
      });

      // Second poll: scaned
      mockApiClient.getQRCodeStatus.mockResolvedValueOnce({
        status: 'scaned',
      });

      // Third poll: confirmed
      mockApiClient.getQRCodeStatus.mockResolvedValueOnce({
        status: 'confirmed',
        bot_token: 'test-token',
        ilink_bot_id: 'bot-123',
      });

      const authenticatedHandler = vi.fn();
      authHandler.on('authenticated', authenticatedHandler);

      const loginPromise = authHandler.startLogin();

      // Advance through polls
      await vi.advanceTimersByTimeAsync(1000); // First poll: wait
      await vi.advanceTimersByTimeAsync(1000); // Second poll: scaned
      await vi.advanceTimersByTimeAsync(1000); // Third poll: confirmed

      await loginPromise;

      expect(authenticatedHandler).toHaveBeenCalledWith({
        token: 'test-token',
        botId: 'bot-123',
      });
      expect(authHandler.isAuthenticated()).toBe(true);
      expect(mockApiClient.setToken).toHaveBeenCalledWith('test-token');
    });

    it('should emit error on QR code expired', async () => {
      mockApiClient.getQRCode.mockResolvedValueOnce({
        qrid: 'qr-123',
        qrurl: 'https://example.com/qr/qr-123',
        expire: 300,
      });

      mockApiClient.getQRCodeStatus.mockResolvedValueOnce({
        status: 'expired',
      });

      const errorHandler = vi.fn();
      authHandler.on('error', errorHandler);

      const loginPromise = authHandler.startLogin();

      await vi.advanceTimersByTimeAsync(1000);

      await expect(loginPromise).rejects.toThrow('expired');

      expect(errorHandler).toHaveBeenCalled();
    });

    it('should timeout after configured duration', async () => {
      authHandler = new WeChatAuthHandler(mockApiClient as unknown as WeChatApiClient, {
        timeout: 5000,
        pollInterval: 1000,
      });

      mockApiClient.getQRCode.mockResolvedValueOnce({
        qrid: 'qr-123',
        qrurl: 'https://example.com/qr/qr-123',
        expire: 300,
      });

      // Always return wait status
      mockApiClient.getQRCodeStatus.mockResolvedValue({
        status: 'wait',
      });

      const errorHandler = vi.fn();
      authHandler.on('error', errorHandler);

      const loginPromise = authHandler.startLogin();

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(6000);

      await expect(loginPromise).rejects.toThrow('timeout');

      expect(errorHandler).toHaveBeenCalled();
    });
  });

  describe('cancelLogin', () => {
    it('should cancel ongoing login', async () => {
      mockApiClient.getQRCode.mockResolvedValueOnce({
        qrid: 'qr-123',
        qrurl: 'https://example.com/qr/qr-123',
        expire: 300,
      });

      mockApiClient.getQRCodeStatus.mockResolvedValue({
        status: 'wait',
      });

      authHandler.startLogin();

      // Wait for QR code
      await vi.waitFor(() => {
        expect(authHandler.getState()).toBe('pending');
      });

      // Cancel
      authHandler.cancelLogin();

      expect(authHandler.getState()).toBe('unauthenticated');
    });

    it('should be safe to call when not logging in', () => {
      expect(() => authHandler.cancelLogin()).not.toThrow();
    });
  });
});
