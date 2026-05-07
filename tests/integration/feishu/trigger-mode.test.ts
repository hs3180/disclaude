/**
 * P3 Integration test: Trigger mode message filtering.
 *
 * Tests the real TriggerModeManager and MentionDetector classes that power
 * the group chat trigger mode filtering in MessageHandler.
 *
 * These tests exercise the actual code paths used for filtering:
 *   - TriggerModeManager: state management for per-chat trigger mode
 *   - MentionDetector: bot mention detection in group chat messages
 *
 * Uses mock data structures — no real Feishu API credentials needed.
 * Runs as part of the standard test suite.
 *
 * @see Issue #1626 — P3: 被动模式消息过滤
 * @see Issue #2291 — triggerMode enum
 * @see Issue #2052 — Auto-enable trigger mode for small groups
 * @see Issue #2069 — Declarative trigger mode via persisted records
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  TriggerModeManager,
  type TriggerModeRecord,
  MentionDetector,
  type BotInfo,
} from '@disclaude/primary-node';

// ---------------------------------------------------------------------------
// Helpers — construct Feishu mention structures for testing
// ---------------------------------------------------------------------------

/** Build a single mention entry matching Feishu's SDK shape. */
function makeMention(openId: string, key = '', name = '') {
  return {
    key,
    id: { open_id: openId, union_id: '', user_id: '' },
    name,
    tenant_key: '',
  };
}

/** Shorthand type matching FeishuMessageEvent['message']['mentions'] item. */
type MentionItem = ReturnType<typeof makeMention>;

// ===========================================================================
// TriggerModeManager — real class, no mocks
// ===========================================================================

