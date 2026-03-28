/**
 * Unit tests for member management IPC Protocol types (Issue #1678).
 */

import { describe, it, expect } from 'vitest';
import {
  type IpcRequest,
  type IpcResponse,
} from './protocol.js';

describe('IPC Protocol - Member management (Issue #1678)', () => {
  describe('IpcRequest types', () => {
    it('should type-check addMembers request', () => {
      const request: IpcRequest<'addMembers'> = {
        type: 'addMembers',
        id: 'req-add-1',
        payload: {
          chatId: 'oc_xxx',
          memberIds: ['ou_a', 'ou_b', 'ou_c'],
        },
      };
      expect(request.type).toBe('addMembers');
      expect(request.payload.chatId).toBe('oc_xxx');
      expect(request.payload.memberIds).toHaveLength(3);
    });

    it('should type-check removeMembers request', () => {
      const request: IpcRequest<'removeMembers'> = {
        type: 'removeMembers',
        id: 'req-rm-1',
        payload: {
          chatId: 'oc_xxx',
          memberIds: ['ou_a'],
        },
      };
      expect(request.type).toBe('removeMembers');
      expect(request.payload.memberIds).toHaveLength(1);
    });

    it('should type-check listMembers request', () => {
      const request: IpcRequest<'listMembers'> = {
        type: 'listMembers',
        id: 'req-list-1',
        payload: {
          chatId: 'oc_xxx',
        },
      };
      expect(request.type).toBe('listMembers');
      expect(request.payload.chatId).toBe('oc_xxx');
    });

    it('should type-check listChats request', () => {
      const request: IpcRequest<'listChats'> = {
        type: 'listChats',
        id: 'req-chats-1',
        payload: {},
      };
      expect(request.type).toBe('listChats');
    });
  });

  describe('IpcResponse types', () => {
    it('should type-check addMembers response', () => {
      const response: IpcResponse<'addMembers'> = {
        id: 'req-add-1',
        success: true,
        payload: { success: true },
      };
      expect(response.success).toBe(true);
      expect(response.payload?.success).toBe(true);
    });

    it('should type-check removeMembers response', () => {
      const response: IpcResponse<'removeMembers'> = {
        id: 'req-rm-1',
        success: true,
        payload: { success: true },
      };
      expect(response.success).toBe(true);
    });

    it('should type-check listMembers response with data', () => {
      const response: IpcResponse<'listMembers'> = {
        id: 'req-list-1',
        success: true,
        payload: {
          success: true,
          memberIds: ['ou_a', 'ou_b'],
        },
      };
      expect(response.success).toBe(true);
      expect(response.payload?.memberIds).toHaveLength(2);
    });

    it('should type-check listChats response with data', () => {
      const response: IpcResponse<'listChats'> = {
        id: 'req-chats-1',
        success: true,
        payload: {
          success: true,
          chats: [
            { chatId: 'oc_1', name: 'Group A' },
            { chatId: 'oc_2', name: 'Group B' },
          ],
        },
      };
      expect(response.success).toBe(true);
      expect(response.payload?.chats).toHaveLength(2);
      expect(response.payload?.chats?.[0].name).toBe('Group A');
    });

    it('should type-check error responses for member management', () => {
      const addError: IpcResponse<'addMembers'> = {
        id: 'req-add-1',
        success: false,
        error: 'Not a group member',
      };
      expect(addError.success).toBe(false);
      expect(addError.error).toBe('Not a group member');
    });
  });
});
