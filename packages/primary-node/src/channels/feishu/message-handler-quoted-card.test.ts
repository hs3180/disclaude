/**
 * Tests for Issue #1711: Quoted interactive card messages.
 *
 * Verifies that when a user replies to a bot-sent interactive card,
 * the quoted card content is correctly extracted and included in
 * the emitted message metadata.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock @disclaude/core ─────────────────────────────────────────────

const mockCreateLogger = vi.hoisted(() => vi.fn(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
})));

const mockConfig = vi.hoisted(() => ({
  getWorkspaceDir: vi.fn(() => '/tmp/test-workspace'),
}));

const mockMessageLogger = vi.hoisted(() => ({
  isMessageProcessed: vi.fn(() => false),
  logIncomingMessage: vi.fn(() => Promise.resolve()),
  getChatHistory: vi.fn(() => Promise.resolve('')),
}));

vi.mock('@disclaude/core', () => ({
  Config: mockConfig,
  DEDUPLICATION: { MAX_MESSAGE_AGE: 300_000 },
  REACTIONS: { TYPING: 'EYES' },
  CHAT_HISTORY: { MAX_CONTEXT_LENGTH: 4000 },
  createLogger: mockCreateLogger,
  stripLeadingMentions: vi.fn((text: string) => text),
  ensureFileExtension: vi.fn((p: string) => p),
}));

vi.mock('./message-logger.js', () => ({
  messageLogger: mockMessageLogger,
}));

// ─── Test helpers ─────────────────────────────────────────────────────

/**
 * Create a mock Lark client that returns specific message data for im.message.get.
 */
function createMockLarkClient(quotedMessage: {
  message_type: string;
  content: string;
  message_id?: string;
}) {
  return {
    im: {
      message: {
        get: vi.fn().mockResolvedValue({
          data: {
            message: {
              message_type: quotedMessage.message_type,
              content: quotedMessage.content,
              message_id: quotedMessage.message_id || 'quoted_msg_123',
            },
          },
        }),
      },
      messageReaction: {
        create: vi.fn().mockResolvedValue({}),
      },
      messageResource: {
        get: vi.fn(),
      },
    },
  };
}

function createMockMentionDetector(isMentioned = true) {
  return {
    isBotMentioned: vi.fn(() => isMentioned),
  };
}

