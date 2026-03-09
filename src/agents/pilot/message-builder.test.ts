/**
 * Tests for MessageBuilder class.
 *
 * Issue #809: Tests for image analyzer MCP hint in buildAttachmentsInfo.
 * Issue #955: Tests for persisted history context in session restoration.
 * Issue #962: Tests for output format guidance to prevent raw JSON in responses.
 * Issue #1228: Tests for discussion focus maintenance.
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

  describe('buildEnhancedContent with discussionTopic (Issue #1228)', () => {
    it('should include discussion focus section when discussionTopic is provided', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'What do you think about this?',
        messageId: 'msg-123',
        discussionTopic: 'Should we migrate to TypeScript?',
      }, 'chat-123');

      expect(result).toContain('Discussion Focus');
      expect(result).toContain('Should we migrate to TypeScript?');
      expect(result).toContain('Stay on Topic');
      expect(result).toContain('Detect Drifting');
    });

    it('should include discussion context when provided', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'What do you think?',
        messageId: 'msg-123',
        discussionTopic: 'API Design',
        discussionContext: 'We are designing a new REST API for our microservices architecture.',
      }, 'chat-123');

      expect(result).toContain('Discussion Focus');
      expect(result).toContain('API Design');
      expect(result).toContain('We are designing a new REST API');
    });

    it('should not include discussion focus section when no discussionTopic', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-123');

      expect(result).not.toContain('Discussion Focus');
    });

    it('should not include discussion focus section for skill commands', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: '/reset',
        messageId: 'msg-123',
        discussionTopic: 'Some topic',
      }, 'chat-123');

      expect(result).not.toContain('Discussion Focus');
    });

    it('should include drift guidance with original topic', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
        discussionTopic: 'Database Migration',
      }, 'chat-123');

      expect(result).toContain('Let\'s get back to our main topic: Database Migration');
    });

    it('should include discussion focus with senderOpenId', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'I think we should go with PostgreSQL',
        messageId: 'msg-123',
        senderOpenId: 'user-456',
        discussionTopic: 'Database Selection',
      }, 'chat-123');

      expect(result).toContain('Discussion Focus');
      expect(result).toContain('Database Selection');
    });
  });
});
