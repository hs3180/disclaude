/**
 * Tests for MessageBuilder class.
 *
 * Issue #1492: Tests for the core MessageBuilder extracted from worker-node.
 * Tests framework-agnostic behavior without channel-specific extensions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageBuilder, DEFAULT_CHANNEL_CAPABILITIES } from '../../index.js';
import type { MessageBuilderOptions } from './types.js';

describe('MessageBuilder', () => {
  let messageBuilder: MessageBuilder;

  beforeEach(() => {
    messageBuilder = new MessageBuilder();
  });

  describe('buildEnhancedContent - basic structure', () => {
    it('should include chat ID and message ID in output', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-456');

      expect(result).toContain('chat-456');
      expect(result).toContain('msg-123');
    });

    it('should include sender open ID when provided', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
        senderOpenId: 'user-789',
      }, 'chat-456');

      expect(result).toContain('user-789');
    });

    it('should not include sender open ID when not provided', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-456');

      expect(result).not.toContain('Sender Open ID');
    });

    it('should include user message text', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'What is the weather today?',
        messageId: 'msg-123',
      }, 'chat-456');

      expect(result).toContain('What is the weather today?');
    });
  });

  describe('buildEnhancedContent - guidance sections', () => {
    it('should include next-step guidance for regular messages', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-456');

      expect(result).toContain('Next Steps After Response');
    });

    it('should include output format guidance for regular messages', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-456');

      expect(result).toContain('Output Format Requirements');
      expect(result).toContain('Never output raw JSON');
    });

    it('should include location awareness guidance for regular messages', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-456');

      expect(result).toContain('Location Awareness');
    });

    it('should not include guidance sections for skill commands', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: '/reset',
        messageId: 'msg-123',
      }, 'chat-456');

      expect(result).not.toContain('Next Steps After Response');
      expect(result).not.toContain('Output Format Requirements');
      expect(result).not.toContain('Location Awareness');
    });
  });

  describe('buildEnhancedContent - skill commands', () => {
    it('should return skill command text with minimal context', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: '/reset',
        messageId: 'msg-123',
      }, 'chat-456');

      expect(result).toContain('/reset');
      expect(result).toContain('chat-456');
      expect(result).toContain('msg-123');
    });

    it('should not include history sections for skill commands', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: '/reset',
        messageId: 'msg-123',
        chatHistoryContext: 'Some history',
        persistedHistoryContext: 'Some persisted history',
      }, 'chat-456');

      expect(result).not.toContain('Recent Chat History');
      expect(result).not.toContain('Previous Session Context');
    });

    it('should handle skill commands with spaces', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: '  /command arg1 arg2',
        messageId: 'msg-123',
      }, 'chat-456');

      expect(result).toContain('/command arg1 arg2');
      expect(result).not.toContain('Output Format Requirements');
    });
  });

  describe('buildEnhancedContent - history sections', () => {
    it('should include chat history section when provided', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
        chatHistoryContext: 'Previous conversation here...',
      }, 'chat-456');

      expect(result).toContain('Recent Chat History');
      expect(result).toContain('Previous conversation here...');
    });

    it('should not include chat history section when not provided', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-456');

      expect(result).not.toContain('Recent Chat History');
    });

    it('should include persisted history section when provided', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
        persistedHistoryContext: 'Previous session content...',
      }, 'chat-456');

      expect(result).toContain('Previous Session Context');
      expect(result).toContain('Previous session content...');
    });

    it('should not include persisted history section when not provided', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-456');

      expect(result).not.toContain('Previous Session Context');
    });

    it('should include both history sections when both are provided', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
        persistedHistoryContext: 'Persisted history...',
        chatHistoryContext: 'Chat history...',
      }, 'chat-456');

      expect(result).toContain('Previous Session Context');
      expect(result).toContain('Persisted history...');
      expect(result).toContain('Recent Chat History');
      expect(result).toContain('Chat history...');
    });

    it('should not include persisted history for skill commands', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: '/reset',
        messageId: 'msg-123',
        persistedHistoryContext: 'Previous conversation...',
      }, 'chat-456');

      expect(result).not.toContain('Previous Session Context');
      expect(result).toContain('/reset');
    });
  });

  describe('buildEnhancedContent - attachments', () => {
    it('should include attachment info when attachments are provided', () => {
      const attachments = [{
        id: 'att-1',
        fileName: 'test.png',
        mimeType: 'image/png',
        size: 1024,
        localPath: '/tmp/test.png',
        source: 'user' as const,
        createdAt: Date.now(),
      }];

      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
        attachments,
      }, 'chat-456');

      expect(result).toContain('Attachments');
      expect(result).toContain('test.png');
      expect(result).toContain('/tmp/test.png');
      expect(result).toContain('image/png');
      expect(result).toContain('1.0 KB');
    });

    it('should not include attachment section when no attachments', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-456');

      expect(result).not.toContain('Attachments');
    });

    it('should handle multiple attachments', () => {
      const attachments = [
        {
          id: 'att-1',
          fileName: 'file1.txt',
          mimeType: 'text/plain',
          size: 512,
          localPath: '/tmp/file1.txt',
          source: 'user' as const,
          createdAt: Date.now(),
        },
        {
          id: 'att-2',
          fileName: 'file2.pdf',
          mimeType: 'application/pdf',
          size: 2048000,
          localPath: '/tmp/file2.pdf',
          source: 'user' as const,
          createdAt: Date.now(),
        },
      ];

      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
        attachments,
      }, 'chat-456');

      expect(result).toContain('2 file(s)');
      expect(result).toContain('file1.txt');
      expect(result).toContain('file2.pdf');
    });

    it('should handle attachments without size', () => {
      const attachments = [{
        id: 'att-1',
        fileName: 'test.png',
        localPath: '/tmp/test.png',
        source: 'user' as const,
        createdAt: Date.now(),
      }];

      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
        attachments,
      }, 'chat-456');

      expect(result).toContain('test.png');
      expect(result).not.toContain('KB');
    });

    it('should include attachments for skill commands', () => {
      const attachments = [{
        id: 'att-1',
        fileName: 'data.csv',
        mimeType: 'text/csv',
        size: 2048,
        localPath: '/tmp/data.csv',
        source: 'user' as const,
        createdAt: Date.now(),
      }];

      const result = messageBuilder.buildEnhancedContent({
        text: '/analyze',
        messageId: 'msg-123',
        attachments,
      }, 'chat-456');

      expect(result).toContain('data.csv');
    });
  });

  describe('buildEnhancedContent - channel extensions', () => {
    it('should include channel header when buildHeader is provided', () => {
      const options: MessageBuilderOptions = {
        buildHeader: () => 'You are responding in a Test Chat.',
      };
      const builder = new MessageBuilder(options);

      const result = builder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-456');

      expect(result).toContain('You are responding in a Test Chat.');
    });

    it('should include post-history content when buildPostHistory is provided', () => {
      const options: MessageBuilderOptions = {
        buildPostHistory: () => '## Custom Section\nCustom content here.',
      };
      const builder = new MessageBuilder(options);

      const result = builder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-456');

      expect(result).toContain('Custom Section');
      expect(result).toContain('Custom content here.');
    });

    it('should not include tools section when buildToolsSection is not provided', () => {
      const options: MessageBuilderOptions = {};
      const builder = new MessageBuilder(options);

      const result = builder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-456');

      expect(result).not.toContain('## Tools');
    });

    it('should not include tools section when buildToolsSection returns empty string', () => {
      const options: MessageBuilderOptions = {
        buildToolsSection: () => '',
      };
      const builder = new MessageBuilder(options);

      const result = builder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-456');

      expect(result).not.toContain('## Tools');
    });

    it('should include tools section when buildToolsSection is provided', () => {
      const options: MessageBuilderOptions = {
        buildToolsSection: () => '- Custom tool: `custom_tool`',
      };
      const builder = new MessageBuilder(options);

      const result = builder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-456');

      expect(result).toContain('## Tools');
      expect(result).toContain('custom_tool');
    });

    it('should include attachment extra when buildAttachmentExtra is provided', () => {
      const options: MessageBuilderOptions = {
        buildAttachmentExtra: () => '\n\n## Custom Image Hint\nAnalyze this image!',
      };
      const builder = new MessageBuilder(options);

      const result = builder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
        attachments: [{
          id: 'att-1',
          fileName: 'test.png',
          mimeType: 'image/png',
          localPath: '/tmp/test.png',
          source: 'user' as const,
          createdAt: Date.now(),
        }],
      }, 'chat-456');

      expect(result).toContain('Custom Image Hint');
    });

    it('should not include attachment extra when no attachments', () => {
      const buildAttachmentExtra = vi.fn(() => '\n## Extra');
      const options: MessageBuilderOptions = { buildAttachmentExtra };
      const builder = new MessageBuilder(options);

      builder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-456');

      // buildAttachmentExtra should still be called (it decides what to return)
      expect(buildAttachmentExtra).toHaveBeenCalled();
    });

    it('should include skill command extra when buildSkillCommandExtra is provided', () => {
      const options: MessageBuilderOptions = {
        buildSkillCommandExtra: () => '\n\nSkill execution context...',
      };
      const builder = new MessageBuilder(options);

      const result = builder.buildEnhancedContent({
        text: '/command',
        messageId: 'msg-123',
      }, 'chat-456');

      expect(result).toContain('Skill execution context...');
    });

    it('should pass correct context to channel callbacks', () => {
      const buildHeader = vi.fn((_ctx) => 'Header');
      const buildPostHistory = vi.fn((_ctx) => 'PostHistory');
      const buildToolsSection = vi.fn((_ctx) => 'Tools');
      const options: MessageBuilderOptions = {
        buildHeader,
        buildPostHistory,
        buildToolsSection,
      };
      const builder = new MessageBuilder(options);

      builder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
        senderOpenId: 'user-789',
      }, 'chat-456', { ...DEFAULT_CHANNEL_CAPABILITIES, supportsCard: true });

      // All callbacks should be called
      expect(buildHeader).toHaveBeenCalled();
      expect(buildPostHistory).toHaveBeenCalled();
      expect(buildToolsSection).toHaveBeenCalled();

      // Verify context passed to callbacks
      // eslint-disable-next-line prefer-destructuring
      const [ctx] = buildHeader.mock.calls[0];
      expect(ctx.chatId).toBe('chat-456');
      expect(ctx.msg.text).toBe('Hello');
      expect(ctx.msg.senderOpenId).toBe('user-789');
      expect(ctx.isSkillCommand).toBe(false);
      expect(ctx.capabilities?.supportsCard).toBe(true);
    });

    it('should correctly identify skill commands in context', () => {
      const buildSkillCommandExtra = vi.fn((_ctx) => 'SkillExtra');
      const options: MessageBuilderOptions = { buildSkillCommandExtra };
      const builder = new MessageBuilder(options);

      builder.buildEnhancedContent({
        text: '/skill command',
        messageId: 'msg-123',
      }, 'chat-456');

      expect(buildSkillCommandExtra.mock.calls[0][0].isSkillCommand).toBe(true);
      expect(buildSkillCommandExtra.mock.calls[0][0].chatId).toBe('chat-456');
    });

    it('should use next-step fallback when channel does not support cards', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-456', { ...DEFAULT_CHANNEL_CAPABILITIES, supportsCard: false });

      expect(result).toContain('Next Steps After Response');
      expect(result).not.toContain('actionPrompts');
    });
  });

  describe('buildEnhancedContent - output ordering', () => {
    it('should place user message after guidance sections', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'My question here',
        messageId: 'msg-123',
      }, 'chat-456');

      const outputFormatIdx = result.indexOf('Output Format Requirements');
      const userMessageIdx = result.indexOf('--- User Message ---');
      expect(userMessageIdx).toBeGreaterThan(outputFormatIdx);
    });

    it('should place history before guidance sections', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
        chatHistoryContext: 'History...',
      }, 'chat-456');

      const historyIdx = result.indexOf('Recent Chat History');
      const outputFormatIdx = result.indexOf('Output Format Requirements');
      expect(outputFormatIdx).toBeGreaterThan(historyIdx);
    });
  });

  describe('buildEnhancedContent - edge cases', () => {
    it('should handle empty text message', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: '',
        messageId: 'msg-empty',
      }, 'chat-456');

      expect(result).toContain('chat-456');
      expect(result).toContain('msg-empty');
      expect(result).toContain('--- User Message ---');
      expect(result).toContain('Output Format Requirements');
    });

    it('should handle message with special characters and unicode', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: '你好世界 🌍 <html>&amp;</html>',
        messageId: 'msg-unicode',
      }, 'chat-456');

      expect(result).toContain('你好世界 🌍');
      expect(result).toContain('<html>&amp;</html>');
    });

    it('should handle multiline user message', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Line 1\nLine 2\nLine 3',
        messageId: 'msg-multi',
      }, 'chat-456');

      expect(result).toContain('Line 1\nLine 2\nLine 3');
    });

    it('should handle message without messageId', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
      }, 'chat-456');

      expect(result).toContain('chat-456');
      expect(result).toContain('Hello');
    });

    it('should handle attachment with size 0', () => {
      const attachments = [{
        id: 'att-1',
        fileName: 'empty.txt',
        mimeType: 'text/plain',
        size: 0,
        localPath: '/tmp/empty.txt',
        source: 'user' as const,
        createdAt: Date.now(),
      }];

      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
        attachments,
      }, 'chat-456');

      expect(result).toContain('empty.txt');
      // size=0 is falsy, so sizeInfo is empty - no KB display
      expect(result).not.toContain('KB');
    });

    it('should handle attachment with very large size (MB)', () => {
      const attachments = [{
        id: 'att-1',
        fileName: 'large.zip',
        mimeType: 'application/zip',
        size: 52428800, // 50 MB
        localPath: '/tmp/large.zip',
        source: 'user' as const,
        createdAt: Date.now(),
      }];

      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
        attachments,
      }, 'chat-456');

      expect(result).toContain('large.zip');
      expect(result).toContain('51200.0 KB');
    });

    it('should handle attachment without mimeType', () => {
      const attachments = [{
        id: 'att-1',
        fileName: 'unknown',
        size: 100,
        localPath: '/tmp/unknown',
        source: 'user' as const,
        createdAt: Date.now(),
      }];

      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
        attachments,
      }, 'chat-456');

      expect(result).toContain('unknown');
      expect(result).toContain('MIME type: unknown');
    });

    it('should handle empty attachments array', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
        attachments: [],
      }, 'chat-456');

      expect(result).not.toContain('Attachments');
      expect(result).not.toContain('file(s)');
    });

    it('should not call buildSkillCommandExtra for regular messages', () => {
      const buildSkillCommandExtra = vi.fn(() => 'Extra');
      const options: MessageBuilderOptions = { buildSkillCommandExtra };
      const builder = new MessageBuilder(options);

      builder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-456');

      expect(buildSkillCommandExtra).not.toHaveBeenCalled();
    });

    it('should handle text starting with spaces but not slash', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: '   Hello world',
        messageId: 'msg-123',
      }, 'chat-456');

      // Leading spaces should not make it a skill command
      expect(result).toContain('Output Format Requirements');
      expect(result).toContain('Hello world');
    });

    it('should combine all channel extensions correctly', () => {
      const options: MessageBuilderOptions = {
        buildHeader: () => '## Header\nPlatform context.',
        buildPostHistory: () => '## Post History\n@ mention info.',
        buildToolsSection: () => '- tool1\n- tool2',
        buildAttachmentExtra: () => '## Image Hint\nAnalyze image.',
      };
      const builder = new MessageBuilder(options);

      const result = builder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
        attachments: [{
          id: 'att-1',
          fileName: 'img.png',
          mimeType: 'image/png',
          size: 500,
          localPath: '/tmp/img.png',
          source: 'user' as const,
          createdAt: Date.now(),
        }],
      }, 'chat-456');

      expect(result).toContain('## Header');
      expect(result).toContain('Platform context.');
      expect(result).toContain('## Post History');
      expect(result).toContain('@ mention info.');
      expect(result).toContain('## Tools');
      expect(result).toContain('tool1');
      expect(result).toContain('Image Hint');
      expect(result).toContain('Analyze image.');
    });

    it('should use card template when capabilities not provided (undefined !== false)', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-456');

      // When capabilities is undefined, supportsCard !== false is true → card template
      expect(result).toContain('Next Steps After Response');
      expect(result).toContain('actionPrompts');
    });

    it('should place header before metadata', () => {
      const options: MessageBuilderOptions = {
        buildHeader: () => 'HEADER_MARKER',
      };
      const builder = new MessageBuilder(options);

      const result = builder.buildEnhancedContent({
        text: 'Hello',
        messageId: 'msg-123',
      }, 'chat-456');

      const headerIdx = result.indexOf('HEADER_MARKER');
      const metadataIdx = result.indexOf('Chat ID');
      expect(headerIdx).toBeLessThan(metadataIdx);
    });
  });
});
