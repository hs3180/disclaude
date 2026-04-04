/**
 * Tests for send_card tool (packages/mcp-server/src/tools/send-card.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  getIpcClient: vi.fn(),
}));

vi.mock('../utils/card-validator.js', () => ({
  isValidFeishuCard: vi.fn(),
  getCardValidationError: vi.fn((_card: unknown) => 'Invalid card structure'),
}));

vi.mock('./credentials.js', () => ({
  getFeishuCredentials: vi.fn(),
}));

vi.mock('./ipc-utils.js', () => ({
  isIpcAvailable: vi.fn(),
  getIpcErrorMessage: vi.fn((type?: string, originalError?: string) => {
    if (type === 'ipc_unavailable') {return '❌ IPC 服务不可用。';}
    return `❌ 操作失败: ${originalError ?? '未知错误'}`;
  }),
}));

vi.mock('./callback-manager.js', () => ({
  invokeMessageSentCallback: vi.fn(),
}));

import { send_card } from './send-card.js';
import { getIpcClient } from '@disclaude/core';
import { getFeishuCredentials } from './credentials.js';
import { isIpcAvailable } from './ipc-utils.js';
import { isValidFeishuCard } from '../utils/card-validator.js';
import { invokeMessageSentCallback } from './callback-manager.js';

const mockIpcClient = {
  sendCard: vi.fn(),
};

const validCard = {
  config: { wide_screen_mode: true },
  header: { title: { tag: 'plain_text', content: 'Test' } },
  elements: [],
};

describe('send_card', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getIpcClient).mockReturnValue(mockIpcClient as any);
    vi.mocked(getFeishuCredentials).mockReturnValue({ appId: 'test-app-id', appSecret: 'test-secret' });
    vi.mocked(isIpcAvailable).mockResolvedValue(true);
    vi.mocked(isValidFeishuCard).mockReturnValue(true);
  });

  describe('parameter validation', () => {
    it('should return error when card is falsy', async () => {
      const result = await send_card({ card: null as any, chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('card is required');
    });

    it('should return error when chatId is empty', async () => {
      const result = await send_card({ card: validCard, chatId: '' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('chatId is required');
    });
  });

  describe('card validation', () => {
    it('should return error when card structure is invalid', async () => {
      vi.mocked(isValidFeishuCard).mockReturnValue(false);
      const result = await send_card({ card: { foo: 'bar' }, chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Card validation failed');
    });
  });

  describe('credential validation', () => {
    it('should return error when appId is missing', async () => {
      vi.mocked(getFeishuCredentials).mockReturnValue({ appId: undefined, appSecret: 'secret' });
      const result = await send_card({ card: validCard, chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('credentials not configured');
    });
  });

  describe('IPC availability', () => {
    it('should return error when IPC is unavailable', async () => {
      vi.mocked(isIpcAvailable).mockResolvedValue(false);
      const result = await send_card({ card: validCard, chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('IPC');
    });
  });

  describe('successful send', () => {
    it('should send card message successfully', async () => {
      mockIpcClient.sendCard.mockResolvedValue({ success: true, messageId: 'msg_123' });
      const result = await send_card({ card: validCard, chatId: 'oc_test' });
      expect(result.success).toBe(true);
      expect(result.message).toContain('sent');
      expect(invokeMessageSentCallback).toHaveBeenCalledWith('oc_test');
    });

    it('should pass parentMessageId to IPC', async () => {
      mockIpcClient.sendCard.mockResolvedValue({ success: true, messageId: 'msg_123' });
      await send_card({ card: validCard, chatId: 'oc_test', parentMessageId: 'parent_456' });
      expect(mockIpcClient.sendCard).toHaveBeenCalledWith(
        'oc_test', validCard, 'parent_456', undefined
      );
    });
  });

  describe('IPC failure', () => {
    it('should return error when IPC send fails', async () => {
      mockIpcClient.sendCard.mockResolvedValue({ success: false, error: 'Send failed', errorType: 'ipc_request_failed' });
      const result = await send_card({ card: validCard, chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Send failed');
    });
  });

  describe('error handling', () => {
    it('should catch unexpected errors and return error result', async () => {
      vi.mocked(getIpcClient).mockImplementation(() => { throw new Error('Unexpected'); });
      const result = await send_card({ card: validCard, chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unexpected');
    });
  });
});
