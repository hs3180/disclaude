/**
 * Tests for Pilot class (Issue #644: ChatId-bound Pilot).
 *
 * Key changes from Issue #644:
 * - Each Pilot is bound to a single chatId at construction time
 * - No SessionManager - each Pilot = one session
 * - AgentPool manages chatId → Pilot mapping
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Pilot, type PilotCallbacks } from './pilot.js';

// Mock the SDK to avoid unhandled errors
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn().mockReturnValue({
    async *[Symbol.asyncIterator]() {
      // Yield a simple message and end
      yield { type: 'text', content: 'Test response' };
    },
    close: vi.fn(),
    streamInput: vi.fn(() => Promise.resolve()),
  }),
  tool: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({})),
}));

// Mock config
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: vi.fn(() => '/test/workspace'),
    getAgentConfig: vi.fn(() => ({
      apiKey: 'test-key',
      model: 'test-model',
      provider: 'anthropic',
    })),
    getGlobalEnv: vi.fn(() => ({})),
    getMcpServersConfig: vi.fn(() => null),
    getLoggingConfig: vi.fn(() => ({
      level: 'info',
      pretty: true,
      rotate: false,
      sdkDebug: true,
    })),
  },
}));

// Mock utils
vi.mock('../utils/sdk.js', () => ({
  parseSDKMessage: vi.fn((msg) => ({
    type: msg.type || 'text',
    content: msg.content || '',
    metadata: {},
  })),
  buildSdkEnv: vi.fn(() => ({})),
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

describe('Pilot (Issue #644: ChatId-bound)', () => {
  let mockCallbacks: PilotCallbacks;
  let pilot: Pilot;
  const TEST_CHAT_ID = 'test-chat-123';

  beforeEach(() => {
    vi.useFakeTimers();
    mockCallbacks = {
      sendMessage: vi.fn(async () => {}),
      sendCard: vi.fn(async () => {}),
      sendFile: vi.fn(async () => {}),
    };
    pilot = new Pilot({
      apiKey: 'test-api-key',
      model: 'test-model',
      chatId: TEST_CHAT_ID,
      callbacks: mockCallbacks,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    pilot.shutdown().catch(() => {});
  });

  describe('Constructor', () => {
    it('should create Pilot instance with callbacks', () => {
      expect(pilot).toBeInstanceOf(Pilot);
    });

    it('should store callbacks', () => {
      expect(pilot['callbacks']).toBe(mockCallbacks);
    });

    it('should bind chatId at construction (Issue #644)', () => {
      expect(pilot.getChatId()).toBe(TEST_CHAT_ID);
    });

    it('should not have sessionManager (Issue #644)', () => {
      // sessionManager has been removed from Pilot
      // Each Pilot now handles a single chatId, so no session management needed
      expect(pilot.hasActiveSession()).toBe(false);
    });

    it('should initialize conversationOrchestrator', () => {
      expect(pilot['conversationOrchestrator']).toBeDefined();
    });

    it('should initialize restartManager', () => {
      expect(pilot['restartManager']).toBeDefined();
    });
  });

  describe('processMessage', () => {
    it('should create session on first message', () => {
      expect(pilot.hasActiveSession()).toBe(false);
      pilot.processMessage(TEST_CHAT_ID, 'Hello', 'msg-001');
      expect(pilot.hasActiveSession()).toBe(true);
    });

    it('should reject message for wrong chatId', () => {
      // Issue #713: Pilot uses logger.error() not console.error
      // When chatId doesn't match, processMessage returns early without starting session
      expect(pilot.hasActiveSession()).toBe(false);
      pilot.processMessage('wrong-chat-id', 'Hello', 'msg-002');
      // Session should still be inactive since message was rejected
      expect(pilot.hasActiveSession()).toBe(false);
    });

    it('should call sendMessage callback with enhanced content', () => {
      pilot.processMessage(TEST_CHAT_ID, 'Hello', 'msg-001');
      // Note: sendMessage is called during iterator processing, not directly
    });
  });

  describe('reset', () => {
    it('should clear session', () => {
      pilot.processMessage(TEST_CHAT_ID, 'Hello', 'msg-001');
      expect(pilot.hasActiveSession()).toBe(true);
      pilot.reset();
      expect(pilot.hasActiveSession()).toBe(false);
    });

    it('should ignore reset for wrong chatId', () => {
      pilot.processMessage(TEST_CHAT_ID, 'Hello', 'msg-001');
      pilot.reset('wrong-chat-id');
      // Session should still be active
      expect(pilot.hasActiveSession()).toBe(true);
    });
  });

  describe('dispose', () => {
    it('should cleanup resources', async () => {
      pilot.processMessage(TEST_CHAT_ID, 'Hello', 'msg-001');
      expect(pilot.hasActiveSession()).toBe(true);
      // dispose() calls async shutdown(), need to wait for it
      await pilot.shutdown();
      expect(pilot.hasActiveSession()).toBe(false);
    });
  });

  describe('buildAttachmentsInfo (Issue #809)', () => {
    // Access private method for testing
    const getAttachmentsInfo = (attachments?: any[]) =>
      (pilot as any).buildAttachmentsInfo(attachments);

    it('should include image analyzer hint for image attachments when MCP is configured', async () => {
      // Import Config to get access to the mocked version
      const { Config } = await import('../config/index.js');
      vi.mocked(Config.getMcpServersConfig).mockReturnValueOnce({
        '4_5v_mcp': { command: 'test-command' },
      });

      const imageAttachment = [{
        id: 'test-id',
        fileName: 'test.png',
        mimeType: 'image/png',
        size: 1024,
        source: 'user' as const,
        localPath: '/tmp/test.png',
        createdAt: Date.now(),
      }];

      const result = getAttachmentsInfo(imageAttachment);

      expect(result).toContain('Image attachment(s) detected');
      expect(result).toContain('analyze_image');
      expect(result).toContain('image analyzer MCP');
    });

    it('should not include image analyzer hint when no image analyzer MCP is configured', async () => {
      const { Config } = await import('../config/index.js');
      vi.mocked(Config.getMcpServersConfig).mockReturnValueOnce(undefined as any);

      const imageAttachment = [{
        id: 'test-id',
        fileName: 'test.png',
        mimeType: 'image/png',
        size: 1024,
        source: 'user' as const,
        localPath: '/tmp/test.png',
        createdAt: Date.now(),
      }];

      const result = getAttachmentsInfo(imageAttachment);

      expect(result).not.toContain('Image attachment(s) detected');
      expect(result).not.toContain('analyze_image');
    });

    it('should not include image analyzer hint for non-image attachments', async () => {
      const { Config } = await import('../config/index.js');
      vi.mocked(Config.getMcpServersConfig).mockReturnValueOnce({
        '4_5v_mcp': { command: 'test-command' },
      });

      const textAttachment = [{
        id: 'test-id',
        fileName: 'test.txt',
        mimeType: 'text/plain',
        size: 1024,
        source: 'user' as const,
        localPath: '/tmp/test.txt',
        createdAt: Date.now(),
      }];

      const result = getAttachmentsInfo(textAttachment);

      expect(result).not.toContain('Image attachment(s) detected');
    });

    it('should return empty string for no attachments', () => {
      const result = getAttachmentsInfo([]);
      expect(result).toBe('');
    });

    it('should return empty string for undefined attachments', () => {
      const result = getAttachmentsInfo(undefined);
      expect(result).toBe('');
    });

    it('should detect various image analyzer MCP names', async () => {
      const { Config } = await import('../config/index.js');
      const mcpNames = ['4_5v_mcp', 'glm-vision', 'image-analyzer', 'vision'];

      for (const name of mcpNames) {
        vi.mocked(Config.getMcpServersConfig).mockReturnValueOnce({
          [name]: { command: 'test-command' },
        });

        const imageAttachment = [{
          id: 'test-id',
          fileName: 'test.jpg',
          mimeType: 'image/jpeg',
          size: 1024,
          source: 'user' as const,
          localPath: '/tmp/test.jpg',
          createdAt: Date.now(),
        }];

        const result = getAttachmentsInfo(imageAttachment);
        expect(result).toContain('analyze_image');
      }
    });
  });
});
