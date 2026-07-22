/**
 * Tests for ipc-client-facade — the IPC convenience methods.
 *
 * These functions (sendMessage, sendCard, uploadFile, etc.) are the primary
 * API the mcp-server uses to communicate with PrimaryNode. They had zero
 * test coverage. This tests:
 * - Happy path: delegates to client.request with correct type + payload
 * - Error path: catches errors, classifies them, returns {success:false}
 */

import { describe, it, expect, vi } from 'vitest';
import type { IpcRequestType, IpcRequestPayloads, IpcResponsePayloads } from './protocol.js';
import type { IpcClientLike } from './ipc-client-facade.js';

function createMockClient(
  responses: Partial<Record<string, unknown>>,
): IpcClientLike {
  return {
    request: vi.fn(<T extends IpcRequestType>(
      type: T,
      _payload: IpcRequestPayloads[T],
    ): Promise<IpcResponsePayloads[T]> => {
      const r = responses[type];
      if (r instanceof Error) { return Promise.reject(r); }
      return Promise.resolve(r as IpcResponsePayloads[T]);
    }),
  };
}

describe('ipc-client-facade', () => {
  describe('sendMessage', () => {
    it('should delegate to client.request with correct payload', async () => {
      const client = createMockClient({ sendMessage: { success: true, messageId: 'om_1' } });
      const { sendMessage } = await import('./ipc-client-facade.js');

      const result = await sendMessage(client, 'oc_test', 'hello', 'om_thread', [{ openId: 'ou_a' }]);

      expect(result).toEqual({ success: true, messageId: 'om_1' });
      expect(client.request).toHaveBeenCalledWith('sendMessage', {
        chatId: 'oc_test', text: 'hello', threadId: 'om_thread', mentions: [{ openId: 'ou_a' }],
      });
    });

    it('should return error result on failure', async () => {
      const client = createMockClient({ sendMessage: new Error('IPC down') });
      const { sendMessage } = await import('./ipc-client-facade.js');

      const result = await sendMessage(client, 'oc_test', 'hi');

      expect(result.success).toBe(false);
      expect(result.error).toContain('IPC down');
    });
  });

  describe('sendCard', () => {
    it('should delegate with card payload', async () => {
      const client = createMockClient({ sendCard: { success: true, messageId: 'om_2' } });
      const { sendCard } = await import('./ipc-client-facade.js');
      const card = { config: {}, elements: [] };

      const result = await sendCard(client, 'oc_test', card as never, 'om_root', 'desc');

      expect(result).toEqual({ success: true, messageId: 'om_2' });
      expect(client.request).toHaveBeenCalledWith('sendCard', {
        chatId: 'oc_test', card, threadId: 'om_root', description: 'desc',
      });
    });
  });

  describe('uploadFile', () => {
    it('should delegate with filePath payload', async () => {
      const client = createMockClient({ uploadFile: { success: true, fileKey: 'fk_1', fileType: 'pdf', fileName: 'a.pdf', fileSize: 42 } });
      const { uploadFile } = await import('./ipc-client-facade.js');

      const result = await uploadFile(client, 'oc_test', '/tmp/a.pdf', 'om_root');

      expect(result).toEqual({ success: true, fileKey: 'fk_1', fileType: 'pdf', fileName: 'a.pdf', fileSize: 42 });
    });
  });

  describe('uploadImage', () => {
    it('should delegate with filePath payload', async () => {
      const client = createMockClient({ uploadImage: { success: true, imageKey: 'img_1' } });
      const { uploadImage } = await import('./ipc-client-facade.js');

      const result = await uploadImage(client, '/tmp/img.png');

      expect(result).toEqual({ success: true, imageKey: 'img_1' });
    });
  });

  describe('pushToAgent', () => {
    it('should delegate with chatId + message payload', async () => {
      const client = createMockClient({ pushToAgent: { success: true } });
      const { pushToAgent } = await import('./ipc-client-facade.js');

      const result = await pushToAgent(client, 'oc_test', 'do something');

      expect(result).toEqual({ success: true });
      expect(client.request).toHaveBeenCalledWith('pushToAgent', {
        chatId: 'oc_test', message: 'do something', waitForCompletion: undefined,
      }, { timeoutMs: undefined });
    });
  });

  describe('listTempChats', () => {
    it('should delegate and return chats array', async () => {
      const client = createMockClient({
        listTempChats: { success: true, chats: [{ chatId: 'oc_t1', createdAt: '', expiresAt: '', responded: false }] },
      });
      const { listTempChats } = await import('./ipc-client-facade.js');

      const result = await listTempChats(client);

      expect(result.success).toBe(true);
      expect(result.chats).toHaveLength(1);
    });
  });

  describe('markChatResponded', () => {
    it('should delegate with response payload', async () => {
      const client = createMockClient({ markChatResponded: { success: true } });
      const { markChatResponded } = await import('./ipc-client-facade.js');

      const result = await markChatResponded(client, 'oc_test', {
        selectedValue: 'approve', responder: 'ou_a', repliedAt: '2026-07-16T00:00:00Z',
      });

      expect(result).toEqual({ success: true });
    });
  });

  describe('sendInteractive', () => {
    it('should delegate with chatId merged into raw card params', async () => {
      const client = createMockClient({ sendInteractive: { success: true, messageId: 'om_3' } });
      const { sendInteractive } = await import('./ipc-client-facade.js');
      const params = {
        question: 'Approve?',
        options: [
          { text: 'Yes', value: 'yes', type: 'primary' as const },
          { text: 'No', value: 'no', type: 'danger' as const },
        ],
        title: 'Review',
        context: 'PR #4355',
        threadId: 'om_thread',
        actionPrompts: { yes: 'User approved', no: 'User declined' },
      };

      const result = await sendInteractive(client, 'oc_test', params);

      expect(result).toEqual({ success: true, messageId: 'om_3' });
      expect(client.request).toHaveBeenCalledWith('sendInteractive', {
        chatId: 'oc_test',
        ...params,
      });
    });
  });

  describe('classifyError', () => {
    // classifyError is internal; exercise it through the public error path.
    it('classifies IPC_NOT_AVAILABLE prefix as ipc_unavailable', async () => {
      const client = createMockClient({ sendMessage: new Error('IPC_NOT_AVAILABLE: socket not connected') });
      const { sendMessage } = await import('./ipc-client-facade.js');

      const result = await sendMessage(client, 'oc_test', 'hi');

      expect(result.success).toBe(false);
      expect(result.errorType).toBe('ipc_unavailable');
    });

    it('classifies IPC_TIMEOUT prefix as ipc_timeout', async () => {
      const client = createMockClient({ sendMessage: new Error('IPC_TIMEOUT: request timed out after 5000ms') });
      const { sendMessage } = await import('./ipc-client-facade.js');

      const result = await sendMessage(client, 'oc_test', 'hi');

      expect(result.success).toBe(false);
      expect(result.errorType).toBe('ipc_timeout');
    });

    it('defaults to ipc_request_failed for generic errors', async () => {
      const client = createMockClient({ sendMessage: new Error('unexpected payload shape') });
      const { sendMessage } = await import('./ipc-client-facade.js');

      const result = await sendMessage(client, 'oc_test', 'hi');

      expect(result.success).toBe(false);
      expect(result.errorType).toBe('ipc_request_failed');
    });
  });
});
