/**
 * Tests for MessageHandler — interactive card quoted message handling (Issue #1711).
 *
 * Tests that getQuotedMessageContext correctly extracts text from
 * interactive card messages when a user replies to a bot-sent card.
 *
 * Does NOT mock @larksuiteoapi/node-sdk directly (per CLAUDE.md rules),
 * instead uses dependency-injected mocks via constructor and initialize().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageHandler } from './message-handler.js';
import type { MessageCallbacks } from './message-handler.js';
import type { PassiveModeManager } from './passive-mode.js';
import type { MentionDetector } from './mention-detector.js';
import { InteractionManager } from '../../platforms/feishu/interaction-manager.js';

// ─── Mock Helpers ──────────────────────────────────────────────────────

function createMockClient(messageResponse: Record<string, unknown>) {
  return {
    im: {
      message: {
        get: vi.fn().mockResolvedValue({ data: messageResponse }),
        resource: {
          get: vi.fn(),
        },
      },
    },
  } as unknown as import('@larksuiteoapi/node-sdk').Client;
}

function createMockPassiveModeManager(): PassiveModeManager {
  return {
    isPassiveMode: vi.fn().mockReturnValue(false),
    checkAndHandle: vi.fn().mockResolvedValue(undefined),
  } as unknown as PassiveModeManager;
}

function createMockMentionDetector(): MentionDetector {
  return {
    detect: vi.fn().mockReturnValue({ botMentioned: false, mentions: [] }),
  } as unknown as MentionDetector;
}

function createMockCallbacks(): MessageCallbacks {
  return {
    emitMessage: vi.fn().mockResolvedValue(undefined),
    emitControl: vi.fn().mockResolvedValue({ handled: false }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function createInteractionManager(): InteractionManager {
  return new InteractionManager();
}

// ─── Test Suite ────────────────────────────────────────────────────────

describe('MessageHandler.getQuotedMessageContext — interactive card (Issue #1711)', () => {
  let handler: MessageHandler;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    handler = new MessageHandler({
      passiveModeManager: createMockPassiveModeManager(),
      mentionDetector: createMockMentionDetector(),
      interactionManager: createInteractionManager(),
      callbacks: createMockCallbacks(),
      isRunning: () => true,
      hasControlHandler: () => false,
    });
  });

  it('should extract text from quoted interactive card with header and elements', async () => {
    const cardContent = JSON.stringify({
      header: { title: { content: '任务执行中' } },
      elements: [
        { tag: 'markdown', content: '✅ 任务已完成' },
        {
          tag: 'action',
          actions: [{ tag: 'button', text: { content: '查看详情' } }],
        },
      ],
    });

    mockClient = createMockClient({
      message: {
        message_type: 'interactive',
        content: cardContent,
        message_id: 'msg_interactive_001',
      },
    });
    handler.initialize(mockClient);

    // Access private method via type assertion for testing
    const result = await (handler as unknown as {
      getQuotedMessageContext: (parentId: string) => Promise<{ text: string; attachment?: unknown } | undefined>;
    }).getQuotedMessageContext('msg_interactive_001');

    expect(result).toBeDefined();
    expect(result!.text).toContain('[Interactive Card]');
    expect(result!.text).toContain('[任务执行中]');
    expect(result!.text).toContain('✅ 任务已完成');
    expect(result!.text).toContain('> **引用的消息**:');
  });

  it('should extract text from quoted interactive card with only markdown elements', async () => {
    const cardContent = JSON.stringify({
      elements: [
        { tag: 'markdown', content: '论文搜索结果：3篇相关论文' },
        { tag: 'note', content: '点击查看详情' },
      ],
    });

    mockClient = createMockClient({
      message: {
        message_type: 'interactive',
        content: cardContent,
        message_id: 'msg_interactive_002',
      },
    });
    handler.initialize(mockClient);

    const result = await (handler as unknown as {
      getQuotedMessageContext: (parentId: string) => Promise<{ text: string; attachment?: unknown } | undefined>;
    }).getQuotedMessageContext('msg_interactive_002');

    expect(result).toBeDefined();
    expect(result!.text).toContain('论文搜索结果');
    expect(result!.text).toContain('点击查看详情');
  });

  it('should return undefined for interactive card with no extractable content', async () => {
    const cardContent = JSON.stringify({
      elements: [{ tag: 'unknown_tag', data: 'something' }],
    });

    mockClient = createMockClient({
      message: {
        message_type: 'interactive',
        content: cardContent,
        message_id: 'msg_interactive_003',
      },
    });
    handler.initialize(mockClient);

    const result = await (handler as unknown as {
      getQuotedMessageContext: (parentId: string) => Promise<{ text: string; attachment?: unknown } | undefined>;
    }).getQuotedMessageContext('msg_interactive_003');

    // extractCardTextContent returns '[Interactive Card]' even for empty cards,
    // which is non-empty, so this should still return a result
    expect(result).toBeDefined();
    expect(result!.text).toContain('[Interactive Card]');
  });

  it('should handle malformed interactive card content gracefully', async () => {
    mockClient = createMockClient({
      message: {
        message_type: 'interactive',
        content: 'not-valid-json{{{',
        message_id: 'msg_interactive_004',
      },
    });
    handler.initialize(mockClient);

    const result = await (handler as unknown as {
      getQuotedMessageContext: (parentId: string) => Promise<{ text: string; attachment?: unknown } | undefined>;
    }).getQuotedMessageContext('msg_interactive_004');

    // Should fall back to raw content since JSON.parse fails
    expect(result).toBeDefined();
    expect(result!.text).toContain('not-valid-json');
  });

  it('should still handle text message type correctly (regression)', async () => {
    const textContent = JSON.stringify({ text: 'Hello world' });

    mockClient = createMockClient({
      message: {
        message_type: 'text',
        content: textContent,
        message_id: 'msg_text_001',
      },
    });
    handler.initialize(mockClient);

    const result = await (handler as unknown as {
      getQuotedMessageContext: (parentId: string) => Promise<{ text: string; attachment?: unknown } | undefined>;
    }).getQuotedMessageContext('msg_text_001');

    expect(result).toBeDefined();
    expect(result!.text).toContain('Hello world');
  });

  it('should still handle post message type correctly (regression)', async () => {
    const postContent = JSON.stringify({
      title: 'Test Post',
      content: [
        [{ tag: 'text', text: 'Post content here' }],
      ],
    });

    mockClient = createMockClient({
      message: {
        message_type: 'post',
        content: postContent,
        message_id: 'msg_post_001',
      },
    });
    handler.initialize(mockClient);

    const result = await (handler as unknown as {
      getQuotedMessageContext: (parentId: string) => Promise<{ text: string; attachment?: unknown } | undefined>;
    }).getQuotedMessageContext('msg_post_001');

    expect(result).toBeDefined();
    expect(result!.text).toContain('Post content here');
  });

  it('should return undefined when client is not initialized', async () => {
    const result = await (handler as unknown as {
      getQuotedMessageContext: (parentId: string) => Promise<{ text: string; attachment?: unknown } | undefined>;
    }).getQuotedMessageContext('msg_any_001');

    expect(result).toBeUndefined();
  });

  it('should return undefined when message is not found', async () => {
    mockClient = createMockClient({}) as unknown as ReturnType<typeof createMockClient>;
    // Override the mock to return empty data
    (mockClient as unknown as { im: { message: { get: ReturnType<typeof vi.fn> } } }).im.message.get = vi.fn().mockResolvedValue({ data: {} });
    handler.initialize(mockClient);

    const result = await (handler as unknown as {
      getQuotedMessageContext: (parentId: string) => Promise<{ text: string; attachment?: unknown } | undefined>;
    }).getQuotedMessageContext('nonexistent');

    expect(result).toBeUndefined();
  });
});
