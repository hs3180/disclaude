/**
 * Tests for MessageBuilder class.
 *
 * Issue #809: Tests for image analyzer MCP hint in buildAttachmentsInfo.
 * Issue #808: Tests for native multimodal guidance when no MCP is configured.
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
    vi.resetAllMocks();
  });

  describe('buildAttachmentsInfo (Issue #809, #808)', () => {
    // Access private method for testing
    const getAttachmentsInfo = (mb: MessageBuilder, attachments?: any[]) =>
      (mb as any).buildAttachmentsInfo(attachments);

    it('should include image analyzer hint for image attachments when MCP is configured', async () => {
      // Import Config to get access to the mocked version
      const { Config } = await import('../../config/index.js');
      vi.mocked(Config.getMcpServersConfig).mockReturnValue({
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

    it('should include native multimodal guidance when no image analyzer MCP is configured (Issue #808)', async () => {
      const { Config } = await import('../../config/index.js');
      vi.mocked(Config.getMcpServersConfig).mockReturnValue(undefined as any);

      const imageAttachment = [{
        id: 'test-id',
        fileName: 'screenshot.png',
        mimeType: 'image/png',
        size: 1024,
        localPath: '/tmp/screenshot.png',
      }];

      const result = getAttachmentsInfo(new MessageBuilder(), imageAttachment);

      // Issue #808: Should provide native multimodal guidance
      expect(result).toContain('Image attachment(s) detected');
      expect(result).toContain('Read tool');
      expect(result).toContain('Native multimodal models');
      expect(result).not.toContain('analyze_image');
      expect(result).not.toContain('image analyzer MCP');
    });

    it('should not include image guidance for non-image attachments', async () => {
      const { Config } = await import('../../config/index.js');
      vi.mocked(Config.getMcpServersConfig).mockReturnValue({
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

    it('should include image count in guidance for multiple images (Issue #808)', async () => {
      const { Config } = await import('../../config/index.js');
      vi.mocked(Config.getMcpServersConfig).mockReturnValue(undefined as any);

      const imageAttachments = [
        {
          id: 'test-id-1',
          fileName: 'photo1.jpg',
          mimeType: 'image/jpeg',
          size: 2048,
          localPath: '/tmp/photo1.jpg',
        },
        {
          id: 'test-id-2',
          fileName: 'photo2.png',
          mimeType: 'image/png',
          size: 3072,
          localPath: '/tmp/photo2.png',
        },
      ];

      const result = getAttachmentsInfo(new MessageBuilder(), imageAttachments);

      expect(result).toContain('Image attachment(s) detected (2)');
      expect(result).toContain('Native multimodal models');
    });

    it('should prefer analyze_image when MCP is available over native multimodal guidance', async () => {
      const { Config } = await import('../../config/index.js');
      vi.mocked(Config.getMcpServersConfig).mockReturnValue({
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

      // Should mention analyze_image first
      expect(result).toContain('analyze_image');
      expect(result).toContain('image analyzer MCP');
      // Should also mention Read tool as fallback
      expect(result).toContain('Read tool');
    });

    it('should return empty string for no attachments', async () => {
      const { Config } = await import('../../config/index.js');
      vi.mocked(Config.getMcpServersConfig).mockReturnValue(undefined as any);

      const result = getAttachmentsInfo(messageBuilder, []);
      expect(result).toBe('');
    });

    it('should return empty string for undefined attachments', async () => {
      const { Config } = await import('../../config/index.js');
      vi.mocked(Config.getMcpServersConfig).mockReturnValue(undefined as any);

      const result = getAttachmentsInfo(messageBuilder, undefined);
      expect(result).toBe('');
    });

    it('should detect various image analyzer MCP names', async () => {
      const { Config } = await import('../../config/index.js');
      const mcpNames = ['4_5v_mcp', 'glm-vision', 'image-analyzer', 'vision'];

      for (const name of mcpNames) {
        vi.mocked(Config.getMcpServersConfig).mockReturnValue({
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
});
