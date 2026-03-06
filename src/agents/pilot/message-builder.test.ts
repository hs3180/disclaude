/**
 * Tests for MessageBuilder class.
 *
 * Issue #809: Tests for image analyzer MCP hint in buildAttachmentsInfo.
 * Issue #857: Tests for conditional complexity assessment guidance.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageBuilder } from './message-builder.js';

// Mock config
vi.mock('../../config/index.js', () => ({
  Config: {
    getMcpServersConfig: vi.fn(() => null),
  },
}));

describe('MessageBuilder', () => {
  let messageBuilder: MessageBuilder;

  beforeEach(() => {
    messageBuilder = new MessageBuilder();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('buildAttachmentsInfo (Issue #809)', () => {
    // Access private method for testing
    const getAttachmentsInfo = (mb: MessageBuilder, attachments?: unknown[]) =>
      (mb as unknown as { buildAttachmentsInfo: (a?: unknown[]) => string }).buildAttachmentsInfo(attachments);

    it('should include image analyzer hint for image attachments when MCP is configured', async () => {
      // Import Config to get access to the mocked version
      const { Config } = await import('../../config/index.js');
      vi.mocked(Config.getMcpServersConfig).mockReturnValueOnce({
        '4_5v_mcp': { command: 'test-command' },
      } as unknown as Record<string, unknown>);

      const imageAttachment = [{
        id: 'test-id',
        fileName: 'test.png',
        mimeType: 'image/png',
        size: 1024,
        localPath: '/tmp/test.png',
      }];

      const result = getAttachmentsInfo(new MessageBuilder(), imageAttachment);

      expect(result).toContain('Image attachment(s) detected');
      expect(result).toContain('analyze_image');
      expect(result).toContain('image analyzer MCP');
    });

    it('should not include image analyzer hint when no image analyzer MCP is configured', async () => {
      const { Config } = await import('../../config/index.js');
      vi.mocked(Config.getMcpServersConfig).mockReturnValueOnce(undefined as unknown as Record<string, unknown>);

      const imageAttachment = [{
        id: 'test-id',
        fileName: 'test.png',
        mimeType: 'image/png',
        size: 1024,
        localPath: '/tmp/test.png',
      }];

      const result = getAttachmentsInfo(new MessageBuilder(), imageAttachment);

      expect(result).not.toContain('Image attachment(s) detected');
      expect(result).not.toContain('analyze_image');
    });

    it('should not include image analyzer hint for non-image attachments', async () => {
      const { Config } = await import('../../config/index.js');
      vi.mocked(Config.getMcpServersConfig).mockReturnValueOnce({
        '4_5v_mcp': { command: 'test-command' },
      } as unknown as Record<string, unknown>);

      const textAttachment = [{
        id: 'test-id',
        fileName: 'test.txt',
        mimeType: 'text/plain',
        size: 1024,
        localPath: '/tmp/test.txt',
      }];

      const result = getAttachmentsInfo(new MessageBuilder(), textAttachment);

      expect(result).not.toContain('Image attachment(s) detected');
    });

    it('should return empty string for no attachments', () => {
      const result = getAttachmentsInfo(messageBuilder, []);
      expect(result).toBe('');
    });

    it('should return empty string for undefined attachments', () => {
      const result = getAttachmentsInfo(messageBuilder, undefined);
      expect(result).toBe('');
    });

    it('should detect various image analyzer MCP names', async () => {
      const { Config } = await import('../../config/index.js');
      const mcpNames = ['4_5v_mcp', 'glm-vision', 'image-analyzer', 'vision'];

      for (const name of mcpNames) {
        vi.mocked(Config.getMcpServersConfig).mockReturnValueOnce({
          [name]: { command: 'test-command' },
        } as unknown as Record<string, unknown>);

        const imageAttachment = [{
          id: 'test-id',
          fileName: 'test.jpg',
          mimeType: 'image/jpeg',
          size: 1024,
          localPath: '/tmp/test.jpg',
        }];

        const result = getAttachmentsInfo(new MessageBuilder(), imageAttachment);
        expect(result).toContain('analyze_image');
      }
    });
  });

  describe('buildEnhancedContent - Complexity Guidance (Issue #857)', () => {
    it('should include complexity guidance for complex-looking tasks', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: '请帮我重构整个认证模块，包括登录、注册和密码重置功能',
        messageId: 'test-msg-1',
        senderOpenId: 'test-user-1',
      }, 'test-chat-1');

      expect(result).toContain('Complex Task Handling');
      expect(result).toContain('refactoring');
    });

    it('should include complexity guidance for implementation tasks', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: '帮我实现一个新的用户管理功能，包括增删改查',
        messageId: 'test-msg-2',
        senderOpenId: 'test-user-1',
      }, 'test-chat-1');

      expect(result).toContain('Complex Task Handling');
    });

    it('should not include complexity guidance for simple queries', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: '你好',
        messageId: 'test-msg-3',
        senderOpenId: 'test-user-1',
      }, 'test-chat-1');

      expect(result).not.toContain('Complex Task Handling');
    });

    it('should not include complexity guidance for short messages', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: '你好，请帮我',
        messageId: 'test-msg-4',
        senderOpenId: 'test-user-1',
      }, 'test-chat-1');

      expect(result).not.toContain('Complex Task Handling');
    });

    it('should not include complexity guidance for skill commands', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: '/help refactor the authentication module',
        messageId: 'test-msg-5',
        senderOpenId: 'test-user-1',
      }, 'test-chat-1');

      expect(result).not.toContain('Complex Task Handling');
    });

    it('should detect Chinese keywords for complex tasks', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: '请帮我修改代码，实现新的功能模块，支持多种配置',
        messageId: 'test-msg-6',
        senderOpenId: 'test-user-1',
      }, 'test-chat-1');

      expect(result).toContain('Complex Task Handling');
    });

    it('should detect English keywords for complex tasks', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Please help me implement a new feature for user authentication',
        messageId: 'test-msg-7',
        senderOpenId: 'test-user-1',
      }, 'test-chat-1');

      expect(result).toContain('Complex Task Handling');
    });
  });
});
