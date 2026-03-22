/**
 * Tests for IPC protocol and handler with feishuCreateGroup support.
 *
 * Issue #946: Verify that the feishuCreateGroup IPC route works correctly.
 *
 * @module core/ipc/protocol.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createInteractiveMessageHandler } from './unix-socket-server.js';
import type { InteractiveMessageHandlers, FeishuHandlersContainer } from './unix-socket-server.js';

describe('IPC feishuCreateGroup (Issue #946)', () => {
  const mockInteractiveHandlers: InteractiveMessageHandlers = {
    getActionPrompts: vi.fn(),
    registerActionPrompts: vi.fn(),
    unregisterActionPrompts: vi.fn().mockReturnValue(true),
    generateInteractionPrompt: vi.fn(),
    cleanupExpiredContexts: vi.fn().mockReturnValue(0),
  };

  let feishuHandlersContainer: FeishuHandlersContainer;
  let handler: ReturnType<typeof createInteractiveMessageHandler>;

  beforeEach(() => {
    feishuHandlersContainer = { handlers: undefined };
  });

  describe('when createGroup handler is not registered', () => {
    beforeEach(() => {
      feishuHandlersContainer.handlers = {
        sendMessage: vi.fn(),
        sendCard: vi.fn(),
        uploadFile: vi.fn().mockResolvedValue({ fileKey: '', fileType: '', fileName: '', fileSize: 0 }),
        getBotInfo: vi.fn().mockResolvedValue({ openId: 'test' }),
        // createGroup is NOT provided
      };
      handler = createInteractiveMessageHandler(mockInteractiveHandlers, feishuHandlersContainer);
    });

    it('should return error when createGroup handler is missing', async () => {
      const response = await handler({
        type: 'feishuCreateGroup',
        id: 'test-1',
        payload: { groupName: 'Test Group' },
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain('createGroup handler not registered');
    });
  });

  describe('when createGroup handler is registered', () => {
    let createGroupFn: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      createGroupFn = vi.fn().mockResolvedValue({
        chatId: 'oc_new_group_123',
        chatName: '代码审核 - PR #456',
      });
      feishuHandlersContainer.handlers = {
        sendMessage: vi.fn(),
        sendCard: vi.fn(),
        uploadFile: vi.fn().mockResolvedValue({ fileKey: '', fileType: '', fileName: '', fileSize: 0 }),
        getBotInfo: vi.fn().mockResolvedValue({ openId: 'test' }),
        createGroup: createGroupFn,
      };
      handler = createInteractiveMessageHandler(mockInteractiveHandlers, feishuHandlersContainer);
    });

    it('should create group successfully', async () => {
      const response = await handler({
        type: 'feishuCreateGroup',
        id: 'test-2',
        payload: { groupName: '代码审核 - PR #456', members: ['ou_user1'] },
      });

      expect(response.success).toBe(true);
      expect(response.payload).toEqual({
        success: true,
        chatId: 'oc_new_group_123',
        chatName: '代码审核 - PR #456',
      });
      expect(createGroupFn).toHaveBeenCalledWith({
        groupName: '代码审核 - PR #456',
        members: ['ou_user1'],
      });
    });

    it('should create group without optional parameters', async () => {
      const response = await handler({
        type: 'feishuCreateGroup',
        id: 'test-3',
        payload: {},
      });

      expect(response.success).toBe(true);
      expect(createGroupFn).toHaveBeenCalledWith({
        groupName: undefined,
        members: undefined,
      });
    });

    it('should return error when createGroup throws', async () => {
      createGroupFn.mockRejectedValue(new Error('Feishu API error: rate limited'));

      const response = await handler({
        type: 'feishuCreateGroup',
        id: 'test-4',
        payload: { groupName: 'Test' },
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain('rate limited');
    });
  });

  describe('when feishu handlers are not available', () => {
    beforeEach(() => {
      handler = createInteractiveMessageHandler(mockInteractiveHandlers, feishuHandlersContainer);
    });

    it('should return error when feishu handlers are not registered', async () => {
      const response = await handler({
        type: 'feishuCreateGroup',
        id: 'test-5',
        payload: {},
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain('Feishu API handlers not available');
    });
  });
});
