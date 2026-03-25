/**
 * Comprehensive tests for IPC Server - createInteractiveMessageHandler.
 *
 * Tests all request types, error paths, and edge cases for the handler function.
 * @module ipc/unix-socket-server.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createInteractiveMessageHandler,
  type IpcRequestHandler,
  type FeishuApiHandlers,
  type FeishuHandlersContainer,
} from './unix-socket-server.js';

describe('createInteractiveMessageHandler', () => {
  let registerActionPrompts: ReturnType<typeof vi.fn>;
  let handler: IpcRequestHandler;

  beforeEach(() => {
    registerActionPrompts = vi.fn();
    handler = createInteractiveMessageHandler(registerActionPrompts);
  });

  function createMockContainer(overrides?: Partial<FeishuApiHandlers>): FeishuHandlersContainer {
    return {
      handlers: {
        sendMessage: vi.fn().mockResolvedValue(undefined),
        sendCard: vi.fn().mockResolvedValue(undefined),
        uploadFile: vi.fn().mockResolvedValue({ fileKey: '', fileType: 'file', fileName: 'f', fileSize: 0 }),
        sendInteractive: vi.fn().mockResolvedValue({ messageId: 'om_test' }),
        ...overrides,
      },
    };
  }

  describe('ping', () => {
    it('should respond with pong', async () => {
      const response = await handler({
        type: 'ping',
        id: 'req-1',
        payload: {},
      });

      expect(response.success).toBe(true);
      expect(response.id).toBe('req-1');
      expect(response.payload).toEqual({ pong: true });
    });
  });

  describe('sendMessage', () => {
    it('should return error when handlers not available', async () => {
      const response = await handler({
        type: 'sendMessage',
        id: 'req-2',
        payload: { chatId: 'chat-1', text: 'Hello' },
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain('not available');
    });

    it('should call sendMessage handler and return success', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const container = createMockContainer({ sendMessage });
      const handlerWithFeishu = createInteractiveMessageHandler(registerActionPrompts, container);

      const response = await handlerWithFeishu({
        type: 'sendMessage',
        id: 'req-3',
        payload: { chatId: 'chat-1', text: 'Hello', threadId: 'thread-1' },
      });

      expect(response.success).toBe(true);
      expect(response.payload).toEqual({ success: true });
      expect(sendMessage).toHaveBeenCalledWith('chat-1', 'Hello', 'thread-1');
    });

    it('should call sendMessage without threadId', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const container = createMockContainer({ sendMessage });
      const handlerWithFeishu = createInteractiveMessageHandler(registerActionPrompts, container);

      await handlerWithFeishu({
        type: 'sendMessage',
        id: 'req-3b',
        payload: { chatId: 'chat-1', text: 'Hello' },
      });

      expect(sendMessage).toHaveBeenCalledWith('chat-1', 'Hello', undefined);
    });

    it('should handle sendMessage error from handler', async () => {
      const sendMessage = vi.fn().mockRejectedValue(new Error('API rate limited'));
      const container = createMockContainer({ sendMessage });
      const handlerWithFeishu = createInteractiveMessageHandler(registerActionPrompts, container);

      const response = await handlerWithFeishu({
        type: 'sendMessage',
        id: 'req-4',
        payload: { chatId: 'chat-1', text: 'Hello' },
      });

      expect(response.success).toBe(false);
      expect(response.error).toBe('API rate limited');
    });

    it('should handle non-Error objects thrown by sendMessage', async () => {
      const sendMessage = vi.fn().mockRejectedValue('string error');
      const container = createMockContainer({ sendMessage });
      const handlerWithFeishu = createInteractiveMessageHandler(registerActionPrompts, container);

      const response = await handlerWithFeishu({
        type: 'sendMessage',
        id: 'req-5',
        payload: { chatId: 'chat-1', text: 'Hello' },
      });

      expect(response.success).toBe(false);
      expect(response.error).toBe('Unknown error');
    });
  });

  describe('sendCard', () => {
    it('should return error when handlers not available', async () => {
      const response = await handler({
        type: 'sendCard',
        id: 'req-6',
        payload: { chatId: 'chat-1', card: { type: 'text' } },
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain('not available');
    });

    it('should call sendCard handler and return success', async () => {
      const sendCard = vi.fn().mockResolvedValue(undefined);
      const container = createMockContainer({ sendCard });
      const handlerWithFeishu = createInteractiveMessageHandler(registerActionPrompts, container);

      const card = { type: 'markdown', content: '# Hello' };
      const response = await handlerWithFeishu({
        type: 'sendCard',
        id: 'req-7',
        payload: { chatId: 'chat-1', card, description: 'Test card' },
      });

      expect(response.success).toBe(true);
      expect(response.payload).toEqual({ success: true });
      expect(sendCard).toHaveBeenCalledWith('chat-1', card, undefined, 'Test card');
    });

    it('should pass threadId to sendCard handler', async () => {
      const sendCard = vi.fn().mockResolvedValue(undefined);
      const container = createMockContainer({ sendCard });
      const handlerWithFeishu = createInteractiveMessageHandler(registerActionPrompts, container);

      await handlerWithFeishu({
        type: 'sendCard',
        id: 'req-8',
        payload: { chatId: 'chat-1', card: {}, threadId: 'thread-1' },
      });

      expect(sendCard).toHaveBeenCalledWith('chat-1', {}, 'thread-1', undefined);
    });

    it('should handle sendCard error from handler', async () => {
      const sendCard = vi.fn().mockRejectedValue(new Error('Card too large'));
      const container = createMockContainer({ sendCard });
      const handlerWithFeishu = createInteractiveMessageHandler(registerActionPrompts, container);

      const response = await handlerWithFeishu({
        type: 'sendCard',
        id: 'req-9',
        payload: { chatId: 'chat-1', card: {} },
      });

      expect(response.success).toBe(false);
      expect(response.error).toBe('Card too large');
    });
  });

  describe('uploadFile', () => {
    it('should return error when handlers not available', async () => {
      const response = await handler({
        type: 'uploadFile',
        id: 'req-10',
        payload: { chatId: 'chat-1', filePath: '/path/to/file.pdf' },
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain('not available');
    });

    it('should call uploadFile handler and return result', async () => {
      const uploadResult = { fileKey: 'file_xxx', fileType: 'pdf', fileName: 'test.pdf', fileSize: 1024 };
      const uploadFile = vi.fn().mockResolvedValue(uploadResult);
      const container = createMockContainer({ uploadFile });
      const handlerWithFeishu = createInteractiveMessageHandler(registerActionPrompts, container);

      const response = await handlerWithFeishu({
        type: 'uploadFile',
        id: 'req-11',
        payload: { chatId: 'chat-1', filePath: '/path/to/file.pdf', threadId: 'thread-1' },
      });

      expect(response.success).toBe(true);
      expect(response.payload).toEqual({ success: true, ...uploadResult });
      expect(uploadFile).toHaveBeenCalledWith('chat-1', '/path/to/file.pdf', 'thread-1');
    });

    it('should handle uploadFile error from handler', async () => {
      const uploadFile = vi.fn().mockRejectedValue(new Error('File too large'));
      const container = createMockContainer({ uploadFile });
      const handlerWithFeishu = createInteractiveMessageHandler(registerActionPrompts, container);

      const response = await handlerWithFeishu({
        type: 'uploadFile',
        id: 'req-12',
        payload: { chatId: 'chat-1', filePath: '/path/to/file.pdf' },
      });

      expect(response.success).toBe(false);
      expect(response.error).toBe('File too large');
    });

    it('should handle non-Error objects thrown by uploadFile', async () => {
      const uploadFile = vi.fn().mockRejectedValue({ code: 'ENOENT' });
      const container = createMockContainer({ uploadFile });
      const handlerWithFeishu = createInteractiveMessageHandler(registerActionPrompts, container);

      const response = await handlerWithFeishu({
        type: 'uploadFile',
        id: 'req-12b',
        payload: { chatId: 'chat-1', filePath: '/path/to/file.pdf' },
      });

      expect(response.success).toBe(false);
      expect(response.error).toBe('Unknown error');
    });
  });

  describe('sendInteractive', () => {
    it('should return error when handlers not available', async () => {
      const response = await handler({
        type: 'sendInteractive',
        id: 'req-13',
        payload: {
          chatId: 'chat-1',
          question: 'Choose:',
          options: [{ text: 'OK', value: 'ok' }],
        },
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain('not available');
    });

    it('should call sendInteractive handler and use result actionPrompts', async () => {
      const sendInteractive = vi.fn().mockResolvedValue({
        messageId: 'om_confirm',
        actionPrompts: { confirm: 'User confirmed' },
      });
      const container = createMockContainer({ sendInteractive });
      const handlerWithFeishu = createInteractiveMessageHandler(registerActionPrompts, container);

      const response = await handlerWithFeishu({
        type: 'sendInteractive',
        id: 'req-14',
        payload: {
          chatId: 'chat-1',
          question: 'Choose:',
          options: [{ text: 'OK', value: 'ok' }],
          actionPrompts: { ok: 'User clicked OK' },
        },
      });

      expect(response.success).toBe(true);
      expect(response.payload).toEqual({
        success: true,
        messageId: 'om_confirm',
        actionPrompts: { confirm: 'User confirmed' },
      });
      // Should use result.actionPrompts over request actionPrompts
      expect(registerActionPrompts).toHaveBeenCalledWith(
        'om_confirm',
        'chat-1',
        { confirm: 'User confirmed' }
      );
    });

    it('should fall back to request actionPrompts when result has none', async () => {
      const sendInteractive = vi.fn().mockResolvedValue({ messageId: 'om_action' });
      const container = createMockContainer({ sendInteractive });
      const handlerWithFeishu = createInteractiveMessageHandler(registerActionPrompts, container);

      const actionPrompts = { action1: 'prompt1' };
      await handlerWithFeishu({
        type: 'sendInteractive',
        id: 'req-15',
        payload: {
          chatId: 'chat-1',
          question: 'Choose:',
          options: [{ text: 'A', value: 'a' }],
          actionPrompts,
        },
      });

      expect(registerActionPrompts).toHaveBeenCalledWith('om_action', 'chat-1', actionPrompts);
    });

    it('should not register action prompts when no messageId returned', async () => {
      const sendInteractive = vi.fn().mockResolvedValue({});
      const container = createMockContainer({ sendInteractive });
      const handlerWithFeishu = createInteractiveMessageHandler(registerActionPrompts, container);

      await handlerWithFeishu({
        type: 'sendInteractive',
        id: 'req-16',
        payload: {
          chatId: 'chat-1',
          question: 'Choose:',
          options: [{ text: 'A', value: 'a' }],
          actionPrompts: { a: 'User chose A' },
        },
      });

      expect(registerActionPrompts).not.toHaveBeenCalled();
    });

    it('should pass all parameters to sendInteractive handler', async () => {
      const sendInteractive = vi.fn().mockResolvedValue({ messageId: 'om_1' });
      const container = createMockContainer({ sendInteractive });
      const handlerWithFeishu = createInteractiveMessageHandler(registerActionPrompts, container);

      await handlerWithFeishu({
        type: 'sendInteractive',
        id: 'req-17',
        payload: {
          chatId: 'chat-1',
          question: 'Choose:',
          options: [
            { text: 'A', value: 'a', type: 'primary' },
            { text: 'B', value: 'b' },
          ],
          title: 'Title',
          context: 'Context',
          threadId: 'thread-1',
        },
      });

      expect(sendInteractive).toHaveBeenCalledWith('chat-1', {
        question: 'Choose:',
        options: [
          { text: 'A', value: 'a', type: 'primary' },
          { text: 'B', value: 'b' },
        ],
        title: 'Title',
        context: 'Context',
        threadId: 'thread-1',
        actionPrompts: undefined,
      });
    });

    it('should handle sendInteractive error from handler', async () => {
      const sendInteractive = vi.fn().mockRejectedValue(new Error('Card build failed'));
      const container = createMockContainer({ sendInteractive });
      const handlerWithFeishu = createInteractiveMessageHandler(registerActionPrompts, container);

      const response = await handlerWithFeishu({
        type: 'sendInteractive',
        id: 'req-18',
        payload: {
          chatId: 'chat-1',
          question: 'Choose:',
          options: [{ text: 'A', value: 'a' }],
        },
      });

      expect(response.success).toBe(false);
      expect(response.error).toBe('Card build failed');
    });
  });

  describe('unknown request type', () => {
    it('should return error for unknown request type', async () => {
      const response = await handler({
        type: 'unknownType' as any,
        id: 'req-19',
        payload: {},
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain('Unknown request type');
      expect(response.error).toContain('unknownType');
    });
  });

  describe('handler without container', () => {
    it('should work without feishuHandlersContainer for ping', async () => {
      const handlerNoContainer = createInteractiveMessageHandler(registerActionPrompts);
      const response = await handlerNoContainer({
        type: 'ping',
        id: 'req-20',
        payload: {},
      });

      expect(response.success).toBe(true);
    });

    it('should return error for all messaging ops without container', async () => {
      const handlerNoContainer = createInteractiveMessageHandler(registerActionPrompts);

      for (const type of ['sendMessage', 'sendCard', 'uploadFile', 'sendInteractive'] as const) {
        const response = await handlerNoContainer({
          type,
          id: `req-${type}`,
          payload: type === 'ping' ? {} : { chatId: 'chat-1' },
        } as any);

        expect(response.success).toBe(false);
        expect(response.error).toContain('not available');
      }
    });
  });

  describe('handler with empty container (handlers undefined)', () => {
    it('should return error when handlers is undefined in container', async () => {
      const emptyContainer: FeishuHandlersContainer = { handlers: undefined };
      const handlerEmpty = createInteractiveMessageHandler(registerActionPrompts, emptyContainer);

      const response = await handlerEmpty({
        type: 'sendMessage',
        id: 'req-22',
        payload: { chatId: 'chat-1', text: 'Hello' },
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain('not available');
    });
  });
});
