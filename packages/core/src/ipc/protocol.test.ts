/**
 * Unit tests for IPC Protocol
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_IPC_CONFIG,
  generateSocketPath,
  type IpcRequest,
  type IpcResponse,
  type IpcConfig,
} from './protocol.js';

describe('IPC Protocol', () => {
  describe('DEFAULT_IPC_CONFIG', () => {
    it('should have correct default values', () => {
      expect(DEFAULT_IPC_CONFIG.socketPath).toBe('/tmp/disclaude-interactive.ipc');
      expect(DEFAULT_IPC_CONFIG.timeout).toBe(5000);
      expect(DEFAULT_IPC_CONFIG.maxRetries).toBe(3);
    });
  });

  describe('generateSocketPath', () => {
    it('should generate a unique path in tmpdir', () => {
      const path1 = generateSocketPath();
      const path2 = generateSocketPath();

      expect(path1).toContain('.sock');
      expect(path2).toContain('.sock');
      expect(path1).not.toBe(path2);
    });

    it('should include process PID in path', () => {
      const path = generateSocketPath();
      expect(path).toContain(`disclaude-ipc-${process.pid}`);
    });

    it('should include timestamp for uniqueness', () => {
      const before = Date.now();
      const path = generateSocketPath();
      const after = Date.now();
      // Extract timestamp from path
      const match = path.match(/disclaude-ipc-\d+-(\d+)-/);
      expect(match).not.toBeNull();
      const timestamp = parseInt(match![1], 10);
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });

    it('should include random suffix', () => {
      const paths = new Set<string>();
      for (let i = 0; i < 10; i++) {
        paths.add(generateSocketPath());
      }
      // All paths should be unique
      expect(paths.size).toBe(10);
    });
  });

  describe('IpcRequest types', () => {
    it('should type-check ping request', () => {
      const request: IpcRequest<'ping'> = {
        type: 'ping',
        id: 'req-1',
        payload: {},
      };
      expect(request.type).toBe('ping');
      expect(request.id).toBe('req-1');
    });

    it('should type-check feishu API requests', () => {
      const sendMessage: IpcRequest<'feishuSendMessage'> = {
        type: 'feishuSendMessage',
        id: 'req-5',
        payload: { chatId: 'chat-1', text: 'Hello', threadId: 'thread-1' },
      };
      expect(sendMessage.payload.threadId).toBe('thread-1');

      const sendCard: IpcRequest<'feishuSendCard'> = {
        type: 'feishuSendCard',
        id: 'req-6',
        payload: { chatId: 'chat-1', card: { type: 'text' }, description: 'Test card' },
      };
      expect(sendCard.payload.description).toBe('Test card');

      const uploadFile: IpcRequest<'feishuUploadFile'> = {
        type: 'feishuUploadFile',
        id: 'req-7',
        payload: { chatId: 'chat-1', filePath: '/path/to/file.pdf' },
      };
      expect(uploadFile.payload.filePath).toBe('/path/to/file.pdf');

      const getBotInfo: IpcRequest<'feishuGetBotInfo'> = {
        type: 'feishuGetBotInfo',
        id: 'req-8',
        payload: {},
      };
      expect(getBotInfo.payload).toEqual({});
    });

    it('should type-check sendInteractive request', () => {
      const sendInteractive: IpcRequest<'sendInteractive'> = {
        type: 'sendInteractive',
        id: 'req-9',
        payload: {
          chatId: 'chat-1',
          question: 'What do you prefer?',
          options: [
            { text: 'Option A', value: 'a', style: 'primary' },
            { text: 'Option B', value: 'b' },
          ],
          title: 'Pick one',
          context: 'Survey context',
          threadId: 'thread-1',
        },
      };
      expect(sendInteractive.payload.chatId).toBe('chat-1');
      expect(sendInteractive.payload.question).toBe('What do you prefer?');
      expect(sendInteractive.payload.options).toHaveLength(2);
      expect(sendInteractive.payload.options[0].style).toBe('primary');
      expect(sendInteractive.payload.context).toBe('Survey context');
    });
  });

  describe('IpcResponse types', () => {
    it('should type-check success response', () => {
      const response: IpcResponse<'ping'> = {
        id: 'req-1',
        success: true,
        payload: { pong: true },
      };
      expect(response.success).toBe(true);
      expect(response.payload?.pong).toBe(true);
    });

    it('should type-check error response', () => {
      const response: IpcResponse<'ping'> = {
        id: 'req-1',
        success: false,
        error: 'Connection failed',
      };
      expect(response.success).toBe(false);
      expect(response.error).toBe('Connection failed');
    });

    it('should type-check feishu API responses', () => {
      const msgResponse: IpcResponse<'feishuSendMessage'> = {
        id: 'req-1',
        success: true,
        payload: { success: true, messageId: 'om_xxx' },
      };
      expect(msgResponse.payload?.messageId).toBe('om_xxx');

      const fileResponse: IpcResponse<'feishuUploadFile'> = {
        id: 'req-2',
        success: true,
        payload: {
          success: true,
          fileKey: 'file_xxx',
          fileType: 'pdf',
          fileName: 'test.pdf',
          fileSize: 1024,
        },
      };
      expect(fileResponse.payload?.fileSize).toBe(1024);

      const interactiveResponse: IpcResponse<'sendInteractive'> = {
        id: 'req-3',
        success: true,
        payload: { success: true, messageId: 'interactive_chat1_1234' },
      };
      expect(interactiveResponse.payload?.success).toBe(true);
      expect(interactiveResponse.payload?.messageId).toBe('interactive_chat1_1234');
    });
  });

  describe('IpcConfig', () => {
    it('should be a valid config structure', () => {
      const config: IpcConfig = {
        socketPath: '/tmp/test.sock',
        timeout: 3000,
        maxRetries: 5,
      };
      expect(config.socketPath).toBe('/tmp/test.sock');
      expect(config.timeout).toBe(3000);
      expect(config.maxRetries).toBe(5);
    });
  });
});
