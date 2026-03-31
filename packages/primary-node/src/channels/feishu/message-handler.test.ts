/**
 * Tests for MessageHandler - getQuotedMessageContext.
 *
 * Issue #1711: Quoted interactive card messages should have their text content extracted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageHandler } from './message-handler.js';
import { InteractionManager } from '../../platforms/feishu/interaction-manager.js';
import type { PassiveModeManager } from './passive-mode.js';
import type { MentionDetector } from './mention-detector.js';
import type { MessageCallbacks } from './message-handler.js';

/** Create a mock lark client with configurable message.get response */
function createMockClient(response: { message_type: string; content: string; message_id?: string } | null) {
  const data = response
    ? { message: { message_type: response.message_type, content: response.content, message_id: response.message_id ?? 'msg-123' } }
    : {};
  return {
    im: {
      message: {
        get: vi.fn().mockResolvedValue({ data }),
      },
    },
  };
}

/** Create a minimal MessageHandler instance for testing private methods */
function createTestHandler(client: ReturnType<typeof createMockClient>): MessageHandler {
  const handler = new MessageHandler({
    passiveModeManager: { isPassiveModeDisabled: vi.fn().mockReturnValue(false) } as unknown as PassiveModeManager,
    mentionDetector: { isBotMentioned: vi.fn().mockReturnValue(false) } as unknown as MentionDetector,
    interactionManager: new InteractionManager({ cleanupInterval: 60000 }),
    callbacks: {
      emitMessage: vi.fn().mockResolvedValue(undefined),
      emitControl: vi.fn().mockResolvedValue({ success: true }),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    } satisfies MessageCallbacks,
    isRunning: () => true,
    hasControlHandler: () => false,
  });
  handler.initialize(client as any);
  return handler;
}

describe('MessageHandler - getQuotedMessageContext', () => {
  let handler: MessageHandler;
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should extract text from quoted interactive card message', async () => {
    const cardContent = {
      header: { title: { content: '论文搜索结果' } },
      elements: [
        { tag: 'markdown', content: '找到 3 篇相关论文' },
        { tag: 'markdown', content: '1. Paper A - 2024' },
      ],
    };

    client = createMockClient({
      message_type: 'interactive',
      content: JSON.stringify(cardContent),
      message_id: 'msg-card-1',
    });
    handler = createTestHandler(client);

    const result = await handler['getQuotedMessageContext']('msg-card-1');

    expect(result).toBeDefined();
    expect(result!.text).toContain('引用的消息');
    expect(result!.text).toContain('[论文搜索结果]');
    expect(result!.text).toContain('找到 3 篇相关论文');
  });

  it('should return generic description for interactive card with no text', async () => {
    const cardContent = { elements: [] };

    client = createMockClient({
      message_type: 'interactive',
      content: JSON.stringify(cardContent),
    });
    handler = createTestHandler(client);

    const result = await handler['getQuotedMessageContext']('msg-card-2');

    expect(result).toBeDefined();
    expect(result!.text).toContain('Interactive Card');
  });

  it('should handle interactive card with malformed JSON gracefully', async () => {
    client = createMockClient({
      message_type: 'interactive',
      content: 'not valid json{{{',
    });
    handler = createTestHandler(client);

    const result = await handler['getQuotedMessageContext']('msg-card-3');

    // Should fall back to raw content via the outer catch block
    expect(result).toBeDefined();
    expect(result!.text).toContain('not valid json');
  });

  it('should handle interactive card with null content', async () => {
    client = createMockClient({
      message_type: 'interactive',
      content: '',
    });
    handler = createTestHandler(client);

    const result = await handler['getQuotedMessageContext']('msg-card-4');

    // extractCardTextContent should return generic description, which is non-empty
    expect(result).toBeDefined();
    expect(result!.text).toContain('Interactive Card');
  });
});
