/**
 * Tests for MessageBuilder class.
 *
 * Issue #809: Tests for image analyzer MCP hint in buildAttachmentsInfo.
 * Issue #893: Tests for next-step guidance section.
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
    const getAttachmentsInfo = (mb: MessageBuilder, attachments?: any[]) =>
      (mb as any).buildAttachmentsInfo(attachments);

    it('should include image analyzer hint for image attachments when MCP is configured', async () => {
      // Import Config to get access to the mocked version
      const { Config } = await import('../../config/index.js');
      vi.mocked(Config.getMcpServersConfig).mockReturnValueOnce({
        '4_5v_mcp': { command: 'test-command' },
      } as any);

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
      vi.mocked(Config.getMcpServersConfig).mockReturnValueOnce(undefined as any);

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
      } as any);

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
        } as any);

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

  describe('buildNextStepGuidance (Issue #893)', () => {
    it('should include next-step guidance in enhanced content by default', () => {
      const msg = {
        text: 'Hello',
        messageId: 'msg-123',
      };
      const chatId = 'oc_test';

      const result = messageBuilder.buildEnhancedContent(msg, chatId);

      expect(result).toContain('Next Steps After Task Completion');
      expect(result).toContain('proactively suggest');
    });

    it('should include interactive card format when cards are supported', () => {
      const msg = {
        text: 'Hello',
        messageId: 'msg-123',
      };
      const chatId = 'oc_test';
      const capabilities = {
        supportsCard: true,
      };

      const result = messageBuilder.buildEnhancedContent(msg, chatId, capabilities);

      expect(result).toContain('Interactive Card Format');
      expect(result).toContain('接下来您可以...');
    });

    it('should not include interactive card format when cards are not supported', () => {
      const msg = {
        text: 'Hello',
        messageId: 'msg-123',
      };
      const chatId = 'oc_test';
      const capabilities = {
        supportsCard: false,
      };

      const result = messageBuilder.buildEnhancedContent(msg, chatId, capabilities);

      expect(result).toContain('Next Steps After Task Completion');
      expect(result).not.toContain('Interactive Card Format');
    });

    it('should not include next-step guidance when disabled', () => {
      const builder = new MessageBuilder({ enabled: false });
      const msg = {
        text: 'Hello',
        messageId: 'msg-123',
      };
      const chatId = 'oc_test';

      const result = builder.buildEnhancedContent(msg, chatId);

      expect(result).not.toContain('Next Steps After Task Completion');
    });

    it('should not include interactive card format when suggestInteractiveCards is false', () => {
      const builder = new MessageBuilder({ suggestInteractiveCards: false });
      const msg = {
        text: 'Hello',
        messageId: 'msg-123',
      };
      const chatId = 'oc_test';
      const capabilities = {
        supportsCard: true,
      };

      const result = builder.buildEnhancedContent(msg, chatId, capabilities);

      expect(result).toContain('Next Steps After Task Completion');
      expect(result).not.toContain('Interactive Card Format');
    });

    it('should not include next-step guidance for skill commands', () => {
      const msg = {
        text: '/help',
        messageId: 'msg-123',
        senderOpenId: 'user-123',
      };
      const chatId = 'oc_test';

      const result = messageBuilder.buildEnhancedContent(msg, chatId);

      // Skill commands should not have next-step guidance
      expect(result).not.toContain('Next Steps After Task Completion');
    });
  });
});
