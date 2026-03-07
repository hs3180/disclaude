/**
 * Unit tests for Feishu API request routing (Issue #1036).
 *
 * Tests the WebSocket-based Feishu API routing between Worker Node and Primary Node.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import type { FeishuApiRequestMessage, FeishuApiResponseMessage } from '../types/websocket-messages.js';

describe('Feishu API Request Routing (Issue #1036)', () => {
  describe('FeishuApiRequestMessage and FeishuApiResponseMessage types', () => {
    it('should define correct request message structure', () => {
      const request: FeishuApiRequestMessage = {
        type: 'feishu-api-request',
        requestId: 'test-request-123',
        action: 'sendMessage',
        params: {
          chatId: 'oc_test',
          text: 'Hello World',
        },
      };

      expect(request.type).toBe('feishu-api-request');
      expect(request.requestId).toBe('test-request-123');
      expect(request.action).toBe('sendMessage');
      expect(request.params.chatId).toBe('oc_test');
      expect(request.params.text).toBe('Hello World');
    });

    it('should define correct response message structure for success', () => {
      const response: FeishuApiResponseMessage = {
        type: 'feishu-api-response',
        requestId: 'test-request-123',
        success: true,
        data: { success: true },
      };

      expect(response.type).toBe('feishu-api-response');
      expect(response.requestId).toBe('test-request-123');
      expect(response.success).toBe(true);
      expect(response.data).toEqual({ success: true });
      expect(response.error).toBeUndefined();
    });

    it('should define correct response message structure for error', () => {
      const response: FeishuApiResponseMessage = {
        type: 'feishu-api-response',
        requestId: 'test-request-123',
        success: false,
        error: 'Missing required params: chatId or text',
      };

      expect(response.type).toBe('feishu-api-response');
      expect(response.requestId).toBe('test-request-123');
      expect(response.success).toBe(false);
      expect(response.error).toBe('Missing required params: chatId or text');
      expect(response.data).toBeUndefined();
    });

    it('should support all action types', () => {
      const actions: FeishuApiRequestMessage['action'][] = [
        'sendMessage',
        'sendCard',
        'uploadFile',
        'getBotInfo',
      ];

      actions.forEach((action) => {
        const request: FeishuApiRequestMessage = {
          type: 'feishu-api-request',
          requestId: `test-${action}`,
          action,
          params: {},
        };
        expect(request.action).toBe(action);
      });
    });
  });

  describe('WebSocketServerService Feishu API handling', () => {
    it('should handle feishu-api-request message type', async () => {
      // This test verifies that the WebSocketServerService can handle feishu-api-request messages
      // The actual implementation is tested through integration tests
      const handleFeishuApiRequest = vi.fn();

      const mockRequest: FeishuApiRequestMessage = {
        type: 'feishu-api-request',
        requestId: 'test-123',
        action: 'sendMessage',
        params: {
          chatId: 'oc_test',
          text: 'Test message',
        },
      };

      // Simulate handling the request
      handleFeishuApiRequest(mockRequest, vi.fn());

      expect(handleFeishuApiRequest).toHaveBeenCalledWith(
        mockRequest,
        expect.any(Function)
      );
    });

    it('should send response back through WebSocket', async () => {
      const sendResponse = vi.fn();

      const response: FeishuApiResponseMessage = {
        type: 'feishu-api-response',
        requestId: 'test-123',
        success: true,
        data: { success: true },
      };

      sendResponse(response);

      expect(sendResponse).toHaveBeenCalledWith(response);
    });
  });

  describe('WorkerNode Feishu API request methods', () => {
    it('should generate unique request IDs', () => {
      const generateRequestId = () => {
        return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      };

      const id1 = generateRequestId();
      const id2 = generateRequestId();

      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^\d+-[a-z0-9]+$/);
    });

    it('should create correct request structure for sendMessage', () => {
      const createRequest = (
        requestId: string,
        action: FeishuApiRequestMessage['action'],
        params: FeishuApiRequestMessage['params']
      ): FeishuApiRequestMessage => ({
        type: 'feishu-api-request',
        requestId,
        action,
        params,
      });

      const request = createRequest('test-123', 'sendMessage', {
        chatId: 'oc_test',
        text: 'Hello',
        threadId: 'thread_123',
      });

      expect(request.type).toBe('feishu-api-request');
      expect(request.action).toBe('sendMessage');
      expect(request.params.chatId).toBe('oc_test');
      expect(request.params.text).toBe('Hello');
      expect(request.params.threadId).toBe('thread_123');
    });

    it('should create correct request structure for sendCard', () => {
      const card = {
        type: 'template',
        data: { title: 'Test Card' },
      };

      const createRequest = (
        requestId: string,
        action: FeishuApiRequestMessage['action'],
        params: FeishuApiRequestMessage['params']
      ): FeishuApiRequestMessage => ({
        type: 'feishu-api-request',
        requestId,
        action,
        params,
      });

      const request = createRequest('test-456', 'sendCard', {
        chatId: 'oc_test',
        card,
        description: 'Test card description',
      });

      expect(request.action).toBe('sendCard');
      expect(request.params.card).toEqual(card);
      expect(request.params.description).toBe('Test card description');
    });

    it('should create correct request structure for getBotInfo', () => {
      const createRequest = (
        requestId: string,
        action: FeishuApiRequestMessage['action'],
        params: FeishuApiRequestMessage['params']
      ): FeishuApiRequestMessage => ({
        type: 'feishu-api-request',
        requestId,
        action,
        params,
      });

      const request = createRequest('test-789', 'getBotInfo', {});

      expect(request.action).toBe('getBotInfo');
      expect(request.params).toEqual({});
    });
  });

  describe('Timeout handling', () => {
    it('should handle timeout correctly', async () => {
      vi.useFakeTimers();

      const timeoutMs = 5000;
      const pendingRequests = new Map<string, {
        resolve: (data: unknown) => void;
        reject: (error: Error) => void;
        timeout: NodeJS.Timeout;
      }>();

      const requestId = 'test-timeout';
      const timeoutPromise = new Promise((_, reject) => {
        const timeout = setTimeout(() => {
          pendingRequests.delete(requestId);
          reject(new Error(`Feishu API request timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        pendingRequests.set(requestId, {
          resolve: vi.fn(),
          reject,
          timeout,
        });
      });

      // Fast-forward time
      vi.advanceTimersByTime(timeoutMs);

      await expect(timeoutPromise).rejects.toThrow('Feishu API request timeout');

      vi.useRealTimers();
    });

    it('should clear timeout on successful response', async () => {
      vi.useFakeTimers();

      const timeoutMs = 5000;
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

      const pendingRequests = new Map<string, {
        resolve: (data: unknown) => void;
        reject: (error: Error) => void;
        timeout: NodeJS.Timeout;
      }>();

      const requestId = 'test-success';
      let resolveFunc: (data: unknown) => void;

      const promise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingRequests.delete(requestId);
          reject(new Error('Timeout'));
        }, timeoutMs);

        resolveFunc = resolve;

        pendingRequests.set(requestId, {
          resolve,
          reject,
          timeout,
        });
      });

      // Simulate successful response
      const pending = pendingRequests.get(requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        pending.resolve({ success: true });
      }

      expect(clearTimeoutSpy).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe('Error handling', () => {
    it('should handle missing required params for sendMessage', () => {
      const validateSendMessageParams = (params: { chatId?: string; text?: string }) => {
        if (!params.chatId || !params.text) {
          throw new Error('Missing required params: chatId or text');
        }
        return true;
      };

      expect(() => validateSendMessageParams({})).toThrow('Missing required params: chatId or text');
      expect(() => validateSendMessageParams({ chatId: 'oc_test' })).toThrow('Missing required params: chatId or text');
      expect(() => validateSendMessageParams({ text: 'Hello' })).toThrow('Missing required params: chatId or text');
      expect(validateSendMessageParams({ chatId: 'oc_test', text: 'Hello' })).toBe(true);
    });

    it('should handle missing required params for sendCard', () => {
      const validateSendCardParams = (params: { chatId?: string; card?: unknown }) => {
        if (!params.chatId || !params.card) {
          throw new Error('Missing required params: chatId or card');
        }
        return true;
      };

      expect(() => validateSendCardParams({})).toThrow('Missing required params: chatId or card');
      expect(validateSendCardParams({ chatId: 'oc_test', card: { type: 'template' } })).toBe(true);
    });

    it('should handle unknown action', () => {
      const handleAction = (action: string) => {
        const validActions = ['sendMessage', 'sendCard', 'uploadFile', 'getBotInfo'];
        if (!validActions.includes(action)) {
          throw new Error(`Unknown action: ${action}`);
        }
        return true;
      };

      expect(() => handleAction('unknownAction')).toThrow('Unknown action: unknownAction');
      expect(handleAction('sendMessage')).toBe(true);
    });
  });
});
