/**
 * Unit tests for MessageHandler.
 *
 * Tests message parsing, deduplication, bot filtering, trigger mode,
 * command handling, and card action routing.
 *
 * Issue #1617: Phase 4 — Feishu platform test coverage
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Shared mock state (hoisted so vi.mock factories can reference it)
// ---------------------------------------------------------------------------
const mockState = vi.hoisted(() => ({
  isRunning: true,
  hasControlHandler: false,
  emitMessage: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  emitControl: vi.fn<() => Promise<{ success: boolean; message?: string }>>().mockResolvedValue({ success: false }),
  sendMessage: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  routeCardAction: vi.fn<() => Promise<{ routed: boolean; expired?: boolean }>>().mockResolvedValue({ routed: false }),
  resolveActionPrompt: vi.fn().mockReturnValue(undefined),
  isMessageProcessed: false,
  logIncomingMessage: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  getChatHistory: vi.fn<() => Promise<string | undefined>>().mockResolvedValue(undefined),
  isBotMentioned: false,
  interactionHandleAction: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  workspaceDir: '/tmp/mh-test',
  execFileCallback: null as ((err: Error | null, result?: { stdout: string; stderr: string }) => void) | null,
}));

const mockExecFile = vi.hoisted(() =>
  vi.fn((...args: unknown[]) => {
    const callback = args[args.length - 1] as (err: Error | null, result?: { stdout: string; stderr: string }) => void;
    if (mockState.execFileCallback) {
      mockState.execFileCallback(null, { stdout: 'ok', stderr: '' });
    } else {
      callback(null, { stdout: 'ok', stderr: '' });
    }
  })
);

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@disclaude/core', async () => {
  const actual = await vi.importActual<typeof import('@disclaude/core')>('@disclaude/core');
  return {
    ...actual,
    Config: {
      getWorkspaceDir: () => mockState.workspaceDir,
    },
    DEDUPLICATION: { MAX_MESSAGE_AGE: 300_000 },
    REACTIONS: { TYPING: 'Typing' },
    CHAT_HISTORY: { MAX_CONTEXT_LENGTH: 10000 },
    createLogger: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    }),
    stripLeadingMentions: (text: string) => text,
  };
});

vi.mock('child_process', () => ({
  execFile: mockExecFile,
}));

vi.mock('../../platforms/feishu/interaction-manager.js', () => ({
  InteractionManager: vi.fn().mockImplementation(() => ({
    handleAction: mockState.interactionHandleAction,
  })),
}));

vi.mock('../../platforms/feishu/card-builders/card-text-extractor.js', () => ({
  extractCardTextContent: vi.fn().mockReturnValue('Extracted card text'),
  extractFullCardContent: vi.fn().mockReturnValue('Mocked full card content'),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    mkdir: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 1024 }),
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../utils/message-logger.js', () => ({
  messageLogger: {
    isMessageProcessed: () => mockState.isMessageProcessed,
    logIncomingMessage: mockState.logIncomingMessage,
    getChatHistory: mockState.getChatHistory,
  },
}));

// ---------------------------------------------------------------------------
// Import SUT after mocks
// ---------------------------------------------------------------------------
import { MessageHandler } from './message-handler.js';
import { TriggerModeManager } from './passive-mode.js';
import { MentionDetector } from './mention-detector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the first call argument from a mocked function. */
function firstCallArg(fn: { mock: { calls: any[][] } }): any {
  const {calls} = fn.mock;
  return calls[0]?.[0];
}

/** Create a MessageHandler with sensible defaults. */
function createHandler(overrides: Record<string, unknown> = {}) {
  const triggerModeManager = new TriggerModeManager();
  const mentionDetector = new MentionDetector();

  // Spy on mentionDetector.isBotMentioned to use mock state
  vi.spyOn(mentionDetector, 'isBotMentioned').mockImplementation(() => mockState.isBotMentioned);

  const handler = new MessageHandler({
    triggerModeManager,
    mentionDetector,
    interactionManager: { handleAction: mockState.interactionHandleAction } as any,
    callbacks: {
      emitMessage: mockState.emitMessage,
      emitControl: mockState.emitControl,
      sendMessage: mockState.sendMessage,
      routeCardAction: mockState.routeCardAction,
      resolveActionPrompt: mockState.resolveActionPrompt,
    },
    isRunning: () => mockState.isRunning,
    hasControlHandler: () => mockState.hasControlHandler,
    tenantAccessToken: 'test-tenant-token',
    ...overrides,
  });

  return { handler, triggerModeManager, mentionDetector };
}

/** Build a Feishu text message event. */
function textEvent(text: string, overrides: Record<string, unknown> = {}) {
  return {
    event: {
      message: {
        message_id: 'msg_001',
        chat_id: 'chat_001',
        chat_type: 'p2p',
        content: JSON.stringify({ text }),
        message_type: 'text',
        create_time: Date.now(),
        mentions: undefined,
        parent_id: undefined,
      },
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'user_001' },
      },
    },
    ...overrides,
  } as any;
}

/** Build a Feishu post message event. */
function postEvent(content: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    event: {
      message: {
        message_id: 'msg_post',
        chat_id: 'chat_001',
        chat_type: 'p2p',
        content: JSON.stringify({ content }),
        message_type: 'post',
        create_time: Date.now(),
        mentions: undefined,
        parent_id: undefined,
      },
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'user_001' },
      },
    },
    ...overrides,
  } as any;
}

/** Build a Feishu card action event. */
function cardActionEvent(overrides: Record<string, unknown> = {}) {
  return {
    context: { open_message_id: 'card_msg_001', open_chat_id: 'chat_001' },
    operator: { open_id: 'user_001', user_id: 'uid_001' },
    action: { tag: 'button', value: 'action_value', text: 'Click me' },
    tenant_key: 'tenant_001',
    ...overrides,
  } as any;
}

// ===========================================================================
// Tests
// ===========================================================================

