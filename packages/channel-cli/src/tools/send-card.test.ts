/**
 * Tests for send_card tool.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
// Issue #4129: sendCard is now a standalone function exported from @disclaude/core.
// Production calls sendCard(client, ...). Mock it to drop the client arg and delegate
// to the same spy as the legacy client.sendCard(...) instance method.
const { mockChannelApiClient, mockSendCard, mockGetChannelApiClient } = vi.hoisted(() => {
  const mockSendCard = vi.fn();
  const mockChannelApiClient = { sendCard: mockSendCard };
  const mockGetChannelApiClient = vi.fn().mockReturnValue(mockChannelApiClient);
  return { mockChannelApiClient, mockSendCard, mockGetChannelApiClient };
});

vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  sendCard: (...args: unknown[]) => mockSendCard(...args.slice(1)),
}));

vi.mock('../utils/card-validator.js', () => ({
  isValidFeishuCard: vi.fn(),
  getCardValidationError: vi.fn((_card: unknown) => 'Invalid card structure'),
}));

vi.mock('./channel-api-utils.js', () => ({
  // Issue #4280 (Phase 3, part 3): REST client factory — returns the shared mock.
  getChannelApiClient: () => mockGetChannelApiClient(),
  isChannelApiAvailable: vi.fn(),
  // Issue #4576: deterministic stub — the unavailable-branch tests assert the
  // fallback hint (thread-preserving +messages-reply) is appended.
  buildChannelApiFallbackHint: (parentMessageId?: string) =>
    `HINT:lark-cli im +messages-reply --message-id ${parentMessageId ?? '<om_...>'}`,
  getChannelApiErrorMessage: vi.fn((type?: string, originalError?: string) => {
    if (type === 'channel_api_unavailable') {return '❌ REST API 服务不可用。';}
    return `❌ 操作失败: ${originalError ?? '未知错误'}`;
  }),
}));

vi.mock('./callback-manager.js', () => ({
  invokeMessageSentCallback: vi.fn(),
}));

import { send_card } from './send-card.js';
import { isChannelApiAvailable } from './channel-api-utils.js';
import { isValidFeishuCard } from '../utils/card-validator.js';
import { invokeMessageSentCallback } from './callback-manager.js';

const validCard = {
  config: { wide_screen_mode: true },
  header: { title: { tag: 'plain_text', content: 'Test' } },
  elements: [],
};

describe('send_card', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChannelApiClient.mockReturnValue(mockChannelApiClient);
    vi.mocked(isChannelApiAvailable).mockResolvedValue(true);
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

  describe('REST API availability', () => {
    it('should return error when REST API is unavailable', async () => {
      vi.mocked(isChannelApiAvailable).mockResolvedValue(false);
      const result = await send_card({ card: validCard, chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('REST API');
    });

    it('should append the thread-preserving lark-cli fallback hint (Issue #4576)', async () => {
      vi.mocked(isChannelApiAvailable).mockResolvedValue(false);
      const result = await send_card({
        card: validCard,
        chatId: 'oc_test',
        parentMessageId: 'om_parent123',
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('+messages-reply --message-id om_parent123');
    });
  });

  describe('successful send', () => {
    it('should send card message successfully', async () => {
      mockChannelApiClient.sendCard.mockResolvedValue({ success: true, messageId: 'msg_123' });
      const result = await send_card({ card: validCard, chatId: 'oc_test' });
      expect(result.success).toBe(true);
      expect(result.message).toContain('sent');
      expect(invokeMessageSentCallback).toHaveBeenCalledWith('oc_test');
    });

    it('should pass parentMessageId to REST API', async () => {
      mockChannelApiClient.sendCard.mockResolvedValue({ success: true, messageId: 'msg_123' });
      await send_card({ card: validCard, chatId: 'oc_test', parentMessageId: 'parent_456' });
      expect(mockChannelApiClient.sendCard).toHaveBeenCalledWith(
        'oc_test', validCard, 'parent_456', undefined
      );
    });
  });

  describe('REST API failure', () => {
    it('should return error when REST API send fails', async () => {
      mockChannelApiClient.sendCard.mockResolvedValue({ success: false, error: 'Send failed', errorType: 'channel_api_request_failed' });
      const result = await send_card({ card: validCard, chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Send failed');
    });
  });

  describe('error handling', () => {
    it('should catch unexpected errors and return error result', async () => {
      mockGetChannelApiClient.mockImplementation(() => { throw new Error('Unexpected'); });
      const result = await send_card({ card: validCard, chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unexpected');
    });
  });
});
