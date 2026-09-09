/**
 * Tests for send_text tool.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
// Issue #4129: sendMessage is now a standalone function exported from @disclaude/core.
// Production calls sendMessage(client, ...). Mock it to drop the client arg and delegate
// to the same spy as the legacy client.sendMessage(...) instance method so existing
// test assertions (mockChannelApiClient.sendMessage) keep working unchanged.
const { mockChannelApiClient, mockSendMessage, mockGetChannelApiClient } = vi.hoisted(() => {
  const mockSendMessage = vi.fn();
  const mockChannelApiClient = { sendMessage: mockSendMessage };
  const mockGetChannelApiClient = vi.fn().mockReturnValue(mockChannelApiClient);
  return { mockChannelApiClient, mockSendMessage, mockGetChannelApiClient };
});

vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  sendMessage: (...args: unknown[]) => mockSendMessage(...args.slice(1)),
}));

vi.mock('./channel-api-utils.js', () => ({
  // Issue #4280 (Phase 3, part 3): tools construct the REST client via this
  // factory — mock it to return the shared mockChannelApiClient.
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
  setMessageSentCallback: vi.fn(),
  getMessageSentCallback: vi.fn(),
}));

import { send_text } from './send-message.js';
import { isChannelApiAvailable } from './channel-api-utils.js';
import { invokeMessageSentCallback } from './callback-manager.js';

describe('send_text', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChannelApiClient.mockReturnValue(mockChannelApiClient);
    vi.mocked(isChannelApiAvailable).mockResolvedValue(true);
  });

  describe('parameter validation', () => {
    it('should return error when text is empty', async () => {
      const result = await send_text({ text: '', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('text is required');
    });

    it('should return error when chatId is empty', async () => {
      const result = await send_text({ text: 'hello', chatId: '' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('chatId is required');
    });
  });

  describe('REST API availability', () => {
    it('should return error when REST API is unavailable', async () => {
      vi.mocked(isChannelApiAvailable).mockResolvedValue(false);
      const result = await send_text({ text: 'hello', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('REST API');
    });

    it('should append the thread-preserving lark-cli fallback hint (Issue #4576)', async () => {
      vi.mocked(isChannelApiAvailable).mockResolvedValue(false);
      const result = await send_text({
        text: 'hello',
        chatId: 'oc_test',
        parentMessageId: 'om_parent123',
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('+messages-reply --message-id om_parent123');
    });
  });

  describe('successful send', () => {
    it('should send text message successfully', async () => {
      mockChannelApiClient.sendMessage.mockResolvedValue({ success: true, messageId: 'msg_123' });
      const result = await send_text({ text: 'hello world', chatId: 'oc_test' });
      expect(result.success).toBe(true);
      expect(result.message).toContain('sent');
      expect(invokeMessageSentCallback).toHaveBeenCalledWith('oc_test');
    });

    it('should pass parentMessageId to REST API', async () => {
      mockChannelApiClient.sendMessage.mockResolvedValue({ success: true, messageId: 'msg_123' });
      await send_text({ text: 'reply', chatId: 'oc_test', parentMessageId: 'parent_456' });
      expect(mockChannelApiClient.sendMessage).toHaveBeenCalledWith('oc_test', 'reply', 'parent_456', undefined);
    });

    it('should not pass parentMessageId when undefined', async () => {
      mockChannelApiClient.sendMessage.mockResolvedValue({ success: true, messageId: 'msg_123' });
      await send_text({ text: 'hello', chatId: 'oc_test' });
      expect(mockChannelApiClient.sendMessage).toHaveBeenCalledWith('oc_test', 'hello', undefined, undefined);
    });
  });

  describe('REST API failure', () => {
    it('should return error when REST API send fails', async () => {
      mockChannelApiClient.sendMessage.mockResolvedValue({ success: false, error: 'Connection lost', errorType: 'channel_api_request_failed' });
      const result = await send_text({ text: 'hello', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection lost');
    });
  });

  describe('error handling', () => {
    it('should catch unexpected errors and return error result', async () => {
      mockGetChannelApiClient.mockImplementation(() => { throw new Error('Unexpected error'); });
      const result = await send_text({ text: 'hello', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unexpected error');
    });

    it('should handle non-Error objects in catch', async () => {
      // eslint-disable-next-line no-throw-literal
      mockGetChannelApiClient.mockImplementation(() => { throw 'string error'; });
      const result = await send_text({ text: 'hello', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unknown error');
    });
  });
});
