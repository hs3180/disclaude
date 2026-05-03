/**
 * Tests for Feishu-specific channel sections with MessageBuilder.
 *
 * Issue #1492: Tests for Feishu-specific channel sections used with
 * the core MessageBuilder.
 * Issue #1499: Moved from @disclaude/worker-node to @disclaude/primary-node.
 *
 * Issue #809: Tests for image analyzer MCP hint in buildAttachmentExtra.
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

// Mock config
vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@disclaude/core')>();
  return {
    ...actual,
    Config: {
      ...actual.Config,
      getMcpServersConfig: vi.fn(() => null),
    },
  };
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

  describe('buildAttachmentExtra - image analyzer hint (Issue #809)', () => {
    it('should include image analyzer hint for image attachments when MCP is configured', async () => {
      const { Config } = await import('@disclaude/core');
      vi.mocked(Config.getMcpServersConfig).mockReturnValueOnce({
        '4_5v_mcp': { command: 'test-command' },
      } as any);

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

      // Issue #656: Enhanced image analysis prompt
      expect(result).toContain('Image Analysis Required');
      expect(result).toContain('mcp__4_5v_mcp__analyze_image');
      expect(result).toContain('MUST analyze the image content');
      expect(result).toContain('Analysis Workflow');
    });

    it('should not include image analyzer hint when no image analyzer MCP is configured', async () => {
      const { Config } = await import('@disclaude/core');
      vi.mocked(Config.getMcpServersConfig).mockReturnValueOnce(undefined as any);

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

      expect(result).not.toContain('Image Analysis Required');
      expect(result).not.toContain('mcp__4_5v_mcp__analyze_image');
    });

    it('should not include image analyzer hint for non-image attachments', async () => {
      const { Config } = await import('@disclaude/core');
      vi.mocked(Config.getMcpServersConfig).mockReturnValueOnce({
        '4_5v_mcp': { command: 'test-command' },
      } as any);

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

      expect(result).not.toContain('Image Analysis Required');
    });

    it('should detect various image analyzer MCP names', async () => {
      const { Config } = await import('@disclaude/core');
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
          source: 'user' as const,
          createdAt: Date.now(),
        }];

        const builder = new MessageBuilder(createFeishuMessageBuilderOptions());
        const result = builder.buildEnhancedContent({
          text: 'Hello',
          messageId: 'msg-123',
          attachments: imageAttachment,
        } as MessageData, 'chat-123');

        expect(result).toContain('Image Analysis Required');
      }
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

  describe('buildContentGuidance - Feishu doc link handling (Issue #3035)', () => {
    it('should include lark-cli guidance when message contains a Feishu wiki URL', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Please check https://xxx.feishu.cn/wiki/YgJMw6RRkifisVkPVR8cKnWLnmb',
        messageId: 'msg-123',
      }, 'chat-123');

      expect(result).toContain('Feishu Document Link Handling');
      expect(result).toContain('lark-cli docs +fetch');
      expect(result).toContain('--scope outline');
      expect(result).toContain('--scope section');
      expect(result).toContain('Do NOT use webReader');
    });

    it('should include lark-cli guidance when message contains a Feishu docx URL', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'See this doc: https://example.feishu.cn/docx/ABC123xyz',
        messageId: 'msg-123',
      }, 'chat-123');

      expect(result).toContain('Feishu Document Link Handling');
      expect(result).toContain('lark-cli docs +fetch');
    });

    it('should NOT include lark-cli guidance for regular messages without Feishu URLs', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Hello, how are you?',
        messageId: 'msg-123',
      }, 'chat-123');

      expect(result).not.toContain('Feishu Document Link Handling');
      expect(result).not.toContain('lark-cli docs +fetch');
    });

    it('should NOT include lark-cli guidance for non-Feishu URLs', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Check out https://github.com/hs3180/disclaude',
        messageId: 'msg-123',
      }, 'chat-123');

      expect(result).not.toContain('Feishu Document Link Handling');
    });

    it('should NOT include lark-cli guidance for skill commands', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: '/skill https://xxx.feishu.cn/wiki/YgJMw6RRkifisVkPVR8cKnWLnmb',
        messageId: 'msg-123',
      }, 'chat-123');

      expect(result).not.toContain('Feishu Document Link Handling');
    });

    it('should handle multiple Feishu URLs in one message', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Compare https://xxx.feishu.cn/wiki/ABC123 and https://yyy.feishu.cn/docx/XYZ789',
        messageId: 'msg-123',
      }, 'chat-123');

      expect(result).toContain('Feishu Document Link Handling');
    });

    it('should include recommended two-step flow instructions', () => {
      const result = messageBuilder.buildEnhancedContent({
        text: 'Read https://xxx.feishu.cn/wiki/TestDoc123',
        messageId: 'msg-123',
      }, 'chat-123');

      expect(result).toContain('Recommended Two-Step Flow');
      expect(result).toContain('--max-depth 3');
      expect(result).toContain('--start-block-id');
    });
  });
});