describe('MessageHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.isRunning = true;
    mockState.hasControlHandler = false;
    mockState.isMessageProcessed = false;
    mockState.isBotMentioned = false;
  });

  // -----------------------------------------------------------------------
  // Constructor & lifecycle
  // -----------------------------------------------------------------------
  describe('constructor and lifecycle', () => {
    it('should construct without errors', () => {
      const { handler } = createHandler();
      expect(handler).toBeDefined();
    });

    it('should return undefined client before initialization', () => {
      const { handler } = createHandler();
      expect(handler.getClient()).toBeUndefined();
    });

    it('should store client after initialize()', () => {
      const { handler } = createHandler();
      const mockClient = {} as any;
      handler.initialize(mockClient);
      expect(handler.getClient()).toBe(mockClient);
    });

    it('should clear client on clearClient()', () => {
      const { handler } = createHandler();
      handler.initialize({} as any);
      handler.clearClient();
      expect(handler.getClient()).toBeUndefined();
    });

    it('should update control handler flag', () => {
      const { handler } = createHandler();
      handler.setControlHandler(true);
      // Control handler affects command routing; tested via command tests below
      handler.setControlHandler(false);
    });
  });

  // -----------------------------------------------------------------------
  // Text message handling
  // -----------------------------------------------------------------------
  describe('handleMessageReceive — text messages', () => {
    it('should emit a valid text message', async () => {
      const { handler } = createHandler();
      await handler.handleMessageReceive(textEvent('Hello world'));

      expect(mockState.emitMessage).toHaveBeenCalledTimes(1);
      const msg = firstCallArg(mockState.emitMessage);
      expect(msg.content).toBe('Hello world');
      expect(msg.chatId).toBe('chat_001');
      expect(msg.userId).toBe('user_001');
      expect(msg.messageType).toBe('text');
    });

    it('should skip messages when handler is not running', async () => {
      mockState.isRunning = false;
      const { handler } = createHandler();
      await handler.handleMessageReceive(textEvent('Hello'));
      expect(mockState.emitMessage).not.toHaveBeenCalled();
    });

    it('should skip messages missing required fields', async () => {
      const { handler } = createHandler();
      await handler.handleMessageReceive({
        event: {
          message: { message_id: '', chat_id: '', content: '', message_type: '' },
          sender: {},
        },
      });
      expect(mockState.emitMessage).not.toHaveBeenCalled();
    });

    it('should skip duplicate messages', async () => {
      mockState.isMessageProcessed = true;
      const { handler } = createHandler();
      await handler.handleMessageReceive(textEvent('dup'));
      expect(mockState.emitMessage).not.toHaveBeenCalled();
    });

    it('should skip messages older than MAX_MESSAGE_AGE', async () => {
      const { handler } = createHandler();
      const oldTimestamp = Date.now() - 600_000; // 10 min ago
      await handler.handleMessageReceive(textEvent('old', {
        event: {
          message: {
            message_id: 'msg_old',
            chat_id: 'chat_001',
            chat_type: 'p2p',
            content: JSON.stringify({ text: 'old' }),
            message_type: 'text',
            create_time: oldTimestamp,
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      }));
      expect(mockState.emitMessage).not.toHaveBeenCalled();
    });

    it('should skip empty text messages', async () => {
      const { handler } = createHandler();
      await handler.handleMessageReceive(textEvent('   '));
      expect(mockState.emitMessage).not.toHaveBeenCalled();
    });

    it('should skip unsupported message types', async () => {
      const { handler } = createHandler();
      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'msg_unsupported',
            chat_id: 'chat_001',
            chat_type: 'p2p',
            content: '{}',
            message_type: 'sticker',
            create_time: Date.now(),
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      });
      expect(mockState.emitMessage).not.toHaveBeenCalled();
    });

    it('should log incoming messages', async () => {
      const { handler } = createHandler();
      await handler.handleMessageReceive(textEvent('Hello'));
      expect(mockState.logIncomingMessage).toHaveBeenCalledWith(
        'msg_001',
        'user_001',
        'chat_001',
        'Hello',
        'text',
        expect.any(Number),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Bot message filtering
  // -----------------------------------------------------------------------
  describe('handleMessageReceive — bot message filtering', () => {
    it('should skip bot messages when bot is not mentioned', async () => {
      mockState.isBotMentioned = false;
      const { handler } = createHandler();

      await handler.handleMessageReceive(textEvent('bot says hi', {
        event: {
          message: {
            message_id: 'msg_bot',
            chat_id: 'chat_001',
            chat_type: 'p2p',
            content: JSON.stringify({ text: 'bot says hi' }),
            message_type: 'text',
            create_time: Date.now(),
          },
          sender: { sender_type: 'app', sender_id: { open_id: 'bot_001' } },
        },
      }));
      expect(mockState.emitMessage).not.toHaveBeenCalled();
    });

    it('should allow bot messages that @mention our bot', async () => {
      mockState.isBotMentioned = true;
      const { handler } = createHandler();

      await handler.handleMessageReceive(textEvent('hey @bot', {
        event: {
          message: {
            message_id: 'msg_bot_mention',
            chat_id: 'chat_001',
            chat_type: 'p2p',
            content: JSON.stringify({ text: 'hey @bot' }),
            message_type: 'text',
            create_time: Date.now(),
          },
          sender: { sender_type: 'app', sender_id: { open_id: 'bot_001' } },
        },
      }));
      expect(mockState.emitMessage).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // Post message parsing
  // -----------------------------------------------------------------------
  describe('handleMessageReceive — post message parsing', () => {
    it('should parse plain text segments', async () => {
      const { handler } = createHandler();
      await handler.handleMessageReceive(postEvent([
        [{ tag: 'text', text: 'Hello ' }, { tag: 'text', text: 'world' }],
      ]));
      expect(mockState.emitMessage).toHaveBeenCalledTimes(1);
      expect(firstCallArg(mockState.emitMessage).content).toBe('Hello world');
    });

    it('should parse link segments', async () => {
      const { handler } = createHandler();
      await handler.handleMessageReceive(postEvent([
        [{ tag: 'a', text: 'Click here', href: 'https://example.com' }],
      ]));
      expect(firstCallArg(mockState.emitMessage).content).toBe('Click here');
    });

    it('should parse @mention segments', async () => {
      const { handler } = createHandler();
      await handler.handleMessageReceive(postEvent([
        [{ tag: 'at', user_id: 'user_002', text: 'John' }],
      ]));
      expect(firstCallArg(mockState.emitMessage).content).toBe('@John');
    });

    it('should parse image segments as [图片]', async () => {
      const { handler } = createHandler();
      await handler.handleMessageReceive(postEvent([
        [{ tag: 'img', image_key: 'img_001' }],
      ]));
      expect(firstCallArg(mockState.emitMessage).content).toBe('[图片]');
    });

    it('should parse code_block segments into markdown', async () => {
      const { handler } = createHandler();
      await handler.handleMessageReceive(postEvent([
        [{ tag: 'code_block', language: 'python', text: 'print("hi")' }],
      ]));
      const content = firstCallArg(mockState.emitMessage).content as string;
      expect(content).toContain('```python');
      expect(content).toContain('print("hi")');
      expect(content).toContain('```');
    });

    it('should parse pre segments into markdown', async () => {
      const { handler } = createHandler();
      await handler.handleMessageReceive(postEvent([
        [{ tag: 'pre', text: 'raw text' }],
      ]));
      const content = firstCallArg(mockState.emitMessage).content as string;
      expect(content).toContain('```\nraw text\n```');
    });

    it('should parse chat_history segments', async () => {
      const { handler } = createHandler();
      await handler.handleMessageReceive(postEvent([
        [{
          tag: 'chat_history',
          messages: [
            { sender: 'Alice', content: 'Hello', create_time: '10:00' },
            { sender: 'Bob', content: 'World', create_time: '10:01' },
          ],
        }],
      ]));
      const content = firstCallArg(mockState.emitMessage).content as string;
      expect(content).toContain('Alice: Hello');
      expect(content).toContain('Bob: World');
      expect(content).toContain('转发的聊天记录');
    });

    it('should extract text from unknown tags with text field', async () => {
      const { handler } = createHandler();
      await handler.handleMessageReceive(postEvent([
        [{ tag: 'custom_tag', text: 'Custom content' }],
      ]));
      expect(firstCallArg(mockState.emitMessage).content).toBe('Custom content');
    });

    it('should skip segments without a tag', async () => {
      const { handler } = createHandler();
      // Post with a segment that has no tag alongside a text segment
      await handler.handleMessageReceive(postEvent([
        [{ text: 'No tag' }, { tag: 'text', text: 'Has tag' }],
      ]));
      // Only the tagged segment's text should appear
      expect(firstCallArg(mockState.emitMessage).content).toBe('Has tag');
    });

    it('should handle mixed content in multiple rows', async () => {
      const { handler } = createHandler();
      await handler.handleMessageReceive(postEvent([
        [{ tag: 'text', text: 'Row 1' }],
        [{ tag: 'text', text: 'Row 2' }],
      ]));
      const content = firstCallArg(mockState.emitMessage).content as string;
      expect(content).toContain('Row 1');
      expect(content).toContain('Row 2');
    });
  });

  // -----------------------------------------------------------------------
  // share_chat message parsing
  // -----------------------------------------------------------------------
  describe('handleMessageReceive — share_chat messages', () => {
    function shareChatEvent(parsed: Record<string, unknown>) {
      return {
        event: {
          message: {
            message_id: 'msg_share',
            chat_id: 'chat_001',
            chat_type: 'p2p',
            content: JSON.stringify(parsed),
            message_type: 'share_chat',
            create_time: Date.now(),
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      } as any;
    }

    it('should parse share_chat with structured chat history', async () => {
      const { handler } = createHandler();
      await handler.handleMessageReceive(shareChatEvent({
        title: 'Meeting Notes',
        chat_history: [
          { sender: 'Alice', content: 'Agenda item 1', create_time: '2026-01-01T10:00:00Z' },
          { sender: 'Bob', content: 'Agenda item 2', create_time: '2026-01-01T10:01:00Z' },
        ],
      }));

      expect(mockState.emitMessage).toHaveBeenCalledTimes(1);
      const content = firstCallArg(mockState.emitMessage).content as string;
      expect(content).toContain('Meeting Notes');
      expect(content).toContain('Alice');
      expect(content).toContain('Agenda item 1');
    });

    it('should fall back to body when no structured history', async () => {
      const { handler } = createHandler();
      await handler.handleMessageReceive(shareChatEvent({
        body: 'Forwarded body text',
      }));

      const content = firstCallArg(mockState.emitMessage).content as string;
      expect(content).toContain('Forwarded body text');
    });

    it('should show fallback message when no content available', async () => {
      const { handler } = createHandler();
      await handler.handleMessageReceive(shareChatEvent({}));

      const content = firstCallArg(mockState.emitMessage).content as string;
      expect(content).toContain('无法解析内容');
    });

    it('should extract sender name from object format', async () => {
      const { handler } = createHandler();
      await handler.handleMessageReceive(shareChatEvent({
        chat_history: [
          { sender: { name: 'Charlie' }, content: 'test' },
        ],
      }));

      const content = firstCallArg(mockState.emitMessage).content as string;
      expect(content).toContain('Charlie');
    });

    it('should format numeric timestamps as time strings', async () => {
      const { handler } = createHandler();
      const ts = 1704067200; // 2024-01-01T00:00:00Z (seconds)

      await handler.handleMessageReceive(shareChatEvent({
        chat_history: [
          { sender: 'Alice', content: 'Hello', create_time: ts },
        ],
      }));

      const content = firstCallArg(mockState.emitMessage).content as string;
      expect(content).toContain('Alice');
    });
  });

  // -----------------------------------------------------------------------
  // Interactive card messages (Issue #3657)
  // -----------------------------------------------------------------------
  describe('handleMessageReceive — interactive card messages', () => {
    function interactiveEvent(card: Record<string, unknown>) {
      return {
        event: {
          message: {
            message_id: 'msg_interactive',
            chat_id: 'chat_001',
            chat_type: 'p2p',
            content: JSON.stringify(card),
            message_type: 'interactive',
            create_time: Date.now(),
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      } as any;
    }

    it('should emit interactive card message with extracted content', async () => {
      const { handler } = createHandler();
      await handler.handleMessageReceive(interactiveEvent({
        header: { title: { content: '搜索结果' } },
        elements: [
          { tag: 'markdown', content: '找到 3 条结果' },
        ],
      }));

      expect(mockState.emitMessage).toHaveBeenCalledTimes(1);
      const msg = firstCallArg(mockState.emitMessage);
      expect(msg.messageType).toBe('interactive');
      expect(msg.content).toBe('Mocked full card content');
    });

    it('should skip interactive card that extracts to empty content', async () => {
      // Reset and set mock to return empty
      const { extractFullCardContent } = await import('../../platforms/feishu/card-builders/card-text-extractor.js');
      vi.mocked(extractFullCardContent).mockReturnValueOnce('');

      const { handler } = createHandler();
      await handler.handleMessageReceive(interactiveEvent({}));

      expect(mockState.emitMessage).not.toHaveBeenCalled();
    });

    it('should not skip interactive card that extracts to [Interactive Card]', async () => {
      // Even when card is generic, it should still be emitted
      const { handler } = createHandler();
      await handler.handleMessageReceive(interactiveEvent({ elements: [] }));

      expect(mockState.emitMessage).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // Group chat trigger mode
  // -----------------------------------------------------------------------
  describe('handleMessageReceive — group chat trigger mode', () => {
    function groupTextEvent(text: string) {
      return {
        event: {
          message: {
            message_id: 'msg_group',
            chat_id: 'chat_group',
            chat_type: 'group',
            content: JSON.stringify({ text }),
            message_type: 'text',
            create_time: Date.now(),
            mentions: undefined,
            parent_id: undefined,
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      } as any;
    }

    it('should skip group messages without @mention when trigger mode disabled', async () => {
      mockState.isBotMentioned = false;
      const { handler } = createHandler();
      await handler.handleMessageReceive(groupTextEvent('Hello'));
      expect(mockState.emitMessage).not.toHaveBeenCalled();
    });

    it('should process group messages with @mention', async () => {
      mockState.isBotMentioned = true;
      const { handler } = createHandler();
      await handler.handleMessageReceive(groupTextEvent('@bot Hello'));
      expect(mockState.emitMessage).toHaveBeenCalledTimes(1);
    });

    it('should process group messages when trigger mode enabled', async () => {
      mockState.isBotMentioned = false;
      const { handler, triggerModeManager } = createHandler();
      triggerModeManager.setTriggerEnabled('chat_group', true);

      await handler.handleMessageReceive(groupTextEvent('Hello'));
      expect(mockState.emitMessage).toHaveBeenCalledTimes(1);
    });

    it('should process /trigger command in group chat without @mention', async () => {
      mockState.isBotMentioned = false;
      const { handler } = createHandler();
      handler.setControlHandler(true);
      mockState.emitControl.mockResolvedValue({ success: true, message: 'Trigger enabled' });

      await handler.handleMessageReceive(groupTextEvent('/trigger'));
      expect(mockState.emitControl).toHaveBeenCalledTimes(1);
    });

    it('should process small group messages (auto-detected)', async () => {
      mockState.isBotMentioned = false;
      const { handler, triggerModeManager } = createHandler();
      triggerModeManager.markAsSmallGroup('chat_group');

      await handler.handleMessageReceive(groupTextEvent('Hello'));
      expect(mockState.emitMessage).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // Command handling
  // -----------------------------------------------------------------------
  describe('handleMessageReceive — commands', () => {
    it('should handle /reset command without control handler', async () => {
      mockState.hasControlHandler = false;
      const { handler } = createHandler();
      await handler.handleMessageReceive(textEvent('/reset'));

      expect(mockState.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('重置') }),
      );
    });

    it('should handle /status command without control handler', async () => {
      mockState.hasControlHandler = false;
      const { handler } = createHandler();
      await handler.handleMessageReceive(textEvent('/status'));

      expect(mockState.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('状态') }),
      );
    });

    it('should handle /stop command without control handler', async () => {
      mockState.hasControlHandler = false;
      const { handler } = createHandler();
      await handler.handleMessageReceive(textEvent('/stop'));

      expect(mockState.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('停止') }),
      );
    });

    it('should delegate to control handler when available', async () => {
      mockState.hasControlHandler = true;
      mockState.emitControl.mockResolvedValue({ success: true, message: 'Done' });
      const { handler } = createHandler();
      handler.setControlHandler(true);
      await handler.handleMessageReceive(textEvent('/debug'));

      expect(mockState.emitControl).toHaveBeenCalledTimes(1);
      const cmd = firstCallArg(mockState.emitControl);
      expect(cmd.type).toBe('debug');
    });

    it('should relay control handler error messages', async () => {
      mockState.hasControlHandler = true;
      mockState.emitControl.mockResolvedValue({ success: false, message: 'Unknown command' });
      const { handler } = createHandler();
      handler.setControlHandler(true);
      await handler.handleMessageReceive(textEvent('/unknown'));

      expect(mockState.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Unknown command' }),
      );
    });

    it('should fall through when control handler returns no success and no message', async () => {
      mockState.hasControlHandler = true;
      mockState.emitControl.mockResolvedValue({ success: false });
      const { handler } = createHandler();
      handler.setControlHandler(true);
      await handler.handleMessageReceive(textEvent('/reset'));

      // Falls through to default /reset handler
      expect(mockState.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('重置') }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // File/image message handling
  // -----------------------------------------------------------------------
  describe('handleMessageReceive — file/image messages', () => {
    function fileEvent(messageType: string, content: Record<string, unknown>) {
      return {
        event: {
          message: {
            message_id: 'msg_file',
            chat_id: 'chat_001',
            chat_type: 'p2p',
            content: JSON.stringify(content),
            message_type: messageType,
            create_time: Date.now(),
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      } as any;
    }

    it('should skip file messages without file_key', async () => {
      const { handler } = createHandler();
      await handler.handleMessageReceive(fileEvent('file', {}));
      expect(mockState.emitMessage).not.toHaveBeenCalled();
    });

    it('should handle image messages without client (no download)', async () => {
      const { handler } = createHandler();
      // No client initialized — cannot download
      await handler.handleMessageReceive(fileEvent('image', { image_key: 'img_001' }));

      expect(mockState.emitMessage).toHaveBeenCalledTimes(1);
      const msg = firstCallArg(mockState.emitMessage);
      expect(msg.messageType).toBe('file');
      expect(msg.content).toContain('下载失败');
    });

    it('should emit correct message type for audio messages', async () => {
      const { handler } = createHandler();
      await handler.handleMessageReceive(fileEvent('audio', { file_key: 'audio_001' }));

      expect(mockState.emitMessage).toHaveBeenCalledTimes(1);
      const msg = firstCallArg(mockState.emitMessage);
      expect(msg.messageType).toBe('audio');
    });

    it('should use file message type for non-audio file messages', async () => {
      const { handler } = createHandler();
      await handler.handleMessageReceive(fileEvent('file', { file_key: 'file_001', file_name: 'doc.pdf' }));

      expect(mockState.emitMessage).toHaveBeenCalledTimes(1);
      const msg = firstCallArg(mockState.emitMessage);
      expect(msg.messageType).toBe('file');
    });
  });

  // -----------------------------------------------------------------------
  // Card action handling
  // -----------------------------------------------------------------------
  describe('handleCardAction', () => {
    it('should skip card actions when handler is not running', async () => {
      mockState.isRunning = false;
      const { handler } = createHandler();
      await handler.handleCardAction(cardActionEvent());
      expect(mockState.emitMessage).not.toHaveBeenCalled();
    });

    it('should skip card actions with missing fields', async () => {
      const { handler } = createHandler();
      await handler.handleCardAction({}); // No context, operator, or action
      expect(mockState.emitMessage).not.toHaveBeenCalled();
    });

    it('should send user confirmation on card action', async () => {
      const { handler } = createHandler();
      await handler.handleCardAction(cardActionEvent());

      expect(mockState.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Click me'),
        }),
      );
    });

    it('should use action.value as fallback for button text', async () => {
      const { handler } = createHandler();
      await handler.handleCardAction({
        context: { open_message_id: 'card_msg', open_chat_id: 'chat_001' },
        operator: { open_id: 'user_001' },
        action: { tag: 'button', value: 'val_no_text' },
      });

      expect(mockState.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('val_no_text'),
        }),
      );
    });

    it('should route card action to Worker Node when available', async () => {
      mockState.routeCardAction.mockResolvedValue({ routed: true });
      const { handler } = createHandler();
      await handler.handleCardAction(cardActionEvent());

      expect(mockState.routeCardAction).toHaveBeenCalledTimes(1);
      // Should NOT emit local message when routed
      expect(mockState.emitMessage).not.toHaveBeenCalled();
    });

    it('should notify user when card context is expired', async () => {
      mockState.routeCardAction.mockResolvedValue({ routed: false, expired: true });
      const { handler } = createHandler();
      await handler.handleCardAction(cardActionEvent());

      expect(mockState.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('超时') }),
      );
    });

    it('should emit local message when routeCardAction returns not routed', async () => {
      mockState.routeCardAction.mockResolvedValue({ routed: false });
      const { handler } = createHandler();
      await handler.handleCardAction(cardActionEvent());

      expect(mockState.emitMessage).toHaveBeenCalledTimes(1);
      const msg = firstCallArg(mockState.emitMessage);
      expect(msg.messageType).toBe('card');
      expect(msg.chatId).toBe('chat_001');
    });

    it('should resolve action prompt from template', async () => {
      mockState.routeCardAction.mockResolvedValue({ routed: false });
      mockState.resolveActionPrompt.mockReturnValue('Resolved prompt text');
      const { handler } = createHandler();
      await handler.handleCardAction(cardActionEvent());

      const msg = firstCallArg(mockState.emitMessage);
      expect(msg.content).toBe('Resolved prompt text');
    });

    it('should fall back to default message when no prompt template', async () => {
      mockState.routeCardAction.mockResolvedValue({ routed: false });
      mockState.resolveActionPrompt.mockReturnValue(undefined);
      const { handler } = createHandler();
      await handler.handleCardAction(cardActionEvent());

      const msg = firstCallArg(mockState.emitMessage);
      expect(msg.content).toContain('用户点击了按钮');
    });

    it('should handle resolveActionPrompt throwing an error', async () => {
      mockState.routeCardAction.mockResolvedValue({ routed: false });
      mockState.resolveActionPrompt.mockImplementation(() => {
        throw new Error('Template error');
      });
      const { handler } = createHandler();
      await handler.handleCardAction(cardActionEvent());

      const msg = firstCallArg(mockState.emitMessage);
      expect(msg.content).toContain('用户点击了按钮');
    });

    it('should call InteractionManager.handleAction', async () => {
      const { handler } = createHandler();
      await handler.handleCardAction(cardActionEvent());

      expect(mockState.interactionHandleAction).toHaveBeenCalledTimes(1);
    });

    it('should pass card action metadata in emitted message', async () => {
      mockState.routeCardAction.mockResolvedValue({ routed: false });
      const { handler } = createHandler();
      await handler.handleCardAction(cardActionEvent());

      const msg = firstCallArg(mockState.emitMessage);
      expect(msg.metadata).toBeDefined();
      expect(msg.metadata.cardAction).toBeDefined();
      expect(msg.metadata.cardAction.value).toBe('action_value');
    });

    it('should log card click event as incoming message for history', async () => {
      const { handler } = createHandler();
      await handler.handleCardAction(cardActionEvent());

      expect(mockState.logIncomingMessage).toHaveBeenCalledWith(
        expect.stringMatching(/^card_action_card_msg_001_\d+$/),
        'user_001',
        'chat_001',
        '用户点击了按钮「Click me」',
        'card_action',
      );
    });

    it('should log card click with action.value fallback when text is missing', async () => {
      const { handler } = createHandler();
      await handler.handleCardAction({
        context: { open_message_id: 'card_msg', open_chat_id: 'chat_001' },
        operator: { open_id: 'user_001' },
        action: { tag: 'button', value: 'fallback_val' },
      });

      expect(mockState.logIncomingMessage).toHaveBeenCalledWith(
        expect.stringMatching(/^card_action_card_msg_\d+$/),
        'user_001',
        'chat_001',
        '用户点击了按钮「fallback_val」',
        'card_action',
      );
    });
  });

  // -----------------------------------------------------------------------
  // Quoted message context
  // -----------------------------------------------------------------------
  describe('handleMessageReceive — quoted message context', () => {
    it('should not include metadata when parent_id exists but client is not initialized', async () => {
      const { handler } = createHandler();
      const event = textEvent('Reply', {
        event: {
          message: {
            message_id: 'msg_reply',
            chat_id: 'chat_001',
            chat_type: 'p2p',
            content: JSON.stringify({ text: 'Reply' }),
            message_type: 'text',
            create_time: Date.now(),
            parent_id: 'msg_parent',
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      });

      await handler.handleMessageReceive(event);

      expect(mockState.emitMessage).toHaveBeenCalledTimes(1);
      const msg = firstCallArg(mockState.emitMessage);
      // Without client, quoted message context is undefined → only chatType in metadata
      expect(msg.metadata?.quotedMessage).toBeUndefined();
      expect(msg.metadata?.chatType).toBe('p2p');
    });
  });

  // -----------------------------------------------------------------------
  // Chat history context for trigger mode
  // -----------------------------------------------------------------------
  describe('handleMessageReceive — chat history context', () => {
    it('should fetch chat history for group chat @mention messages', async () => {
      mockState.isBotMentioned = true;
      const { handler } = createHandler();

      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'msg_hist',
            chat_id: 'chat_group',
            chat_type: 'group',
            content: JSON.stringify({ text: '@bot hello' }),
            message_type: 'text',
            create_time: Date.now(),
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      });

      expect(mockState.getChatHistory).toHaveBeenCalledWith('chat_group');
    });

    it('should not fetch chat history for p2p messages', async () => {
      const { handler } = createHandler();
      await handler.handleMessageReceive(textEvent('hello'));
      expect(mockState.getChatHistory).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // extractOpenId — tested indirectly through message events
  // -----------------------------------------------------------------------
  describe('extractOpenId (via emitted messages)', () => {
    it('should extract open_id from object sender_id', async () => {
      const { handler } = createHandler();
      await handler.handleMessageReceive(textEvent('Test'));
      expect(firstCallArg(mockState.emitMessage).userId).toBe('user_001');
    });

    it('should extract open_id from string sender_id', async () => {
      const { handler } = createHandler();
      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'msg_str',
            chat_id: 'chat_001',
            chat_type: 'p2p',
            content: JSON.stringify({ text: 'Hi' }),
            message_type: 'text',
            create_time: Date.now(),
          },
          sender: { sender_type: 'user', sender_id: 'string_id_123' } as any,
        },
      });
      expect(firstCallArg(mockState.emitMessage).userId).toBe('string_id_123');
    });

    it('should handle missing sender_id', async () => {
      const { handler } = createHandler();
      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'msg_no_sender',
            chat_id: 'chat_001',
            chat_type: 'p2p',
            content: JSON.stringify({ text: 'Hi' }),
            message_type: 'text',
            create_time: Date.now(),
          },
          sender: {},
        },
      });
      expect(firstCallArg(mockState.emitMessage).userId).toBeUndefined();
    });

    it('should handle missing sender entirely', async () => {
      const { handler } = createHandler();
      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'msg_no_sender_obj',
            chat_id: 'chat_001',
            chat_type: 'p2p',
            content: JSON.stringify({ text: 'Hi' }),
            message_type: 'text',
            create_time: Date.now(),
          },
          sender: {} as any,
        },
      });
      expect(firstCallArg(mockState.emitMessage).userId).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // checkAndAutoDisableSmallGroup
  // -----------------------------------------------------------------------
  describe('checkAndAutoDisableSmallGroup', () => {
    it('should mark as small group when total members ≤ 2', async () => {
      const { handler, triggerModeManager } = createHandler();
      const mockClient = {
        im: {
          chat: {
            get: vi.fn().mockResolvedValue({
              data: { user_count: '1', bot_count: '1' },
            }),
          },
        },
      };
      handler.initialize(mockClient as any);

      // Send a group message without @mention
      mockState.isBotMentioned = false;
      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'msg_auto_1',
            chat_id: 'chat_small',
            chat_type: 'group',
            content: JSON.stringify({ text: 'Hello' }),
            message_type: 'text',
            create_time: Date.now(),
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      });

      expect(triggerModeManager.isTriggerEnabled('chat_small')).toBe(true);
    });

    it('should not mark as small group when total members > 2', async () => {
      const { handler, triggerModeManager } = createHandler();
      const mockClient = {
        im: {
          chat: {
            get: vi.fn().mockResolvedValue({
              data: { user_count: '3', bot_count: '1' },
            }),
          },
        },
      };
      handler.initialize(mockClient as any);

      mockState.isBotMentioned = false;
      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'msg_auto_2',
            chat_id: 'chat_large',
            chat_type: 'group',
            content: JSON.stringify({ text: 'Hello' }),
            message_type: 'text',
            create_time: Date.now(),
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      });

      expect(triggerModeManager.isTriggerEnabled('chat_large')).toBe(false);
      expect(mockState.emitMessage).not.toHaveBeenCalled();
    });

    it('should handle API error gracefully without blocking', async () => {
      const { handler, triggerModeManager } = createHandler();
      const mockClient = {
        im: {
          chat: {
            get: vi.fn().mockRejectedValue(new Error('API error')),
          },
        },
      };
      handler.initialize(mockClient as any);

      mockState.isBotMentioned = false;
      // Should not throw
      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'msg_auto_err',
            chat_id: 'chat_api_err',
            chat_type: 'group',
            content: JSON.stringify({ text: 'Hello' }),
            message_type: 'text',
            create_time: Date.now(),
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      });

      expect(triggerModeManager.isTriggerEnabled('chat_api_err')).toBe(false);
    });

    it('should skip auto-detection when client is not initialized', async () => {
      const { handler, triggerModeManager } = createHandler();
      // No client initialized

      mockState.isBotMentioned = false;
      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'msg_auto_noclient',
            chat_id: 'chat_noclient',
            chat_type: 'group',
            content: JSON.stringify({ text: 'Hello' }),
            message_type: 'text',
            create_time: Date.now(),
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      });

      expect(triggerModeManager.isTriggerEnabled('chat_noclient')).toBe(false);
    });

    // Issue #3592: Small group should be unmarked when group grows beyond 2 members
    it('should unmark small group when group grows beyond 2 members', async () => {
      const { handler, triggerModeManager } = createHandler();
      const mockClient = {
        im: {
          chat: {
            get: vi.fn()
              // First call: 2 members (small group)
              .mockResolvedValueOnce({ data: { user_count: '1', bot_count: '1' } })
              // Second call: 3 members (group grew)
              .mockResolvedValueOnce({ data: { user_count: '2', bot_count: '1' } }),
          },
        },
      };
      handler.initialize(mockClient as any);

      // First message: should be marked as small group
      mockState.isBotMentioned = false;
      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'msg_grow_1',
            chat_id: 'chat_growing',
            chat_type: 'group',
            content: JSON.stringify({ text: 'Hello' }),
            message_type: 'text',
            create_time: Date.now(),
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      });
      expect(triggerModeManager.isTriggerEnabled('chat_growing')).toBe(true);
      expect(triggerModeManager.isSmallGroup('chat_growing')).toBe(true);
      // Message should be processed (trigger enabled)
      expect(mockState.emitMessage).toHaveBeenCalledTimes(1);
      mockState.emitMessage.mockClear();

      // Backdate the check time so recheck is allowed
      (triggerModeManager as any).lastSmallGroupCheck.set('chat_growing', Date.now() - 11 * 60 * 1000);

      // Second message: group grew to 3 members — should unmark
      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'msg_grow_2',
            chat_id: 'chat_growing',
            chat_type: 'group',
            content: JSON.stringify({ text: 'Hello again' }),
            message_type: 'text',
            create_time: Date.now(),
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      });
      expect(triggerModeManager.isSmallGroup('chat_growing')).toBe(false);
      expect(triggerModeManager.isTriggerEnabled('chat_growing')).toBe(false);
      // Message should be skipped (trigger disabled)
      expect(mockState.emitMessage).not.toHaveBeenCalled();
    });

    // Issue #3592: Throttled re-check should not call API within cooldown
    it('should not recheck small group status within cooldown', async () => {
      const { handler, triggerModeManager } = createHandler();
      const mockClient = {
        im: {
          chat: {
            get: vi.fn().mockResolvedValue({
              data: { user_count: '1', bot_count: '1' },
            }),
          },
        },
      };
      handler.initialize(mockClient as any);

      // First message: marks as small group and records check time
      mockState.isBotMentioned = false;
      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'msg_throttle_1',
            chat_id: 'chat_throttle',
            chat_type: 'group',
            content: JSON.stringify({ text: 'Hello' }),
            message_type: 'text',
            create_time: Date.now(),
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      });
      expect(mockClient.im.chat.get).toHaveBeenCalledTimes(1);
      expect(triggerModeManager.isTriggerEnabled('chat_throttle')).toBe(true);

      // Second message: within cooldown, should NOT recheck
      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'msg_throttle_2',
            chat_id: 'chat_throttle',
            chat_type: 'group',
            content: JSON.stringify({ text: 'Hello again' }),
            message_type: 'text',
            create_time: Date.now(),
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      });
      // API should NOT have been called again
      expect(mockClient.im.chat.get).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // addTypingReaction with client
  // -----------------------------------------------------------------------
  describe('addTypingReaction (via handleMessageReceive)', () => {
    it('should add typing reaction when client is available', async () => {
      const mockCreate = vi.fn().mockResolvedValue({});
      const mockClient = {
        im: {
          messageReaction: { create: mockCreate },
          chat: { get: vi.fn().mockResolvedValue({ data: { user_count: '3', bot_count: '1' } }) },
        },
      };
      const { handler } = createHandler();
      handler.initialize(mockClient as any);

      await handler.handleMessageReceive(textEvent('Hello'));

      expect(mockCreate).toHaveBeenCalledWith({
        path: { message_id: 'msg_001' },
        data: { reaction_type: { emoji_type: 'Typing' } },
      });
    });
  });

  // -----------------------------------------------------------------------
  // File download with client
  // -----------------------------------------------------------------------
  describe('handleMessageReceive — file download with client', () => {
    it('should download file when client is available', async () => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result?: { stdout: string; stderr: string }) => void;
        callback(null, { stdout: 'download ok', stderr: '' });
      });

      const mockClient = {
        im: {
          message: {
            create: vi.fn().mockResolvedValue({ data: {} }),
          },
        },
      };

      const { handler } = createHandler();
      handler.initialize(mockClient as any);

      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'msg_dl',
            chat_id: 'chat_001',
            chat_type: 'p2p',
            content: JSON.stringify({ image_key: 'img_001' }),
            message_type: 'image',
            create_time: Date.now(),
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      });

      expect(mockExecFile).toHaveBeenCalledWith(
        'npx',
        expect.arrayContaining(['@larksuite/cli', 'im', '+resource-download']),
        expect.objectContaining({ timeout: 120_000 }),
        expect.any(Function),
      );

      expect(mockState.emitMessage).toHaveBeenCalledTimes(1);
      const msg = firstCallArg(mockState.emitMessage);
      expect(msg.content).toContain('文件已下载到本地');
      expect(msg.content).toContain('+resource-download');
      expect(msg.content).toContain('msg_dl');
      expect(msg.content).toContain('img_001');
      expect(msg.attachments).toBeDefined();
      expect(msg.attachments[0].fileName).toContain('image_img_001');
    });

    it('should handle download failure gracefully', async () => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null) => void;
        callback(new Error('lark-cli not found'));
      });

      const mockClient = {
        im: {
          message: {
            create: vi.fn().mockResolvedValue({ data: {} }),
          },
        },
      };

      const { handler } = createHandler();
      handler.initialize(mockClient as any);

      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'msg_dl_fail',
            chat_id: 'chat_001',
            chat_type: 'p2p',
            content: JSON.stringify({ image_key: 'img_fail' }),
            message_type: 'image',
            create_time: Date.now(),
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      });

      expect(mockState.emitMessage).toHaveBeenCalledTimes(1);
      const msg = firstCallArg(mockState.emitMessage);
      expect(msg.content).toContain('下载失败');
      expect(msg.content).toContain('img_fail');
      expect(msg.content).toContain('+resource-download');
      expect(msg.content).toContain('msg_dl_fail');
      expect(msg.attachments).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // getQuotedMessageContext with client
  // -----------------------------------------------------------------------
  describe('handleMessageReceive — quoted message with client', () => {
    it('should include quoted message context when client is available', async () => {
      const mockClient = {
        im: {
          message: {
            get: vi.fn().mockResolvedValue({
              data: {
                message: {
                  message_type: 'text',
                  content: JSON.stringify({ text: 'Quoted text' }),
                  message_id: 'msg_parent',
                },
              },
            }),
          },
        },
      };

      const { handler } = createHandler();
      handler.initialize(mockClient as any);

      await handler.handleMessageReceive(textEvent('Reply', {
        event: {
          message: {
            message_id: 'msg_reply_2',
            chat_id: 'chat_001',
            chat_type: 'p2p',
            content: JSON.stringify({ text: 'Reply' }),
            message_type: 'text',
            create_time: Date.now(),
            parent_id: 'msg_parent',
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      }));

      expect(mockState.emitMessage).toHaveBeenCalledTimes(1);
      const msg = firstCallArg(mockState.emitMessage);
      expect(msg.metadata).toBeDefined();
      expect(msg.metadata.quotedMessage).toContain('Quoted text');
    });

    it('should handle quoted post message', async () => {
      const mockClient = {
        im: {
          message: {
            get: vi.fn().mockResolvedValue({
              data: {
                message: {
                  message_type: 'post',
                  content: JSON.stringify({
                    content: [[{ tag: 'text', text: 'Bold post' }]],
                  }),
                  message_id: 'msg_parent_post',
                },
              },
            }),
          },
        },
      };

      const { handler } = createHandler();
      handler.initialize(mockClient as any);

      await handler.handleMessageReceive(textEvent('Reply', {
        event: {
          message: {
            message_id: 'msg_reply_post',
            chat_id: 'chat_001',
            chat_type: 'p2p',
            content: JSON.stringify({ text: 'Reply' }),
            message_type: 'text',
            create_time: Date.now(),
            parent_id: 'msg_parent_post',
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      }));

      const msg = firstCallArg(mockState.emitMessage);
      expect(msg.metadata.quotedMessage).toContain('Bold post');
    });
  });

  // -----------------------------------------------------------------------
  // Thread context for topic groups (Issue #3641 sub-problem 1)
  // -----------------------------------------------------------------------
  describe('handleMessageReceive — thread context for topic groups', () => {
    it('should fetch thread context in topic group when parent_id exists', async () => {
      mockState.isBotMentioned = true;
      // Mock responses: quoted message + thread chain (parent → root)
      const mockClient = {
        im: {
          message: {
            get: vi.fn()
              // 1st call: getQuotedMessageContext(parent_id) — fetches the immediate parent
              .mockResolvedValueOnce({
                data: {
                  message: {
                    message_type: 'text',
                    content: JSON.stringify({ text: 'First reply' }),
                    message_id: 'msg_parent',
                  },
                },
              })
              // 2nd call: getThreadContext(parent_id) — walks up from parent
              .mockResolvedValueOnce({
                data: {
                  message: {
                    message_type: 'text',
                    content: JSON.stringify({ text: 'First reply' }),
                    message_id: 'msg_parent',
                    parent_id: 'msg_root',
                    sender: { sender_type: 'user' },
                  },
                },
              })
              // 3rd call: getThreadContext continues to root
              .mockResolvedValueOnce({
                data: {
                  message: {
                    message_type: 'text',
                    content: JSON.stringify({ text: 'Root message' }),
                    message_id: 'msg_root',
                    parent_id: undefined,
                    sender: { sender_type: 'user' },
                  },
                },
              }),
          },
        },
      };

      const { handler } = createHandler();
      handler.initialize(mockClient as any);

      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'msg_current',
            chat_id: 'chat_topic',
            chat_type: 'topic',
            content: JSON.stringify({ text: 'My reply' }),
            message_type: 'text',
            create_time: Date.now(),
            parent_id: 'msg_parent',
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      });

      expect(mockState.emitMessage).toHaveBeenCalledTimes(1);
      const msg = firstCallArg(mockState.emitMessage);
      expect(msg.metadata).toBeDefined();
      expect(msg.metadata.threadContext).toBeDefined();
      // Should contain both messages in chronological order (root first)
      expect(msg.metadata.threadContext).toContain('Root message');
      expect(msg.metadata.threadContext).toContain('First reply');
      // Root should appear before first reply (chronological order)
      const rootIdx = msg.metadata.threadContext.indexOf('Root message');
      const replyIdx = msg.metadata.threadContext.indexOf('First reply');
      expect(rootIdx).toBeLessThan(replyIdx);
      // Issue #3989: topic groups should NOT get flat chat history
      expect(msg.metadata.chatHistoryContext).toBeUndefined();
    });

    it('should not fetch thread context for non-topic groups', async () => {
      mockState.isBotMentioned = true;
      const mockClient = {
        im: {
          message: {
            get: vi.fn().mockResolvedValue({
              data: {
                message: {
                  message_type: 'text',
                  content: JSON.stringify({ text: 'Parent' }),
                  message_id: 'msg_parent',
                },
              },
            }),
          },
        },
      };

      const { handler } = createHandler();
      handler.initialize(mockClient as any);

      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'msg_current',
            chat_id: 'chat_group',
            chat_type: 'group',
            content: JSON.stringify({ text: 'My reply' }),
            message_type: 'text',
            create_time: Date.now(),
            parent_id: 'msg_parent',
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      });

      const msg = firstCallArg(mockState.emitMessage);
      expect(msg.metadata?.threadContext).toBeUndefined();
    });

    it('should not fetch thread context when no parent_id', async () => {
      mockState.isBotMentioned = true;
      const { handler } = createHandler();

      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'msg_current',
            chat_id: 'chat_topic',
            chat_type: 'topic',
            content: JSON.stringify({ text: 'New topic' }),
            message_type: 'text',
            create_time: Date.now(),
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      });

      const msg = firstCallArg(mockState.emitMessage);
      expect(msg.metadata?.threadContext).toBeUndefined();
    });

    it('should not fetch thread context without client', async () => {
      mockState.isBotMentioned = true;
      const { handler } = createHandler();

      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'msg_current',
            chat_id: 'chat_topic',
            chat_type: 'topic',
            content: JSON.stringify({ text: 'Reply' }),
            message_type: 'text',
            create_time: Date.now(),
            parent_id: 'msg_parent',
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      });

      const msg = firstCallArg(mockState.emitMessage);
      expect(msg.metadata?.threadContext).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // handleCardAction error paths
  // -----------------------------------------------------------------------
  describe('handleCardAction — error paths', () => {
    it('should notify user when emitMessage throws', async () => {
      mockState.emitMessage.mockRejectedValueOnce(new Error('Emit failed'));
      const { handler } = createHandler();

      await handler.handleCardAction(cardActionEvent());

      // Should still attempt to send error notification
      expect(mockState.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('错误') }),
      );
    });

    it('should skip InteractionManager when emitMessage fails (no double notification)', async () => {
      mockState.emitMessage.mockRejectedValueOnce(new Error('Emit failed'));
      mockState.interactionHandleAction.mockRejectedValueOnce(new Error('Interaction error'));
      const { handler } = createHandler();

      await handler.handleCardAction(cardActionEvent());

      // InteractionManager should NOT be called when emit already failed
      expect(mockState.interactionHandleAction).not.toHaveBeenCalled();
      // Only ONE error notification should be sent (not two)
      const errorCalls = mockState.sendMessage.mock.calls.filter(
        (call: any[]) => call[0]?.text?.includes('错误'),
      );
      expect(errorCalls).toHaveLength(1);
    });

    it('should send error message when InteractionManager throws', async () => {
      mockState.interactionHandleAction.mockRejectedValueOnce(new Error('Interaction error'));
      const { handler } = createHandler();

      await handler.handleCardAction(cardActionEvent());

      expect(mockState.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('Interaction error') }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Media message type
  // -----------------------------------------------------------------------
  describe('handleMessageReceive — media messages', () => {
    it('should handle media message type like file', async () => {
      const { handler } = createHandler();
      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'msg_media',
            chat_id: 'chat_001',
            chat_type: 'p2p',
            content: JSON.stringify({ file_key: 'media_001', file_name: 'video.mp4' }),
            message_type: 'media',
            create_time: Date.now(),
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      });

      expect(mockState.emitMessage).toHaveBeenCalledTimes(1);
      const msg = firstCallArg(mockState.emitMessage);
      expect(msg.messageType).toBe('file');
    });
  });

  // -----------------------------------------------------------------------
  // File/image message metadata in topic groups (PR #3704)
  // -----------------------------------------------------------------------
  describe('handleMessageReceive — file metadata in topic groups', () => {
    it('should pass chatType metadata for file messages in topic group', async () => {
      const { handler } = createHandler();
      mockState.isBotMentioned = true;
      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'msg_file_topic',
            chat_id: 'chat_topic',
            chat_type: 'topic',
            content: JSON.stringify({ file_key: 'file_001', file_name: 'doc.pdf' }),
            message_type: 'file',
            create_time: Date.now(),
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      });

      expect(mockState.emitMessage).toHaveBeenCalledTimes(1);
      const msg = firstCallArg(mockState.emitMessage);
      expect(msg.metadata).toBeDefined();
      expect(msg.metadata.chatType).toBe('topic');
    });

    it('should pass chatType metadata for image messages in topic group', async () => {
      const { handler } = createHandler();
      mockState.isBotMentioned = true;
      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'msg_img_topic',
            chat_id: 'chat_topic',
            chat_type: 'topic',
            content: JSON.stringify({ image_key: 'img_001' }),
            message_type: 'image',
            create_time: Date.now(),
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      });

      expect(mockState.emitMessage).toHaveBeenCalledTimes(1);
      const msg = firstCallArg(mockState.emitMessage);
      expect(msg.metadata).toBeDefined();
      expect(msg.metadata.chatType).toBe('topic');
    });

    it('should pass threadContext for file messages in topic group with parent_id', async () => {
      const mockClient = {
        im: {
          message: {
            get: vi.fn()
              // getThreadContext walks up: parent → root
              .mockResolvedValueOnce({
                data: {
                  message: {
                    message_type: 'text',
                    content: JSON.stringify({ text: 'Reply in thread' }),
                    message_id: 'msg_parent',
                    parent_id: 'msg_root',
                    sender: { sender_type: 'user' },
                  },
                },
              })
              .mockResolvedValueOnce({
                data: {
                  message: {
                    message_type: 'text',
                    content: JSON.stringify({ text: 'Root message' }),
                    message_id: 'msg_root',
                    parent_id: undefined,
                    sender: { sender_type: 'user' },
                  },
                },
              }),
          },
        },
      };

      const { handler } = createHandler();
      handler.initialize(mockClient as any);
      mockState.isBotMentioned = true;

      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'msg_file_thread',
            chat_id: 'chat_topic',
            chat_type: 'topic',
            content: JSON.stringify({ file_key: 'file_001', file_name: 'doc.pdf' }),
            message_type: 'file',
            create_time: Date.now(),
            parent_id: 'msg_parent',
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      });

      expect(mockState.emitMessage).toHaveBeenCalledTimes(1);
      const msg = firstCallArg(mockState.emitMessage);
      expect(msg.metadata).toBeDefined();
      expect(msg.metadata.chatType).toBe('topic');
      expect(msg.metadata.threadContext).toBeDefined();
      expect(msg.metadata.threadContext).toContain('Root message');
      expect(msg.metadata.threadContext).toContain('Reply in thread');
    });

    it('should pass chatType metadata for file messages in group chat', async () => {
      const { handler } = createHandler();
      mockState.isBotMentioned = true;
      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'msg_file_group',
            chat_id: 'chat_group',
            chat_type: 'group',
            content: JSON.stringify({ file_key: 'file_001', file_name: 'doc.pdf' }),
            message_type: 'file',
            create_time: Date.now(),
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      });

      expect(mockState.emitMessage).toHaveBeenCalledTimes(1);
      const msg = firstCallArg(mockState.emitMessage);
      expect(msg.metadata).toBeDefined();
      expect(msg.metadata.chatType).toBe('group');
      // group chat should NOT have threadContext even with chat_type set
      expect(msg.metadata.threadContext).toBeUndefined();
    });

    it('should set chatType but not threadContext for p2p file messages', async () => {
      const { handler } = createHandler();
      await handler.handleMessageReceive({
        event: {
          message: {
            message_id: 'msg_file_p2p',
            chat_id: 'chat_p2p',
            chat_type: 'p2p',
            content: JSON.stringify({ file_key: 'file_001', file_name: 'doc.pdf' }),
            message_type: 'file',
            create_time: Date.now(),
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      });

      expect(mockState.emitMessage).toHaveBeenCalledTimes(1);
      const msg = firstCallArg(mockState.emitMessage);
      expect(msg.metadata).toBeDefined();
      expect(msg.metadata.chatType).toBe('p2p');
      expect(msg.metadata.threadContext).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Topic group chat detection
  // -----------------------------------------------------------------------
  describe('handleMessageReceive — topic chat type', () => {
    it('should treat topic chats like group chats for trigger mode', async () => {
      mockState.isBotMentioned = false;
      const { handler } = createHandler();
      await handler.handleMessageReceive(textEvent('Hello', {
        event: {
          message: {
            message_id: 'msg_topic',
            chat_id: 'chat_topic',
            chat_type: 'topic',
            content: JSON.stringify({ text: 'Hello' }),
            message_type: 'text',
            create_time: Date.now(),
          },
          sender: { sender_type: 'user', sender_id: { open_id: 'user_001' } },
        },
      }));
      // topic chat should behave like group chat — skip without @mention
      expect(mockState.emitMessage).not.toHaveBeenCalled();
    });
  });
});
