/**
 * Tests for MessageBuilder class.
 *
 * Issue #809: Tests for image analyzer MCP hint in buildAttachmentsInfo.
 * Issue #955: Tests for persisted history context in session restoration.
 * Issue #962: Tests for output format guidance to prevent raw JSON in responses.
 * Issue #1229: Tests for discussion conclusion guidance.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageBuilder } from './message-builder.js';

// Mock config
vi.mock('../../config/index.js', () => ({
  Config: {
    getMcpServersConfig: vi.fn(() => null),
  },
}));

// Mock group-service (Issue #1229)
const mockGetDiscussion = vi.fn();
vi.mock('../../platforms/feishu/group-service.js', () => ({
  getGroupService: () => ({
    getDiscussion: mockGetDiscussion,
  }),
}));

describe('MessageBuilder', () => {
  let messageBuilder: MessageBuilder;

  beforeEach(() => {
    messageBuilder = new MessageBuilder();
    mockGetDiscussion.mockReset();
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

  describe('buildDiscussionGuidance (Issue #1229)', () => {
    // Access private method for testing
    const getDiscussionGuidance = (mb: MessageBuilder, chatId: string) =>
      (mb as any).buildDiscussionGuidance(chatId);

    it('should return empty string for non-discussion group', () => {
      mockGetDiscussion.mockReturnValue(undefined);

      const result = getDiscussionGuidance(messageBuilder, 'chat-no-discussion');

      expect(result).toBe('');
    });

    it('should return empty string for concluded discussion', () => {
      mockGetDiscussion.mockReturnValue({
        topic: 'Test Topic',
        status: 'concluded',
      });

      const result = getDiscussionGuidance(messageBuilder, 'chat-concluded');

      expect(result).toBe('');
    });

    it('should include discussion guidance for active discussion', () => {
      mockGetDiscussion.mockReturnValue({
        topic: 'Should we use TypeScript?',
        context: 'We are considering migrating our codebase.',
        timeout: 30,
        status: 'active',
      });

      const result = getDiscussionGuidance(messageBuilder, 'chat-active-discussion');

      expect(result).toContain('Discussion Mode');
      expect(result).toContain('Should we use TypeScript?');
      expect(result).toContain('We are considering migrating our codebase.');
      expect(result).toContain('conclude_discussion');
      expect(result).toContain('continue_discussion');
      expect(result).toContain('[DISCUSSION_CONCLUDE]');
      expect(result).toContain('[DISCUSSION_CONTINUE]');
    });

    it('should include chatId in the interactive card example', () => {
      mockGetDiscussion.mockReturnValue({
        topic: 'Test Topic',
        status: 'active',
      });

      const result = getDiscussionGuidance(messageBuilder, 'oc_test_chat_id');

      expect(result).toContain('"chatId": "oc_test_chat_id"');
    });
  });
});