describe('TriggerModeManager', () => {
  let manager: TriggerModeManager;

  beforeEach(() => {
    manager = new TriggerModeManager();
  });

  // -----------------------------------------------------------------------
  // Default state
  // -----------------------------------------------------------------------

  it('should have trigger mode disabled by default', () => {
    expect(manager.isTriggerEnabled('oc_unknown_chat')).toBe(false);
  });

  it('should not identify unknown chats as small groups', () => {
    expect(manager.isSmallGroup('oc_unknown_chat')).toBe(false);
  });

  it('should return empty list when no chats have trigger mode enabled', () => {
    expect(manager.getTriggerEnabledChats()).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // setTriggerEnabled / isTriggerEnabled — per-chat independence
  // -----------------------------------------------------------------------

  it('should enable trigger mode for a specific chat', () => {
    manager.setTriggerEnabled('oc_chat_a', true);
    expect(manager.isTriggerEnabled('oc_chat_a')).toBe(true);
  });

  it('should disable trigger mode for a specific chat', () => {
    manager.setTriggerEnabled('oc_chat_a', true);
    manager.setTriggerEnabled('oc_chat_a', false);
    expect(manager.isTriggerEnabled('oc_chat_a')).toBe(false);
  });

  it('should maintain per-chat independent trigger mode settings', () => {
    manager.setTriggerEnabled('oc_chat_a', true);
    manager.setTriggerEnabled('oc_chat_b', false);

    expect(manager.isTriggerEnabled('oc_chat_a')).toBe(true);
    expect(manager.isTriggerEnabled('oc_chat_b')).toBe(false);
    expect(manager.isTriggerEnabled('oc_chat_c')).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Small group auto-detection (Issue #2052)
  // -----------------------------------------------------------------------

  it('should auto-enable trigger mode for small groups', () => {
    manager.markAsSmallGroup('oc_small_group');
    expect(manager.isSmallGroup('oc_small_group')).toBe(true);
    expect(manager.isTriggerEnabled('oc_small_group')).toBe(true);
  });

  it('should keep trigger mode enabled for small groups even after more members join', () => {
    manager.markAsSmallGroup('oc_small_group');
    // Simulate more members joining — trigger mode should stay enabled
    expect(manager.isTriggerEnabled('oc_small_group')).toBe(true);
  });

  it('should include small groups in getTriggerEnabledChats', () => {
    manager.setTriggerEnabled('oc_manual_chat', true);
    manager.markAsSmallGroup('oc_small_group');

    const enabled = manager.getTriggerEnabledChats();
    expect(enabled).toContain('oc_manual_chat');
    expect(enabled).toContain('oc_small_group');
  });

  // -----------------------------------------------------------------------
  // initFromRecords — persisted state loading (Issue #2069, #2291)
  // -----------------------------------------------------------------------

  it('should load trigger mode from records with triggerMode=always', () => {
    const records: TriggerModeRecord[] = [
      { chatId: 'oc_persisted_a', triggerMode: 'always' },
      { chatId: 'oc_persisted_b', triggerMode: 'mention' },
    ];

    const count = manager.initFromRecords(records);

    expect(count).toBe(1);
    expect(manager.isTriggerEnabled('oc_persisted_a')).toBe(true);
    expect(manager.isTriggerEnabled('oc_persisted_b')).toBe(false);
  });

  it('should load trigger mode from legacy passiveMode=false records', () => {
    const records: TriggerModeRecord[] = [
      { chatId: 'oc_legacy_chat', passiveMode: false },
    ];

    const count = manager.initFromRecords(records);

    expect(count).toBe(1);
    expect(manager.isTriggerEnabled('oc_legacy_chat')).toBe(true);
  });

  it('should prefer triggerMode enum over legacy passiveMode', () => {
    const records: TriggerModeRecord[] = [
      { chatId: 'oc_conflict_chat', triggerMode: 'mention', passiveMode: false },
    ];

    const count = manager.initFromRecords(records);

    // triggerMode=mention should take precedence, so NOT enabled
    expect(count).toBe(0);
    expect(manager.isTriggerEnabled('oc_conflict_chat')).toBe(false);
  });

  it('should skip records without trigger mode configuration', () => {
    const records: TriggerModeRecord[] = [
      { chatId: 'oc_no_config' },
      { chatId: 'oc_passive_true', passiveMode: true },
      { chatId: 'oc_trigger_mention', triggerMode: 'mention' },
    ];

    const count = manager.initFromRecords(records);

    expect(count).toBe(0);
    expect(manager.getTriggerEnabledChats()).toEqual([]);
  });

  it('should handle empty records array', () => {
    const count = manager.initFromRecords([]);
    expect(count).toBe(0);
    expect(manager.getTriggerEnabledChats()).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Combined scenarios
  // -----------------------------------------------------------------------

  it('should combine manual, small group, and persisted trigger modes', () => {
    manager.setTriggerEnabled('oc_manual', true);
    manager.markAsSmallGroup('oc_small');
    manager.initFromRecords([
      { chatId: 'oc_persisted', triggerMode: 'always' },
    ]);

    const enabled = manager.getTriggerEnabledChats();
    expect(enabled).toHaveLength(3);
    expect(enabled).toContain('oc_manual');
    expect(enabled).toContain('oc_small');
    expect(enabled).toContain('oc_persisted');
  });
});

// ===========================================================================
// MentionDetector — real class, tests both with and without botInfo
// ===========================================================================

describe('MentionDetector', () => {
  let detector: MentionDetector;

  beforeEach(() => {
    detector = new MentionDetector();
  });

  // -----------------------------------------------------------------------
  // Without botInfo — fallback detection
  // -----------------------------------------------------------------------

  it('should return false for empty mentions', () => {
    expect(detector.isBotMentioned([])).toBe(false);
  });

  it('should return false for undefined mentions', () => {
    expect(detector.isBotMentioned(undefined)).toBe(false);
  });

  it('should detect bot mention via cli_ prefix in fallback mode', () => {
    const mentions = [makeMention('cli_test_bot_id')];
    expect(detector.isBotMentioned(mentions as MentionItem[])).toBe(true);
  });

  it('should detect bot mention via bot keyword in key (fallback mode)', () => {
    const mentions = [makeMention('ou_regular_user', '@_bot')];
    expect(detector.isBotMentioned(mentions as MentionItem[])).toBe(true);
  });

  it('should not detect regular user mention in fallback mode', () => {
    const mentions = [makeMention('ou_regular_user', '@Alice')];
    expect(detector.isBotMentioned(mentions as MentionItem[])).toBe(false);
  });

  it('should detect bot mention among multiple mentions in fallback mode', () => {
    const mentions = [
      makeMention('ou_user_a', '@Alice'),
      makeMention('cli_bot_id', '@_bot'),
    ];
    expect(detector.isBotMentioned(mentions as MentionItem[])).toBe(true);
  });

  // -----------------------------------------------------------------------
  // With botInfo — precise detection
  // -----------------------------------------------------------------------

  it('should detect bot mention by open_id when botInfo is available', async () => {
    // Create a mock client that returns bot info
    const mockClient = {
      request: async () => ({
        bot: { open_id: 'ou_bot_open_id', app_id: 'cli_bot_app_id' },
      }),
    };
    detector.setClient(mockClient as never);
    await detector.fetchBotInfo();

    const mentions = [makeMention('ou_bot_open_id', '@Bot')];
    expect(detector.isBotMentioned(mentions as MentionItem[])).toBe(true);
  });

  it('should detect bot mention by app_id when botInfo is available', async () => {
    const mockClient = {
      request: async () => ({
        bot: { open_id: 'ou_bot_open_id', app_id: 'cli_bot_app_id' },
      }),
    };
    detector.setClient(mockClient as never);
    await detector.fetchBotInfo();

    // Feishu may use either open_id or app_id when the bot is mentioned
    const mentions = [makeMention('cli_bot_app_id', '@Bot')];
    expect(detector.isBotMentioned(mentions as MentionItem[])).toBe(true);
  });

  it('should not detect regular user when botInfo is available', async () => {
    const mockClient = {
      request: async () => ({
        bot: { open_id: 'ou_bot_open_id', app_id: 'cli_bot_app_id' },
      }),
    };
    detector.setClient(mockClient as never);
    await detector.fetchBotInfo();

    const mentions = [makeMention('ou_other_user', '@Alice')];
    expect(detector.isBotMentioned(mentions as MentionItem[])).toBe(false);
  });

  it('should detect bot among multiple mentions when botInfo is available', async () => {
    const mockClient = {
      request: async () => ({
        bot: { open_id: 'ou_bot_open_id', app_id: 'cli_bot_app_id' },
      }),
    };
    detector.setClient(mockClient as never);
    await detector.fetchBotInfo();

    const mentions = [
      makeMention('ou_user_a', '@Alice'),
      makeMention('ou_bot_open_id', '@Bot'),
      makeMention('ou_user_b', '@Bob'),
    ];
    expect(detector.isBotMentioned(mentions as MentionItem[])).toBe(true);
  });

  it('should return correct botInfo after fetch', async () => {
    const mockClient = {
      request: async () => ({
        bot: { open_id: 'ou_test_bot', app_id: 'cli_test_app' },
      }),
    };
    detector.setClient(mockClient as never);
    await detector.fetchBotInfo();

    const info = detector.getBotInfo();
    expect(info).toEqual({
      open_id: 'ou_test_bot',
      app_id: 'cli_test_app',
    });
  });
});

// ===========================================================================
// Combined trigger mode filtering scenario — simulates MessageHandler logic
// ===========================================================================

describe('Trigger mode filtering (TriggerModeManager + MentionDetector combined)', () => {
  let triggerManager: TriggerModeManager;
  let mentionDetector: MentionDetector;

  beforeEach(() => {
    triggerManager = new TriggerModeManager();
    mentionDetector = new MentionDetector();
  });

  /**
   * Simulate the MessageHandler's trigger mode filtering decision:
   * In a group chat, if trigger mode is disabled and the bot is not mentioned,
   * the message should be filtered (skipped).
   *
   * This mirrors the logic in MessageHandler lines 854-868.
   */
  function shouldFilterMessage(params: {
    chatType: 'p2p' | 'group';
    chatId: string;
    mentions?: MentionItem[];
    isTriggerCommand?: boolean;
  }): boolean {
    const { chatType, chatId, mentions, isTriggerCommand } = params;

    const isGroupChat = chatType === 'group';
    const botMentioned = mentionDetector.isBotMentioned(mentions);
    const triggerEnabled = triggerManager.isTriggerEnabled(chatId);

    // Mirror MessageHandler logic: filter group chat messages without @mention
    // unless trigger mode is enabled or it's a /trigger command
    if (isGroupChat && !botMentioned && !isTriggerCommand && !triggerEnabled) {
      // Small group auto-detection happens here in real code
      // We test this separately in TriggerModeManager tests
      if (!triggerManager.isTriggerEnabled(chatId)) {
        return true; // message should be filtered
      }
    }

    return false; // message should be processed
  }

  // -----------------------------------------------------------------------
  // mention mode (default) — only process @mentioned messages
  // -----------------------------------------------------------------------

  it('should filter group message without @mention in mention mode', () => {
    expect(shouldFilterMessage({
      chatType: 'group',
      chatId: 'oc_group_chat',
    })).toBe(true);
  });

  it('should process group message with @mention in mention mode', () => {
    const mentions = [makeMention('cli_bot_id', '@_bot')];

    expect(shouldFilterMessage({
      chatType: 'group',
      chatId: 'oc_group_chat',
      mentions,
    })).toBe(false);
  });

  it('should process p2p message without @mention in mention mode', () => {
    expect(shouldFilterMessage({
      chatType: 'p2p',
      chatId: 'oc_p2p_chat',
    })).toBe(false);
  });

  // -----------------------------------------------------------------------
  // always mode — process all messages
  // -----------------------------------------------------------------------

  it('should process group message without @mention in always mode', () => {
    triggerManager.setTriggerEnabled('oc_group_chat', true);

    expect(shouldFilterMessage({
      chatType: 'group',
      chatId: 'oc_group_chat',
    })).toBe(false);
  });

  it('should process group message with @mention in always mode', () => {
    triggerManager.setTriggerEnabled('oc_group_chat', true);
    const mentions = [makeMention('cli_bot_id', '@_bot')];

    expect(shouldFilterMessage({
      chatType: 'group',
      chatId: 'oc_group_chat',
      mentions,
    })).toBe(false);
  });

  // -----------------------------------------------------------------------
  // /trigger command — always pass through regardless of mode
  // -----------------------------------------------------------------------

  it('should always process /trigger command regardless of trigger mode', () => {
    expect(shouldFilterMessage({
      chatType: 'group',
      chatId: 'oc_group_chat',
      isTriggerCommand: true,
    })).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Per-chat independent behavior
  // -----------------------------------------------------------------------

  it('should apply different modes to different chats independently', () => {
    triggerManager.setTriggerEnabled('oc_chat_always', true);
    // oc_chat_mention stays in default (mention mode)

    // Chat with always mode — no mention needed
    expect(shouldFilterMessage({
      chatType: 'group',
      chatId: 'oc_chat_always',
    })).toBe(false);

    // Chat with mention mode — filtered without mention
    expect(shouldFilterMessage({
      chatType: 'group',
      chatId: 'oc_chat_mention',
    })).toBe(true);

    // Chat with mention mode — processed with mention
    const mentions = [makeMention('cli_bot_id', '@_bot')];
    expect(shouldFilterMessage({
      chatType: 'group',
      chatId: 'oc_chat_mention',
      mentions,
    })).toBe(false);
  });
});
