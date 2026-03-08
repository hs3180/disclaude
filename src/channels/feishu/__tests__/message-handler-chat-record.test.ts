import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageHandler } from '../message-handler.js';
import type { FeishuEventData } from '../../../types/platform.js';

vi.mock('../../../services/index.js', () => ({
  getLarkClientService: vi.fn(() => ({
    getClient: vi.fn(() => ({})),
    getMessage: vi.fn(),
  })),
  isLarkClientServiceInitialized: vi.fn(() => true),
}));
vi.mock('../../../file-transfer/inbound/index.js', () => ({
  attachmentManager: { getAttachments: vi.fn(() => []) },
  downloadFile: vi.fn(),
}));
vi.mock('../../../feishu/message-logger.js', () => ({
  messageLogger: {
    isMessageProcessed: vi.fn(() => false),
    logIncomingMessage: vi.fn(),
  },
}));
vi.mock('../../../feishu/filtered-message-forwarder.js', () => ({
  filteredMessageForwarder: {
    setMessageSender: vi.fn(),
    forward: vi.fn(),
  },
}));
vi.mock('../../../platforms/feishu/feishu-file-handler.js', () => ({
  FeishuFileHandler: vi.fn(() => ({
    handleFileMessage: vi.fn(),
    buildUploadPrompt: vi.fn(),
  })),
}));
vi.mock('../../../platforms/feishu/feishu-message-sender.js', () => ({
  FeishuMessageSender: vi.fn(() => ({
    addReaction: vi.fn(),
    sendText: vi.fn(),
  })),
}));
vi.mock('../../../platforms/feishu/interaction-manager.js', () => ({
  InteractionManager: vi.fn(() => ({ handleAction: vi.fn() })),
}));
vi.mock('../../../ipc/unix-socket-client.js', () => ({
  getIpcClient: vi.fn(() => ({ isConnected: vi.fn(() => false) })),
}));

describe('MessageHandler - chat_record metadata', () => {
  let handler: MessageHandler;
  let emitMessageMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    emitMessageMock = vi.fn();
    const passiveModeManager = { isPassiveModeDisabled: vi.fn(() => false) } as unknown as { isPassiveModeDisabled: (chatId: string) => boolean };
    const mentionDetector = { isBotMentioned: vi.fn(() => false) } as unknown as { isBotMentioned: (mentions: unknown) => boolean };
    handler = new MessageHandler({
      appId: 'test-app-id', appSecret: 'test-app-secret', passiveModeManager, mentionDetector,
      interactionManager: {} as unknown as { handleAction: () => Promise<boolean> },
      callbacks: { emitMessage: emitMessageMock, emitControl: vi.fn(), sendMessage: vi.fn() },
      isRunning: () => true, hasControlHandler: () => false,
    });
    handler.initialize();
  });

  it('should include metadata with isChatRecord and messageCount', async () => {
    const chatRecordContent = JSON.stringify({
      messages: [
        { message_id: 'msg-1', message_type: 'text', content: JSON.stringify({ text: 'Hello A' }), create_time: 1704067200000, sender: { sender_id: { open_id: 'user_a' } } },
        { message_id: 'msg-2', message_type: 'text', content: JSON.stringify({ text: 'Hello B' }), create_time: 1704067260000, sender: { sender_id: { open_id: 'user_b' } } },
      ],
    });
    const eventData: FeishuEventData = {
      event: { message: { message_id: 'test-msg-id', chat_id: 'test-chat-id', chat_type: 'p2p', content: chatRecordContent, message_type: 'chat_record', create_time: Date.now() }, sender: { sender_type: 'user', sender_id: { open_id: 'sender-open-id' } } },
    };
    await handler.handleMessageReceive(eventData);
    expect(emitMessageMock).toHaveBeenCalledTimes(1);
    const callArgs = emitMessageMock.mock.calls[0][0];
    expect(callArgs.messageType).toBe('chat_record');
    expect(callArgs.metadata?.isChatRecord).toBe(true);
    expect(callArgs.metadata?.messageCount).toBe(2);
  });
});
