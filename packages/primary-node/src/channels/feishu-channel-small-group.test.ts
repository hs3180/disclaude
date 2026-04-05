/**
 * Tests for FeishuChannel 2-member group passive mode auto-detection (Issue #2052).
 *
 * Tests cover:
 * - Auto-disable passive mode when bot is added to a 2-member group
 * - No action when bot is not among added members
 * - No action when group has more than 2 members
 * - Graceful handling of API errors
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassiveModeManager } from './feishu/passive-mode.js';
import { FeishuChannel } from './feishu-channel.js';
import type { FeishuChatMemberAddedEventData } from '@disclaude/core';

// ─── Mock Logger ────────────────────────────────────────────────────────────

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
}));

vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@disclaude/core')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

// ─── Mock Lark SDK ──────────────────────────────────────────────────────────

function createMockClient(chatGetResponse?: { member_count?: number }) {
  const chatGetMock = vi.fn().mockResolvedValue({
    data: {
      items: [chatGetResponse ?? { member_count: 2 }],
    },
  });

  return {
    client: {
      im: {
        chat: {
          get: chatGetMock,
        },
        message: {
          create: vi.fn().mockResolvedValue({ data: { message_id: 'msg_001' } }),
          reply: vi.fn().mockResolvedValue({ data: { message_id: 'msg_001' } }),
        },
      },
    },
    mocks: { chatGetMock },
  };
}

// ─── Mock Feishu platform modules ───────────────────────────────────────────

vi.mock('../platforms/feishu/index.js', () => ({
  InteractionManager: vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
  })),
  WelcomeService: vi.fn(),
  createFeishuClient: vi.fn(() => {
    const { client } = createMockClient();
    return client;
  }),
}));

vi.mock('./feishu/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./feishu/index.js')>();
  return {
    ...actual,
    PassiveModeManager: vi.fn(),
    MentionDetector: vi.fn().mockImplementation(() => ({
      setClient: vi.fn(),
      fetchBotInfo: vi.fn().mockResolvedValue(undefined),
      getBotInfo: vi.fn().mockReturnValue(undefined),
    })),
    WelcomeHandler: vi.fn().mockImplementation(() => ({
      handleP2PChatEntered: vi.fn(),
      handleChatMemberAdded: vi.fn(),
      setWelcomeService: vi.fn(),
    })),
    MessageHandler: vi.fn().mockImplementation(() => ({
      handleMessageReceive: vi.fn(),
      handleCardAction: vi.fn(),
      initialize: vi.fn(),
      clearClient: vi.fn(),
    })),
    messageLogger: { init: vi.fn().mockResolvedValue(undefined) },
    WsConnectionManager: vi.fn().mockImplementation(() => ({
      state: 'connected',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      isHealthy: vi.fn().mockReturnValue(true),
      on: vi.fn(),
      recordMessageReceived: vi.fn(),
      getMetrics: vi.fn().mockReturnValue(undefined),
    })),
  };
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const TEST_APP_ID = 'cli_test_app';

function createTestChannelWithRealManager(mockClient: ReturnType<typeof createMockClient>['client']) {
  const channel = new FeishuChannel({ appId: TEST_APP_ID, appSecret: 'test-secret' });
  // Use a real PassiveModeManager for accurate behavior testing
  const realManager = new PassiveModeManager();
  (channel as any).client = mockClient;
  (channel as any).passiveModeManager = realManager;
  (channel as any)._status = 'running';
  return { channel, passiveModeManager: realManager };
}

function makeMemberAddedEvent(
  chatId: string,
  members: Array<{ member_id_type: string; member_id: string }>,
): FeishuChatMemberAddedEventData {
  return {
    event: {
      chat_id: chatId,
      timestamp: '1234567890',
      members,
      operator: {
        operator_id_type: 'open_id',
        operator_id: 'ou_operator',
      },
    },
  };
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('FeishuChannel autoDisablePassiveModeForSmallGroup (Issue #2052)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should disable passive mode when bot is added to a 2-member group', async () => {
    const { client, mocks } = createMockClient({ member_count: 2 });
    const { channel, passiveModeManager } = createTestChannelWithRealManager(client);

    const eventData = makeMemberAddedEvent('oc_small_group', [
      { member_id_type: 'app_id', member_id: TEST_APP_ID },
      { member_id_type: 'open_id', member_id: 'ou_user1' },
    ]);

    await (channel as any).autoDisablePassiveModeForSmallGroup(eventData);

    expect(mocks.chatGetMock).toHaveBeenCalledWith({
      path: { chat_id: 'oc_small_group' },
      params: { user_id_type: 'open_id' },
    });
    expect(passiveModeManager.isPassiveModeDisabled('oc_small_group')).toBe(true);
  });

  it('should NOT disable passive mode for groups with more than 2 members', async () => {
    const { client, mocks } = createMockClient({ member_count: 5 });
    const { channel, passiveModeManager } = createTestChannelWithRealManager(client);

    const eventData = makeMemberAddedEvent('oc_large_group', [
      { member_id_type: 'app_id', member_id: TEST_APP_ID },
      { member_id_type: 'open_id', member_id: 'ou_user1' },
      { member_id_type: 'open_id', member_id: 'ou_user2' },
    ]);

    await (channel as any).autoDisablePassiveModeForSmallGroup(eventData);

    expect(mocks.chatGetMock).toHaveBeenCalled();
    expect(passiveModeManager.isPassiveModeDisabled('oc_large_group')).toBe(false);
  });

  it('should NOT take action when bot is NOT among added members', async () => {
    const { client, mocks } = createMockClient({ member_count: 2 });
    const { channel, passiveModeManager } = createTestChannelWithRealManager(client);

    // Only a user is added, not the bot
    const eventData = makeMemberAddedEvent('oc_existing_group', [
      { member_id_type: 'open_id', member_id: 'ou_new_user' },
    ]);

    await (channel as any).autoDisablePassiveModeForSmallGroup(eventData);

    // Should NOT call the API since bot was not added
    expect(mocks.chatGetMock).not.toHaveBeenCalled();
    expect(passiveModeManager.isPassiveModeDisabled('oc_existing_group')).toBe(false);
  });

  it('should handle API errors gracefully without throwing', async () => {
    const errorClient = {
      im: {
        chat: {
          get: vi.fn().mockRejectedValue(new Error('API rate limit exceeded')),
        },
        message: {
          create: vi.fn().mockResolvedValue({ data: { message_id: 'msg_001' } }),
          reply: vi.fn().mockResolvedValue({ data: { message_id: 'msg_001' } }),
        },
      },
    };
    const { channel, passiveModeManager } = createTestChannelWithRealManager(errorClient);

    const eventData = makeMemberAddedEvent('oc_error_group', [
      { member_id_type: 'app_id', member_id: TEST_APP_ID },
      { member_id_type: 'open_id', member_id: 'ou_user1' },
    ]);

    // Should NOT throw
    await expect(
      (channel as any).autoDisablePassiveModeForSmallGroup(eventData),
    ).resolves.not.toThrow();

    // Passive mode should NOT be changed on error
    expect(passiveModeManager.isPassiveModeDisabled('oc_error_group')).toBe(false);
  });

  it('should handle missing event data gracefully', async () => {
    const { client, mocks } = createMockClient();
    const { channel, passiveModeManager } = createTestChannelWithRealManager(client);

    // Missing event
    await (channel as any).autoDisablePassiveModeForSmallGroup({});
    expect(mocks.chatGetMock).not.toHaveBeenCalled();

    // Missing chat_id
    await (channel as any).autoDisablePassiveModeForSmallGroup({ event: { members: [] } });
    expect(mocks.chatGetMock).not.toHaveBeenCalled();

    // Missing members
    await (channel as any).autoDisablePassiveModeForSmallGroup({ event: { chat_id: 'oc_test' } });
    expect(mocks.chatGetMock).not.toHaveBeenCalled();

    expect(passiveModeManager.getPassiveModeDisabledChats()).toHaveLength(0);
  });

  it('should handle missing member_count in API response', async () => {
    const { client, mocks } = createMockClient({}); // no member_count
    const { channel, passiveModeManager } = createTestChannelWithRealManager(client);

    const eventData = makeMemberAddedEvent('oc_no_count', [
      { member_id_type: 'app_id', member_id: TEST_APP_ID },
      { member_id_type: 'open_id', member_id: 'ou_user1' },
    ]);

    await (channel as any).autoDisablePassiveModeForSmallGroup(eventData);

    expect(mocks.chatGetMock).toHaveBeenCalled();
    // Should NOT disable passive mode when member_count is undefined
    expect(passiveModeManager.isPassiveModeDisabled('oc_no_count')).toBe(false);
  });

  it('should not make API call when client is not initialized', async () => {
    const { channel, passiveModeManager } = createTestChannelWithRealManager({
      im: {
        chat: {
          get: vi.fn(),
        },
        message: {
          create: vi.fn(),
          reply: vi.fn(),
        },
      },
    });

    // Remove client to simulate uninitialized state
    (channel as any).client = undefined;

    const eventData = makeMemberAddedEvent('oc_no_client', [
      { member_id_type: 'app_id', member_id: TEST_APP_ID },
      { member_id_type: 'open_id', member_id: 'ou_user1' },
    ]);

    await (channel as any).autoDisablePassiveModeForSmallGroup(eventData);

    expect(passiveModeManager.isPassiveModeDisabled('oc_no_client')).toBe(false);
  });
});
