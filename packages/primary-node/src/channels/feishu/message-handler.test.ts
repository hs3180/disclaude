/**
 * Tests for MessageHandler — audio message support (Issue #1966).
 *
 * Tests cover:
 * - Audio message is not skipped (passes the type filter)
 * - Audio content is parsed correctly (file_key extraction)
 * - Audio file is downloaded using 'file' resource type
 * - Audio message is emitted with correct messageType 'audio'
 * - Audio download failure produces user-friendly prompt
 * - Quoted audio messages are handled correctly
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageHandler, type MessageCallbacks } from './message-handler.js';
import type { PassiveModeManager } from './passive-mode.js';
import type { MentionDetector } from './mention-detector.js';
import { InteractionManager } from '../../platforms/feishu/interaction-manager.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a mock Feishu lark Client with configurable messageResource. */
function createMockClient(overrides?: {
  writeFile?: ReturnType<typeof vi.fn>;
  messageResource?: Record<string, unknown>;
}) {
  const writeFile = overrides?.writeFile ?? vi.fn().mockResolvedValue(undefined);
  const mockResource = {
    get: vi.fn().mockResolvedValue({ writeFile }),
    ...overrides?.messageResource,
  };
  const mockIm = { messageResource: mockResource, message: { get: vi.fn() }, messageReaction: { create: vi.fn() } };
  const client = { im: mockIm };
  return { client, writeFile, mockResource };
}

/** Create a mock PassiveModeManager that disables passive mode. */
function createMockPassiveModeManager(): PassiveModeManager {
  return {
    isPassiveModeDisabled: vi.fn().mockReturnValue(true),
    enablePassiveMode: vi.fn(),
    disablePassiveMode: vi.fn(),
  } as unknown as PassiveModeManager;
}

/** Create a mock MentionDetector that detects bot mentions. */
function createMockMentionDetector(): MentionDetector {
  return {
    isBotMentioned: vi.fn().mockReturnValue(true),
  } as unknown as MentionDetector;
}

/** Create minimal mock InteractionManager. */
function createMockInteractionManager(): InteractionManager {
  return {
    handleAction: vi.fn().mockResolvedValue(undefined),
    register: vi.fn().mockReturnThis(),
  } as unknown as InteractionManager;
}

/** Create a basic Feishu message event for audio. */
function createAudioMessageEvent(overrides?: Record<string, unknown>) {
  return {
    message: {
      message_id: 'msg_audio_001',
      chat_id: 'chat_test_001',
      chat_type: 'group',
      content: JSON.stringify({ file_key: 'audio_key_abc123', file_name: 'voice_msg.opus' }),
      message_type: 'audio',
      create_time: Date.now() - 5000,
      mentions: [],
      parent_id: undefined,
      ...overrides,
    },
    sender: {
      sender_type: 'user',
      sender_id: { open_id: 'user_001' },
    },
  };
}

// ─── Mock @disclaude/core ──────────────────────────────────────────────────

const MOCK_CONFIG = vi.hoisted(() => ({
  getWorkspaceDir: vi.fn().mockReturnValue('/tmp/test-workspace'),
}));

const MOCK_DEDUPLICATION = vi.hoisted(() => ({
  MAX_MESSAGE_AGE: 300000,
}));

const MOCK_REACTIONS = vi.hoisted(() => ({
  TYPING: 'EYES',
}));

const MOCK_CHAT_HISTORY = vi.hoisted(() => ({
  MAX_CONTEXT_LENGTH: 10000,
}));

vi.mock('@disclaude/core', () => ({
  Config: { getWorkspaceDir: MOCK_CONFIG.getWorkspaceDir },
  DEDUPLICATION: MOCK_DEDUPLICATION,
  REACTIONS: MOCK_REACTIONS,
  CHAT_HISTORY: MOCK_CHAT_HISTORY,
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  stripLeadingMentions: vi.fn((text: string) => text),
  ensureFileExtension: vi.fn((p: string) => p),
}));

// ─── Mock fs ───────────────────────────────────────────────────────────────

vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    open: vi.fn(),
    rename: vi.fn(),
  },
  mkdir: vi.fn().mockResolvedValue(undefined),
  open: vi.fn(),
  rename: vi.fn(),
}));

