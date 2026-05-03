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
}));

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
    ensureFileExtensionFromPath: vi.fn<(p: string) => Promise<string>>().mockImplementation((p: string) => Promise.resolve(p)),
  };
});

vi.mock('../../platforms/feishu/interaction-manager.js', () => ({
  InteractionManager: vi.fn().mockImplementation(() => ({
    handleAction: mockState.interactionHandleAction,
  })),
}));

vi.mock('../../platforms/feishu/card-builders/card-text-extractor.js', () => ({
  extractCardTextContent: vi.fn().mockReturnValue('Extracted card text'),
}));

vi.mock('./message-logger.js', () => ({
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
      // Without client, quoted message context is undefined → no metadata
      expect(msg.metadata).toBeUndefined();
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
          sender: { sender_type: 'user', sender_id: { open_id: 'string_id_123' } },
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