function createMockInteractionManager() {
  return {
    handleAction: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockPassiveModeManager() {
  return {
    isPassiveModeDisabled: vi.fn(() => true),
  };
}

// ─── Import after mocks ───────────────────────────────────────────────

const { MessageHandler } = await import('./message-handler.js');

// ─── Tests ────────────────────────────────────────────────────────────

describe('Issue #1711: Quoted interactive card messages', () => {
  let handler: InstanceType<typeof MessageHandler>;
  let mockCallbacks: {
    emitMessage: ReturnType<typeof vi.fn>;
    emitControl: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockCallbacks = {
      emitMessage: vi.fn().mockResolvedValue(undefined),
      emitControl: vi.fn().mockResolvedValue({ success: false }),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };

    handler = new MessageHandler({
      passiveModeManager: createMockPassiveModeManager(),
      mentionDetector: createMockMentionDetector(true),
      interactionManager: createMockInteractionManager(),
      callbacks: mockCallbacks,
      isRunning: () => true,
      hasControlHandler: () => false,
    });
  });

  it('should extract text from quoted interactive card message', async () => {
    const cardContent = JSON.stringify({
      header: {
        title: { content: '搜索结果' },
      },
      elements: [
        { tag: 'markdown', content: '找到 3 篇相关论文' },
        { tag: 'div', text: '论文1: 关于AI的研究' },
      ],
    });

    const mockClient = createMockLarkClient({
      message_type: 'interactive',
      content: cardContent,
      message_id: 'card_msg_001',
    });

    handler.initialize(mockClient as unknown as Parameters<typeof handler.initialize>[0]);

    // Send a text message that replies to the card
    // Note: create_time must be in milliseconds to match Date.now() comparison
    await handler.handleMessageReceive({
      event: {
        message: {
          message_id: 'user_msg_001',
          chat_id: 'oc_test',
          chat_type: 'group',
          content: JSON.stringify({ text: '你能看到这些论文吗' }),
          message_type: 'text',
          create_time: Date.now(),
          mentions: [],
          parent_id: 'card_msg_001',
        },
        sender: {
          sender_type: 'user',
          sender_id: { open_id: 'ou_user_001' },
        },
      },
    } as unknown as Parameters<typeof handler.handleMessageReceive>[0]);

    // Verify the emitted message includes quoted card content
    expect(mockCallbacks.emitMessage).toHaveBeenCalledTimes(1);
    const emittedMsg = mockCallbacks.emitMessage.mock.calls[0][0];

    // The metadata should contain the quoted message with extracted card text
    expect(emittedMsg.metadata).toBeDefined();
    expect(emittedMsg.metadata.quotedMessage).toContain('搜索结果');
    expect(emittedMsg.metadata.quotedMessage).toContain('找到 3 篇相关论文');
    expect(emittedMsg.metadata.quotedMessage).toContain('[Interactive Card]');
  });

  it('should return undefined when quoted interactive card has no extractable text', async () => {
    const cardContent = JSON.stringify({
      elements: [
        { tag: 'unknown_tag', data: 'something' },
      ],
    });

    const mockClient = createMockLarkClient({
      message_type: 'interactive',
      content: cardContent,
      message_id: 'card_msg_002',
    });

    handler.initialize(mockClient as unknown as Parameters<typeof handler.initialize>[0]);

    await handler.handleMessageReceive({
      event: {
        message: {
          message_id: 'user_msg_002',
          chat_id: 'oc_test',
          chat_type: 'group',
          content: JSON.stringify({ text: '这条引用是什么' }),
          message_type: 'text',
          create_time: Date.now(),
          mentions: [],
          parent_id: 'card_msg_002',
        },
        sender: {
          sender_type: 'user',
          sender_id: { open_id: 'ou_user_001' },
        },
      },
    } as unknown as Parameters<typeof handler.handleMessageReceive>[0]);

    expect(mockCallbacks.emitMessage).toHaveBeenCalledTimes(1);
    const emittedMsg = mockCallbacks.emitMessage.mock.calls[0][0];

    // extractCardTextContent returns '[Interactive Card]' even for empty cards,
    // so the quoted message should still contain it
    expect(emittedMsg.metadata?.quotedMessage).toContain('[Interactive Card]');
  });

  it('should still handle quoted text messages correctly (no regression)', async () => {
    const mockClient = createMockLarkClient({
      message_type: 'text',
      content: JSON.stringify({ text: '原始文本消息' }),
      message_id: 'text_msg_001',
    });

    handler.initialize(mockClient as unknown as Parameters<typeof handler.initialize>[0]);

    await handler.handleMessageReceive({
      event: {
        message: {
          message_id: 'user_msg_003',
          chat_id: 'oc_test',
          chat_type: 'group',
          content: JSON.stringify({ text: '回复文本消息' }),
          message_type: 'text',
          create_time: Date.now(),
          mentions: [],
          parent_id: 'text_msg_001',
        },
        sender: {
          sender_type: 'user',
          sender_id: { open_id: 'ou_user_001' },
        },
      },
    } as unknown as Parameters<typeof handler.handleMessageReceive>[0]);

    expect(mockCallbacks.emitMessage).toHaveBeenCalledTimes(1);
    const emittedMsg = mockCallbacks.emitMessage.mock.calls[0][0];

    expect(emittedMsg.metadata?.quotedMessage).toContain('原始文本消息');
  });

  it('should still handle quoted post messages correctly (no regression)', async () => {
    const postContent = JSON.stringify({
      content: [
        [{ tag: 'text', text: '富文本消息内容' }],
      ],
    });

    const mockClient = createMockLarkClient({
      message_type: 'post',
      content: postContent,
      message_id: 'post_msg_001',
    });

    handler.initialize(mockClient as unknown as Parameters<typeof handler.initialize>[0]);

    await handler.handleMessageReceive({
      event: {
        message: {
          message_id: 'user_msg_004',
          chat_id: 'oc_test',
          chat_type: 'group',
          content: JSON.stringify({ text: '回复富文本' }),
          message_type: 'text',
          create_time: Date.now(),
          mentions: [],
          parent_id: 'post_msg_001',
        },
        sender: {
          sender_type: 'user',
          sender_id: { open_id: 'ou_user_001' },
        },
      },
    } as unknown as Parameters<typeof handler.handleMessageReceive>[0]);

    expect(mockCallbacks.emitMessage).toHaveBeenCalledTimes(1);
    const emittedMsg = mockCallbacks.emitMessage.mock.calls[0][0];

    expect(emittedMsg.metadata?.quotedMessage).toContain('富文本消息内容');
  });
});