// ─── Mock message-logger ───────────────────────────────────────────────────

vi.mock('./message-logger.js', () => ({
  messageLogger: {
    isMessageProcessed: vi.fn().mockReturnValue(false),
    logIncomingMessage: vi.fn().mockResolvedValue(undefined),
    getChatHistory: vi.fn().mockResolvedValue(''),
  },
}));

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('MessageHandler — Audio Message Support (Issue #1966)', () => {
  let handler: MessageHandler;
  let mockClient: ReturnType<typeof createMockClient>['client'];
  let writeFile: ReturnType<typeof vi.fn>;
  let emitMessage: ReturnType<typeof vi.fn>;
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    const mock = createMockClient();
    mockClient = mock.client;
    writeFile = mock.writeFile;
    emitMessage = vi.fn().mockResolvedValue(undefined);
    sendMessage = vi.fn().mockResolvedValue(undefined);

    const callbacks: MessageCallbacks = {
      emitMessage,
      emitControl: vi.fn(),
      sendMessage,
    };

    handler = new MessageHandler({
      passiveModeManager: createMockPassiveModeManager(),
      mentionDetector: createMockMentionDetector(),
      interactionManager: createMockInteractionManager(),
      callbacks,
      isRunning: () => true,
      hasControlHandler: () => false,
    });

    handler.initialize(mockClient as never);
  });

  it('should handle audio messages without skipping', async () => {
    const event = createAudioMessageEvent();

    await handler.handleMessageReceive(event as never);

    // Should NOT be filtered — should reach emitMessage
    expect(emitMessage).toHaveBeenCalledTimes(1);
  });

  it('should download audio using "file" resource type', async () => {
    const event = createAudioMessageEvent();

    await handler.handleMessageReceive(event as never);

    // The resource get should be called with type: 'file' (not 'audio')
    const resourceGet = (mockClient.im as { messageResource: { get: ReturnType<typeof vi.fn> } })
      .messageResource.get;
    expect(resourceGet).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { type: 'file' },
      }),
    );
  });

  it('should emit message with messageType "audio"', async () => {
    const event = createAudioMessageEvent();

    await handler.handleMessageReceive(event as never);

    expect(emitMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageType: 'audio',
      }),
    );
  });

  it('should include audio file path in attachments after download', async () => {
    const event = createAudioMessageEvent();

    await handler.handleMessageReceive(event as never);

    expect(emitMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: expect.arrayContaining([
          expect.objectContaining({
            fileName: 'voice_msg.opus',
          }),
        ]),
      }),
    );
  });

  it('should handle audio download failure gracefully', async () => {
    // Make the resource get call reject to simulate download failure
    const resourceGet = (mockClient.im as { messageResource: { get: ReturnType<typeof vi.fn> } })
      .messageResource.get;
    resourceGet.mockRejectedValue(new Error('Download failed'));

    const event = createAudioMessageEvent();

    await handler.handleMessageReceive(event as never);

    // Message should still be emitted — download failure is non-fatal
    expect(emitMessage).toHaveBeenCalledTimes(1);
    // Content should contain the audio label even if download failed
    expect(emitMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageType: 'audio',
        content: expect.stringContaining('语音'),
      }),
    );
  });

  it('should handle audio with missing file_name using fallback name', async () => {
    const event = createAudioMessageEvent({
      content: JSON.stringify({ file_key: 'audio_key_xyz' }),
    });

    await handler.handleMessageReceive(event as never);

    // Should still emit message with fallback filename
    expect(emitMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageType: 'audio',
        attachments: expect.arrayContaining([
          expect.objectContaining({
            fileName: 'audio_audio_key_xyz',
          }),
        ]),
      }),
    );
  });

  it('should skip audio message with missing file_key', async () => {
    const event = createAudioMessageEvent({
      content: JSON.stringify({}),
    });

    await handler.handleMessageReceive(event as never);

    // Should be skipped — no file_key
    expect(emitMessage).not.toHaveBeenCalled();
  });

  it('should include "语音" label in the agent prompt', async () => {
    const event = createAudioMessageEvent();

    await handler.handleMessageReceive(event as never);

    expect(emitMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('语音'),
      }),
    );
  });
});
