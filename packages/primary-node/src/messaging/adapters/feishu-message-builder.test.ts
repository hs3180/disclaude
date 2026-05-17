/**
 * Tests for Feishu-specific channel sections with MessageBuilder.
 *
 * Issue #1492: Tests for Feishu-specific channel sections used with
 * the core MessageBuilder.
 * Issue #1499: Moved from @disclaude/worker-node to @disclaude/primary-node.
 *
 * Issue #3679: Updated buildAttachmentExtra tests — removed MCP tool guidance.
 * Issue #955: Tests for persisted history context in session restoration.
 * Issue #962: Tests for output format guidance to prevent raw JSON in responses.
 */

 

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageBuilder, DEFAULT_CHANNEL_CAPABILITIES, type MessageData, type ChannelCapabilities } from '@disclaude/core';
import { createFeishuMessageBuilderOptions } from './feishu-message-builder.js';

/** Helper to create capabilities with specific supportedMcpTools */
const withTools = (tools: string[]): ChannelCapabilities => ({
  ...DEFAULT_CHANNEL_CAPABILITIES,
  supportedMcpTools: tools,
});


describe('MessageBuilder with Feishu sections', () => {
  let messageBuilder: MessageBuilder;

  beforeEach(() => {
    messageBuilder = new MessageBuilder(createFeishuMessageBuilderOptions());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('buildEnhancedContent with Feishu header', () => {
    it('should include Feishu platform header', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-123');

      expect(result).toContain('You are responding in a Feishu chat.');
    });
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

  describe('buildAttachmentExtra - image attachment info (Issue #3679)', () => {
    it('should include image attachment info for image attachments', () => {
      const imageAttachment = [{
        id: 'test-id',
        fileName: 'test.png',
        mimeType: 'image/png',
        size: 1024,
        localPath: '/tmp/test.png',
        source: 'user' as const,
        createdAt: Date.now(),
      }];

      const builder = new MessageBuilder(createFeishuMessageBuilderOptions());
      const result = builder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
        attachments: imageAttachment,
      } as MessageData, 'chat-123');

      // Issue #3679: Simple image attachment info, no MCP tool guidance
      expect(result).toContain('Image Attachments');
      expect(result).toContain('test.png');
      expect(result).toContain('/tmp/test.png');
      expect(result).toContain('Read tool');
      // Should NOT contain old MCP tool guidance
      expect(result).not.toContain('mcp__4_5v_mcp__analyze_image');
      expect(result).not.toContain('MUST analyze the image content');
      expect(result).not.toContain('Analysis Workflow');
    });

    it('should list multiple image attachments', () => {
      const imageAttachments = [
        {
          id: 'id-1',
          fileName: 'photo1.jpg',
          mimeType: 'image/jpeg',
          size: 2048,
          localPath: '/tmp/photo1.jpg',
          source: 'user' as const,
          createdAt: Date.now(),
        },
        {
          id: 'id-2',
          fileName: 'photo2.png',
          mimeType: 'image/png',
          size: 3072,
          localPath: '/tmp/photo2.png',
          source: 'user' as const,
          createdAt: Date.now(),
        },
      ];

      const builder = new MessageBuilder(createFeishuMessageBuilderOptions());
      const result = builder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
        attachments: imageAttachments,
      } as MessageData, 'chat-123');

      expect(result).toContain('2 images');
      expect(result).toContain('photo1.jpg');
      expect(result).toContain('photo2.png');
    });

    it('should not include image info for non-image attachments', () => {
      const textAttachment = [{
        id: 'test-id',
        fileName: 'test.txt',
        mimeType: 'text/plain',
        size: 1024,
        localPath: '/tmp/test.txt',
        source: 'user' as const,
        createdAt: Date.now(),
      }];

      const builder = new MessageBuilder(createFeishuMessageBuilderOptions());
      const result = builder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
        attachments: textAttachment,
      } as MessageData, 'chat-123');

      expect(result).not.toContain('Image Attachments');
    });

    it('should not include image info when no attachments', () => {
      const builder = new MessageBuilder(createFeishuMessageBuilderOptions());
      const result = builder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-123');

      expect(result).not.toContain('Image Attachments');
    });
  });

  describe('buildToolsSection - Feishu MCP tool names', () => {
    it('should include full MCP tool name mcp__channel-mcp__send_text', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-123', withTools(['send_text']));

      expect(result).toContain('mcp__channel-mcp__send_text');
      expect(result).toContain('chat-123');
    });

    it('should include send_card when available', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-123', withTools(['send_text', 'send_card']));

      expect(result).toContain('mcp__channel-mcp__send_card');
    });

    it('should include send_interactive when available', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-123', withTools(['send_text', 'send_interactive']));

      expect(result).toContain('mcp__channel-mcp__send_interactive');
    });

    it('should include IMPORTANT warning to use correct tool', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-123', withTools(['send_text']));

      expect(result).toContain('**IMPORTANT**');
      expect(result).toContain('Do NOT use any other MCP server');
    });

    it('should include mcp__channel-mcp__send_file when available', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-123', withTools(['send_text', 'send_file']));

      expect(result).toContain('mcp__channel-mcp__send_file');
    });

    it('should not include send_file when not in supportedMcpTools', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-123', withTools(['send_text']));

      expect(result).toContain('send_file is NOT supported');
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
  });

  describe('Feishu @ mention section', () => {
    it('should include mention section when senderOpenId is provided', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
        senderOpenId: 'user-456',
      }, 'chat-123');

      expect(result).toContain('@ Mention the User');
      expect(result).toContain('user-456');
    });

    it('should not include mention section when senderOpenId is not provided', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-123');

      expect(result).not.toContain('@ Mention the User');
    });

    it('should not include mention section when supportsMention is false', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
        senderOpenId: 'user-456',
      }, 'chat-123', { ...DEFAULT_CHANNEL_CAPABILITIES, supportsMention: false });

      expect(result).not.toContain('@ Mention the User');
    });
  });
});
