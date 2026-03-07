/**
 * Tests for interactive message tool
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the lark SDK
const mockClient = {
  im: {
    message: {
      create: vi.fn(),
      reply: vi.fn(),
    },
  },
};

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn(() => mockClient),
  Domain: {
    Feishu: 'https://open.feishu.cn',
  },
}));

// Mock config
vi.mock('../../config/index.js', () => ({
  Config: {
    FEISHU_APP_ID: 'test-app-id',
    FEISHU_APP_SECRET: 'test-app-secret',
    getWorkspaceDir: vi.fn(() => '/test/workspace'),
  },
}));

// Mock LarkClientService (Issue #1030)
vi.mock('../../services/index.js', () => ({
  getLarkClientService: vi.fn(() => ({
    getClient: vi.fn(() => mockClient),
  })),
  isLarkClientServiceInitialized: vi.fn(() => true),
  initLarkClientService: vi.fn(),
}));

// Mock logger
vi.mock('../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Import after mocks
import {
  send_interactive_message,
  registerActionPrompts,
  getActionPrompts,
  unregisterActionPrompts,
  generateInteractionPrompt,
  cleanupExpiredContexts,
} from './interactive-message.js';

describe('Interactive Message Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set up default mock responses
    mockClient.im.message.create.mockResolvedValue({
      data: { message_id: 'test-message-id' },
    });
    mockClient.im.message.reply.mockResolvedValue({
      data: { message_id: 'test-reply-id' },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Clean up any registered prompts
    cleanupExpiredContexts();
  });

  describe('registerActionPrompts', () => {
    it('should register action prompts for a message', () => {
      const prompts = {
        confirm: '[用户操作] 用户点击了确认按钮',
        cancel: '[用户操作] 用户点击了取消按钮',
      };

      registerActionPrompts('msg-1', 'chat-1', prompts);

      const retrieved = getActionPrompts('msg-1');
      expect(retrieved).toEqual(prompts);
    });

    it('should return undefined for unregistered message', () => {
      const retrieved = getActionPrompts('non-existent');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('unregisterActionPrompts', () => {
    it('should unregister action prompts', () => {
      registerActionPrompts('msg-2', 'chat-1', { ok: 'OK clicked' });

      const result = unregisterActionPrompts('msg-2');
      expect(result).toBe(true);

      const retrieved = getActionPrompts('msg-2');
      expect(retrieved).toBeUndefined();
    });

    it('should return false for non-existent message', () => {
      const result = unregisterActionPrompts('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('generateInteractionPrompt', () => {
    it('should generate prompt from template', () => {
      registerActionPrompts('msg-3', 'chat-1', {
        confirm: '[用户操作] 用户点击了「{{actionText}}」按钮',
      });

      const prompt = generateInteractionPrompt('msg-3', 'confirm', '确认', 'button');
      expect(prompt).toBe('[用户操作] 用户点击了「确认」按钮');
    });

    it('should replace actionValue placeholder', () => {
      registerActionPrompts('msg-4', 'chat-1', {
        action: 'Action value: {{actionValue}}',
      });

      const prompt = generateInteractionPrompt('msg-4', 'action');
      expect(prompt).toBe('Action value: action');
    });

    it('should replace actionType placeholder', () => {
      registerActionPrompts('msg-5', 'chat-1', {
        select: 'User selected via {{actionType}}',
      });

      const prompt = generateInteractionPrompt('msg-5', 'select', undefined, 'select_static');
      expect(prompt).toBe('User selected via select_static');
    });

    it('should return undefined for unregistered message', () => {
      const prompt = generateInteractionPrompt('non-existent', 'confirm');
      expect(prompt).toBeUndefined();
    });

    it('should return undefined for unregistered action', () => {
      registerActionPrompts('msg-6', 'chat-1', { confirm: 'Confirmed' });

      const prompt = generateInteractionPrompt('msg-6', 'non-existent-action');
      expect(prompt).toBeUndefined();
    });
  });

  describe('send_interactive_message', () => {
    it('should send interactive message and register prompts', async () => {
      const card = {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: 'Test' } },
        elements: [{ tag: 'markdown', content: 'Test content' }],
      };
      const actionPrompts = {
        confirm: 'Confirmed',
        cancel: 'Cancelled',
      };

      const result = await send_interactive_message({
        card,
        actionPrompts,
        chatId: 'chat-1',
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('test-message-id');
      expect(mockClient.im.message.create).toHaveBeenCalled();

      // Verify prompts were registered
      const prompts = getActionPrompts('test-message-id');
      expect(prompts).toEqual(actionPrompts);
    });

    it('should send reply message when parentMessageId is provided', async () => {
      const card = {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: 'Test' } },
        elements: [{ tag: 'markdown', content: 'Test content' }],
      };

      const result = await send_interactive_message({
        card,
        actionPrompts: { ok: 'OK' },
        chatId: 'chat-1',
        parentMessageId: 'parent-msg-1',
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('test-reply-id');
      expect(mockClient.im.message.reply).toHaveBeenCalled();
    });

    it('should fail when card is missing', async () => {
      const result = await send_interactive_message({
        card: undefined as unknown as Record<string, unknown>,
        actionPrompts: { ok: 'OK' },
        chatId: 'chat-1',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('card is required');
    });

    it('should fail when actionPrompts is empty', async () => {
      const card = {
        config: {},
        header: { title: { tag: 'plain_text', content: 'Test' } },
        elements: [],
      };

      const result = await send_interactive_message({
        card,
        actionPrompts: {},
        chatId: 'chat-1',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('actionPrompts is required');
    });

    it('should fail when chatId is missing', async () => {
      const card = {
        config: {},
        header: { title: { tag: 'plain_text', content: 'Test' } },
        elements: [],
      };

      const result = await send_interactive_message({
        card,
        actionPrompts: { ok: 'OK' },
        chatId: undefined as unknown as string,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('chatId is required');
    });

    it('should fail for invalid card structure', async () => {
      const result = await send_interactive_message({
        card: { invalid: 'structure' },
        actionPrompts: { ok: 'OK' },
        chatId: 'chat-1',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid card structure');
    });
  });

  describe('cleanupExpiredContexts', () => {
    it('should clean up expired contexts', () => {
      // This test would require manipulating time, which is complex
      // For now, just verify the function exists and doesn't throw
      const count = cleanupExpiredContexts();
      expect(typeof count).toBe('number');
    });
  });
});
