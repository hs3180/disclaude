/**
 * Tests for MessageBuilder class.
 *
 * Issue #809: Tests for image analyzer MCP hint in buildAttachmentsInfo.
 * Issue #808: Tests for native multimodal guidance when no MCP is configured.
 * Issue #955: Tests for persisted history context in session restoration.
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

  describe('buildEnhancedContent with persistedHistoryContext (Issue #955)', () => {
    it('should include persisted history section when provided', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
        persistedHistoryContext: 'Previous conversation content here...',
      }, 'chat-123');

      expect(result).toContain('Previous Session Context');
      expect(result).toContain('service was recently restarted');
      expect(result).toContain('Previous conversation content here...');
    });

    it('should not include persisted history section when not provided', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-123');

      expect(result).not.toContain('Previous Session Context');
    });

    it('should include both persisted history and chat history when both are provided', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
        persistedHistoryContext: 'Persisted history...',
        chatHistoryContext: 'Chat history from passive mode...',
      }, 'chat-123');

      expect(result).toContain('Previous Session Context');
      expect(result).toContain('Persisted history...');
      expect(result).toContain('Recent Chat History');
      expect(result).toContain('Chat history from passive mode...');
    });

    it('should not include persisted history for skill commands', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: '/reset',
        messageId: 'msg-123',
        persistedHistoryContext: 'Previous conversation...',
      }, 'chat-123');

      expect(result).not.toContain('Previous Session Context');
      expect(result).toContain('/reset');
    });
  });

  describe('buildAttachmentsInfo (Issue #809, #808)', () => {
    // Access private method for testing
    const getAttachmentsInfo = (mb: MessageBuilder, attachments?: any[]) =>
      (mb as any).buildAttachmentsInfo(attachments);

    describe('with image analyzer MCP configured (Issue #809)', () => {
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

      it('should show correct image count', async () => {
        const { Config } = await import('../../config/index.js');
        vi.mocked(Config.getMcpServersConfig).mockReturnValueOnce({
          '4_5v_mcp': { command: 'test-command' },
        } as any);

        const multipleImages = [
          { id: '1', fileName: 'a.png', mimeType: 'image/png', size: 100, localPath: '/tmp/a.png' },
          { id: '2', fileName: 'b.png', mimeType: 'image/png', size: 200, localPath: '/tmp/b.png' },
        ];

        const result = getAttachmentsInfo(new MessageBuilder(), multipleImages);
        expect(result).toContain('(2)');
      });
    });

    describe('without image analyzer MCP (Issue #808 - native multimodal)', () => {
      it('should provide native multimodal guidance when no MCP is configured', async () => {
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

        expect(result).toContain('Image attachment(s) detected');
        expect(result).toContain('Read tool');
        expect(result).toContain('Native multimodal');
        expect(result).not.toContain('analyze_image');
      });

      it('should show correct image count for native multimodal', async () => {
        const { Config } = await import('../../config/index.js');
        vi.mocked(Config.getMcpServersConfig).mockReturnValueOnce(undefined);

        const multipleImages = [
          { id: '1', fileName: 'a.png', mimeType: 'image/png', size: 100, localPath: '/tmp/a.png' },
          { id: '2', fileName: 'b.png', mimeType: 'image/png', size: 200, localPath: '/tmp/b.png' },
          { id: '3', fileName: 'c.png', mimeType: 'image/png', size: 300, localPath: '/tmp/c.png' },
        ];

        const result = getAttachmentsInfo(new MessageBuilder(), multipleImages);
        expect(result).toContain('(3)');
      });

      it('should support various image MIME types', async () => {
        const { Config } = await import('../../config/index.js');
        vi.mocked(Config.getMcpServersConfig).mockReturnValueOnce(undefined);

        const imageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];

        for (const mimeType of imageTypes) {
          const imageAttachment = [{
            id: 'test-id',
            fileName: `test.${mimeType.split('/')[1]}`,
            mimeType,
            size: 1024,
            localPath: '/tmp/test',
          }];

          const result = getAttachmentsInfo(new MessageBuilder(), imageAttachment);
          expect(result).toContain('Image attachment(s) detected');
          expect(result).toContain('Native multimodal');
        }
      });
    });

    describe('non-image attachments', () => {
      it('should not include image hint for non-image attachments', async () => {
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

      it('should handle mixed attachments (images + files)', async () => {
        const { Config } = await import('../../config/index.js');
        vi.mocked(Config.getMcpServersConfig).mockReturnValueOnce(undefined);

        const mixedAttachments = [
          { id: '1', fileName: 'doc.txt', mimeType: 'text/plain', size: 100, localPath: '/tmp/doc.txt' },
          { id: '2', fileName: 'img.png', mimeType: 'image/png', size: 200, localPath: '/tmp/img.png' },
        ];

        const result = getAttachmentsInfo(new MessageBuilder(), mixedAttachments);
        expect(result).toContain('Image attachment(s) detected');
        expect(result).toContain('(1)'); // Only 1 image
      });
    });

    describe('edge cases', () => {
      it('should return empty string for no attachments', () => {
        const result = getAttachmentsInfo(messageBuilder, []);
        expect(result).toBe('');
      });

      it('should return empty string for undefined attachments', () => {
        const result = getAttachmentsInfo(messageBuilder, undefined);
        expect(result).toBe('');
      });
    });
  });
});
