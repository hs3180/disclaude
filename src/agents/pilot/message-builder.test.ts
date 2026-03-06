/**
 * Tests for MessageBuilder class.
 *
 * Issue #809: Tests for image analyzer MCP hint in buildAttachmentsInfo.
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
});
