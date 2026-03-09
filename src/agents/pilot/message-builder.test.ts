/**
 * Tests for MessageBuilder class.
 *
 * Issue #809: Tests for image analyzer MCP hint in buildAttachmentsInfo.
 * Issue #955: Tests for persisted history context in session restoration.
 * Issue #962: Tests for output format guidance to prevent raw JSON in responses.
 * Issue #1267: Tests for custom skill guidance to proactively help users.
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

      // Issue #656: Enhanced image analysis prompt
      expect(result).toContain('Image Analysis Required');
      expect(result).toContain('mcp__4_5v_mcp__analyze_image');
      expect(result).toContain('MUST analyze the image content');
      expect(result).toContain('Analysis Workflow');
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

      // Should not contain enhanced image analysis prompt
      expect(result).not.toContain('Image Analysis Required');
      expect(result).not.toContain('mcp__4_5v_mcp__analyze_image');
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
        // Issue #656: Enhanced prompt includes image analysis workflow
        expect(result).toContain('Image Analysis Required');
      }
    });
  });

  describe('buildOutputFormatGuidance (Issue #962)', () => {
    it('should include output format guidance in regular messages', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-123');

      expect(result).toContain('Output Format Requirements');
      expect(result).toContain('Never output raw JSON');
    });

    it('should include correct and wrong format examples', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-123');

      expect(result).toContain('✅ Correct Format');
      expect(result).toContain('❌ Wrong Format');
    });

    it('should not include output format guidance for skill commands', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: '/reset',
        messageId: 'msg-123',
      }, 'chat-123');

      expect(result).not.toContain('Output Format Requirements');
    });

    it('should include guidance for converting JSON to readable format', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
        senderOpenId: 'user-123',
      }, 'chat-123');

      expect(result).toContain('Convert JSON objects to readable text');
      expect(result).toContain('Markdown tables instead of raw JSON');
    });
  });

  describe('buildSkillGuidance (Issue #1267)', () => {
    it('should include custom skill guidance in regular messages', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-123');

      expect(result).toContain('Custom Skill Guidance');
      expect(result).toContain('proactively guide');
    });

    it('should include trigger conditions for skill guidance', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-123');

      expect(result).toContain('external API integration');
      expect(result).toContain('automation or scheduled tasks');
      expect(result).toContain('scenario-specific or personalized');
    });

    it('should include guidance template', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-123');

      expect(result).toContain('这个需求可以通过创建自定义 Skill 来实现');
      expect(result).toContain('分析需求并设计 Skill 结构');
      expect(result).toContain('生成 Skill 代码模板');
    });

    it('should include example scenarios', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-123');

      expect(result).toContain('Website Monitoring');
      expect(result).toContain('Workflow Automation');
      expect(result).toContain('API Integration');
    });

    it('should not include skill guidance for skill commands', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: '/reset',
        messageId: 'msg-123',
      }, 'chat-123');

      expect(result).not.toContain('Custom Skill Guidance');
    });

    it('should include correct and wrong response examples', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
        senderOpenId: 'user-123',
      }, 'chat-123');

      expect(result).toContain('❌ Wrong:');
      expect(result).toContain('✅ Correct:');
      expect(result).toContain('我不支持这个功能');
      expect(result).toContain('自定义 Skill 实现');
    });
  });
});
