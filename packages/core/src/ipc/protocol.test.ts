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

    it('should type-check messaging API requests', () => {
      const sendMessage: IpcRequest<'sendMessage'> = {
        type: 'sendMessage',
        id: 'req-5',
        payload: { chatId: 'chat-1', text: 'Hello', threadId: 'thread-1' },
      };
      expect(sendMessage.payload.threadId).toBe('thread-1');

      const sendCard: IpcRequest<'sendCard'> = {
        type: 'sendCard',
        id: 'req-6',
        payload: {
          chatId: 'chat-1',
          card: { config: {}, header: { title: { tag: 'plain_text', content: 'Test' } }, elements: [] },
          description: 'Test card',
        },
      };
      expect(sendCard.payload.description).toBe('Test card');

      const uploadFile: IpcRequest<'uploadFile'> = {
        type: 'uploadFile',
        id: 'req-7',
        payload: { chatId: 'chat-1', filePath: '/path/to/file.pdf' },
      };
      expect(uploadFile.payload.filePath).toBe('/path/to/file.pdf');
    });

    it('should type-check sendInteractive request', () => {
      const sendInteractive: IpcRequest<'sendInteractive'> = {
        type: 'sendInteractive',
        id: 'req-9',
        payload: {
          chatId: 'chat-1',
          question: 'Choose an option:',
          options: [
            { text: 'Confirm', value: 'confirm', type: 'primary' },
            { text: 'Cancel', value: 'cancel' },
          ],
          title: 'Action Required',
          context: 'Some context',
          threadId: 'thread-1',
          actionPrompts: { confirm: 'User confirmed', cancel: 'User cancelled' },
        },
      };
      expect(sendInteractive.payload.question).toBe('Choose an option:');
      expect(sendInteractive.payload.options).toHaveLength(2);
      expect(sendInteractive.payload.options[0].type).toBe('primary');
      expect(sendInteractive.payload.actionPrompts?.confirm).toBe('User confirmed');
    });

    it('should type-check group management requests (Issue #1546)', () => {
      const createChat: IpcRequest<'createChat'> = {
        type: 'createChat',
        id: 'req-10',
        payload: {
          name: 'PR Review Group',
          description: 'Review discussion',
          memberIds: ['ou_xxx', 'ou_yyy'],
        },
      };
      expect(createChat.payload.name).toBe('PR Review Group');
      expect(createChat.payload.memberIds).toHaveLength(2);

      const createChatMinimal: IpcRequest<'createChat'> = {
        type: 'createChat',
        id: 'req-11',
        payload: {},
      };
      expect(createChatMinimal.payload.name).toBeUndefined();

      const dissolveChat: IpcRequest<'dissolveChat'> = {
        type: 'dissolveChat',
        id: 'req-12',
        payload: { chatId: 'oc_xxx' },
      };
      expect(dissolveChat.payload.chatId).toBe('oc_xxx');
    });

    it('should type-check group member management requests (Issue #1678)', () => {
      const addMembers: IpcRequest<'addMembers'> = {
        type: 'addMembers',
        id: 'req-20',
        payload: { chatId: 'oc_xxx', memberIds: ['ou_a', 'ou_b'] },
      };
      expect(addMembers.payload.chatId).toBe('oc_xxx');
      expect(addMembers.payload.memberIds).toHaveLength(2);

      const removeMembers: IpcRequest<'removeMembers'> = {
        type: 'removeMembers',
        id: 'req-21',
        payload: { chatId: 'oc_xxx', memberIds: ['ou_a'] },
      };
      expect(removeMembers.payload.memberIds).toHaveLength(1);

      const getMembers: IpcRequest<'getMembers'> = {
        type: 'getMembers',
        id: 'req-22',
        payload: { chatId: 'oc_xxx' },
      };
      expect(getMembers.payload.chatId).toBe('oc_xxx');

      const getBotChats: IpcRequest<'getBotChats'> = {
        type: 'getBotChats',
        id: 'req-23',
        payload: {},
      };
      expect(getBotChats.payload).toEqual({});
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

    it('should type-check messaging API responses', () => {
      const msgResponse: IpcResponse<'sendMessage'> = {
        id: 'req-1',
        success: true,
        payload: { success: true, messageId: 'om_xxx' },
      };
      expect(msgResponse.payload?.messageId).toBe('om_xxx');

      const fileResponse: IpcResponse<'uploadFile'> = {
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
        payload: { success: true, messageId: 'om_interactive' },
      };
      expect(interactiveResponse.payload?.success).toBe(true);
      expect(interactiveResponse.payload?.messageId).toBe('om_interactive');
    });

    it('should type-check group management responses (Issue #1546)', () => {
      const createResponse: IpcResponse<'createChat'> = {
        id: 'req-10',
        success: true,
        payload: { success: true, chatId: 'oc_new', name: 'PR Review' },
      };
      expect(createResponse.payload?.chatId).toBe('oc_new');
      expect(createResponse.payload?.name).toBe('PR Review');

      const dissolveResponse: IpcResponse<'dissolveChat'> = {
        id: 'req-12',
        success: true,
        payload: { success: true },
      };
      expect(dissolveResponse.payload?.success).toBe(true);
    });

    it('should type-check group member management responses (Issue #1678)', () => {
      const addMembersResponse: IpcResponse<'addMembers'> = {
        id: 'req-20',
        success: true,
        payload: { success: true },
      };
      expect(addMembersResponse.payload?.success).toBe(true);

      const removeMembersResponse: IpcResponse<'removeMembers'> = {
        id: 'req-21',
        success: true,
        payload: { success: true },
      };
      expect(removeMembersResponse.payload?.success).toBe(true);

      const getMembersResponse: IpcResponse<'getMembers'> = {
        id: 'req-22',
        success: true,
        payload: { success: true, members: ['ou_a', 'ou_b', 'ou_c'] },
      };
      expect(getMembersResponse.payload?.success).toBe(true);
      expect(getMembersResponse.payload?.members).toHaveLength(3);

      const getBotChatsResponse: IpcResponse<'getBotChats'> = {
        id: 'req-23',
        success: true,
        payload: {
          success: true,
          chats: [
            { chatId: 'oc_1', name: 'Group A' },
            { chatId: 'oc_2', name: 'Group B' },
          ],
        },
      };
      expect(getBotChatsResponse.payload?.success).toBe(true);
      expect(getBotChatsResponse.payload?.chats).toHaveLength(2);
      expect(getBotChatsResponse.payload?.chats?.[0].name).toBe('Group A');
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
