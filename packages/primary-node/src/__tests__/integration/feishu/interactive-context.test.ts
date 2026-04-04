/**
 * Feishu Integration Test: InteractiveContextStore multi-card coexistence.
 *
 * Validates the LRU cache behavior after the #1625 fix, which ensures
 * multiple interactive cards can coexist in the same chat without
 * action prompt overwrite.
 *
 * These tests focus on realistic multi-card scenarios that go beyond
 * the basic unit tests in interactive-context.test.ts:
 * - Concurrent card registrations from different sources (IPC script + Agent)
 * - Inverted index consistency under LRU eviction
 * - Stale entry detection and self-repair
 * - High-volume card registration patterns
 *
 * P0 priority per Issue #1626.
 *
 * @module integration/feishu/interactive-context
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InteractiveContextStore, type ActionPromptMap } from '../../../interactive-context.js';
import { buildActionPrompts } from '../../../platforms/feishu/card-builders/interactive-message-builder.js';

// ============================================================================
// Helpers
// ============================================================================

/** Monotonic counter to ensure unique synthetic messageIds. */
let _cardCounter = 0;

/**
 * Simulate the registration pattern used by sendInteractive handler.
 * Creates a synthetic messageId and registers with the given options.
 * Uses a monotonic counter to guarantee unique IDs even within the same ms.
 */
function registerCard(
  store: InteractiveContextStore,
  chatId: string,
  options: Array<{ text: string; value: string; type?: 'primary' | 'default' | 'danger' }>,
  customPrompts?: ActionPromptMap,
  timestamp?: number
): string {
  const syntheticMessageId = `interactive_${chatId}_${timestamp ?? (Date.now() + ++_cardCounter)}`;
  const actionPrompts = buildActionPrompts(options, customPrompts);
  store.register(syntheticMessageId, chatId, actionPrompts);
  return syntheticMessageId;
}

/**
 * Create options for a typical multi-button interactive card.
 */
function createMultiButtonOptions(prefix: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    text: `Option ${prefix}-${i + 1}`,
    value: `${prefix}_opt_${i + 1}`,
  }));
}

// ============================================================================
// Tests: Multi-card coexistence scenarios (#1625)
// ============================================================================

describe('InteractiveContextStore: multi-card coexistence integration', () => {
  let store: InteractiveContextStore;

  beforeEach(() => {
    store = new InteractiveContextStore();
  });

  it('should handle IPC script + Agent sending cards simultaneously', () => {
    const chatId = 'oc_concurrent_test';

    // IPC script sends Card A with navigation buttons
    const ipcOptions = [
      { text: '🏠 Home', value: 'nav_home' },
      { text: '📊 Dashboard', value: 'nav_dashboard' },
      { text: '⚙️ Settings', value: 'nav_settings' },
    ];
    const messageIdA = registerCard(store, chatId, ipcOptions, {
      nav_home: '[导航] 用户返回首页',
      nav_dashboard: '[导航] 用户查看仪表盘',
      nav_settings: '[导航] 用户打开设置',
    });

    // Agent sends Card B with action buttons (almost simultaneously)
    const agentOptions = [
      { text: '✅ Confirm', value: 'confirm', type: 'primary' as const },
      { text: '❌ Reject', value: 'reject', type: 'danger' as const },
    ];
    const messageIdB = registerCard(store, chatId, agentOptions);

    // Both cards should be stored
    expect(store.size).toBe(2);

    // Actions from Card A should be findable
    expect(store.getActionPrompts(messageIdA)?.nav_home).toBe('[导航] 用户返回首页');
    expect(store.getActionPrompts(messageIdA)?.nav_dashboard).toBe('[导航] 用户查看仪表盘');
    expect(store.getActionPrompts(messageIdA)?.nav_settings).toBe('[导航] 用户打开设置');

    // Actions from Card B should be findable
    expect(store.getActionPrompts(messageIdB)?.confirm).toBeDefined();
    expect(store.getActionPrompts(messageIdB)?.reject).toBeDefined();

    // Cross-card lookup should work for both
    const navPrompt = store.findActionPromptsByChatId(chatId, 'nav_home');
    expect(navPrompt?.nav_home).toBe('[导航] 用户返回首页');

    const confirmPrompt = store.findActionPromptsByChatId(chatId, 'confirm');
    expect(confirmPrompt?.confirm).toBeDefined();
  });

  it('should handle 3+ cards from different sources in the same chat', () => {
    const chatId = 'oc_multi_source';

    // IPC script sends a navigation card
    registerCard(store, chatId, [
      { text: 'Home', value: 'home' },
      { text: 'Back', value: 'back' },
    ]);

    // Agent sends a confirmation card
    registerCard(store, chatId, [
      { text: 'Yes', value: 'yes' },
      { text: 'No', value: 'no' },
    ]);

    // Scheduler sends a status card
    registerCard(store, chatId, [
      { text: 'View Details', value: 'view_details' },
      { text: 'Dismiss', value: 'dismiss' },
    ]);

    expect(store.size).toBe(3);

    // Each card's actions should be independently accessible
    expect(store.findActionPromptsByChatId(chatId, 'home')).toBeDefined();
    expect(store.findActionPromptsByChatId(chatId, 'yes')).toBeDefined();
    expect(store.findActionPromptsByChatId(chatId, 'view_details')).toBeDefined();
  });

  it('should handle cards with overlapping action values across chats', () => {
    const chat1 = 'oc_chat_1';
    const chat2 = 'oc_chat_2';

    // Both chats have a card with a 'confirm' action
    registerCard(store, chat1, [
      { text: 'Confirm Chat 1', value: 'confirm' },
      { text: 'Cancel', value: 'cancel' },
    ]);
    registerCard(store, chat2, [
      { text: 'Confirm Chat 2', value: 'confirm' },
      { text: 'Skip', value: 'skip' },
    ]);

    expect(store.size).toBe(2);

    // Each chat's confirm should be independent
    const chat1Prompts = store.findActionPromptsByChatId(chat1, 'confirm');
    expect(chat1Prompts?.confirm).toContain('Confirm Chat 1');

    const chat2Prompts = store.findActionPromptsByChatId(chat2, 'confirm');
    expect(chat2Prompts?.confirm).toContain('Confirm Chat 2');

    // Chat 1 should not find chat 2's actions
    expect(store.findActionPromptsByChatId(chat1, 'skip')).toBeUndefined();
  });
});

// ============================================================================
// Tests: LRU eviction under realistic conditions
// ============================================================================

describe('InteractiveContextStore: LRU eviction integration', () => {
  it('should maintain inverted index consistency after eviction', () => {
    const store = new InteractiveContextStore(24 * 60 * 60 * 1000, 3);
    const chatId = 'oc_lru_consistency';

    // Fill up to max capacity
    const id1 = registerCard(store, chatId, [{ text: 'Card 1', value: 'card_1' }], undefined, 1000);
    registerCard(store, chatId, [{ text: 'Card 2', value: 'card_2' }], undefined, 2000);
    registerCard(store, chatId, [{ text: 'Card 3', value: 'card_3' }], undefined, 3000);
    expect(store.size).toBe(3);

    // Add one more to trigger eviction of card_1
    registerCard(store, chatId, [{ text: 'Card 4', value: 'card_4' }], undefined, 4000);
    expect(store.size).toBe(3);

    // Card 1 should be gone from all indexes
    expect(store.getActionPrompts(id1)).toBeUndefined();
    expect(store.findActionPromptsByChatId(chatId, 'card_1')).toBeUndefined();

    // Cards 2, 3, 4 should still be accessible
    expect(store.findActionPromptsByChatId(chatId, 'card_2')).toBeDefined();
    expect(store.findActionPromptsByChatId(chatId, 'card_3')).toBeDefined();
    expect(store.findActionPromptsByChatId(chatId, 'card_4')).toBeDefined();
  });

  it('should handle rapid card registration and eviction', () => {
    const store = new InteractiveContextStore(24 * 60 * 60 * 1000, 5);
    const chatId = 'oc_rapid_test';

    // Register 20 cards rapidly (only last 5 should remain)
    const messageIds: string[] = [];
    for (let i = 1; i <= 20; i++) {
      const id = registerCard(store, chatId, [{ text: `Card ${i}`, value: `card_${i}` }], undefined, i * 100);
      messageIds.push(id);
    }

    expect(store.size).toBe(5);

    // First 15 cards should be evicted
    for (let i = 1; i <= 15; i++) {
      expect(store.getActionPrompts(messageIds[i - 1])).toBeUndefined();
      expect(store.findActionPromptsByChatId(chatId, `card_${i}`)).toBeUndefined();
    }

    // Last 5 cards should be accessible
    for (let i = 16; i <= 20; i++) {
      expect(store.getActionPrompts(messageIds[i - 1])).toBeDefined();
      expect(store.findActionPromptsByChatId(chatId, `card_${i}`)).toBeDefined();
    }
  });

  it('should handle eviction with re-registration of evicted card', () => {
    const store = new InteractiveContextStore(24 * 60 * 60 * 1000, 2);
    const chatId = 'oc_reregister';

    // Register card A and B
    const idA = registerCard(store, chatId, [{ text: 'A', value: 'a' }], undefined, 1000);
    registerCard(store, chatId, [{ text: 'B', value: 'b' }], undefined, 2000);

    // Add card C to evict A
    registerCard(store, chatId, [{ text: 'C', value: 'c' }], undefined, 3000);
    expect(store.getActionPrompts(idA)).toBeUndefined();

    // Re-register card A (simulating a new card with same content)
    const idA2 = registerCard(store, chatId, [{ text: 'A (new)', value: 'a' }], undefined, 4000);
    expect(store.getActionPrompts(idA2)).toBeDefined();

    // Card C should now be evicted (oldest of the 2 remaining)
    // Wait... re-registering A pushes C out? No, we had B and C (2 items), then we add A2 making it B, C, A2 - but max is 2, so B gets evicted
    // Actually, at this point the store has: B(2000), C(3000) - 2 items
    // Adding A2(4000) makes it: C(3000), A2(4000) - 2 items, B is evicted
    expect(store.findActionPromptsByChatId(chatId, 'b')).toBeUndefined();
    expect(store.findActionPromptsByChatId(chatId, 'c')).toBeDefined();
    expect(store.findActionPromptsByChatId(chatId, 'a')).toBeDefined();
  });
});

// ============================================================================
// Tests: Inverted index self-repair
// ============================================================================

describe('InteractiveContextStore: inverted index self-repair', () => {
  let store: InteractiveContextStore;

  beforeEach(() => {
    store = new InteractiveContextStore();
  });

  it('should repair inverted index after manual unregister', () => {
    const chatId = 'oc_repair_test';

    // Register two cards with unique actions
    registerCard(store, chatId, [
      { text: 'Action X', value: 'action_x' },
      { text: 'Action Y', value: 'action_y' },
    ], undefined, 1000);
    registerCard(store, chatId, [
      { text: 'Action Z', value: 'action_z' },
    ], undefined, 2000);

    // Unregister the newer card
    store.unregister(store.getActionPromptsByChatId(chatId)!.action_z
      ? `interactive_${chatId}_2000` : `interactive_${chatId}_1000`);

    // The remaining card's actions should still be findable
    expect(store.findActionPromptsByChatId(chatId, 'action_x')).toBeDefined();
    expect(store.findActionPromptsByChatId(chatId, 'action_y')).toBeDefined();
  });

  it('should find correct card when newer card is unregistered', () => {
    const chatId = 'oc_unregister_newer';

    registerCard(store, chatId, [
      { text: 'First', value: 'first' },
    ], undefined, 1000);

    const idB = registerCard(store, chatId, [
      { text: 'Second', value: 'second' },
    ], undefined, 2000);

    // Unregister the newer card
    store.unregister(idB);

    // Should still find the older card
    expect(store.findActionPromptsByChatId(chatId, 'first')).toBeDefined();
    expect(store.findActionPromptsByChatId(chatId, 'second')).toBeUndefined();

    // getActionPromptsByChatId should fall back to the older card
    expect(store.getActionPromptsByChatId(chatId)?.first).toBeDefined();
  });

  it('should handle generatePrompt across stale inverted index entries', () => {
    const chatId = 'oc_stale_index';

    // Card A: has 'common_action'
    registerCard(store, chatId, [
      { text: 'Common', value: 'common_action' },
      { text: 'Unique A', value: 'unique_a' },
    ], undefined, 1000);

    // Card B: also has 'common_action' (overrides in inverted index)
    registerCard(store, chatId, [
      { text: 'Common', value: 'common_action' },
      { text: 'Unique B', value: 'unique_b' },
    ], undefined, 2000);

    // Generate prompt using exact messageIdA for 'common_action'
    const idA = `interactive_${chatId}_1000`;
    const prompt = store.generatePrompt(idA, chatId, 'common_action', 'Common');
    expect(prompt).toContain('Common');

    // Generate prompt for 'unique_a' using fallback (unknown messageId)
    const promptA = store.generatePrompt('unknown_id', chatId, 'unique_a', 'Unique A');
    expect(promptA).toContain('Unique A');
  });
});

// ============================================================================
// Tests: High-volume realistic patterns
// ============================================================================

describe('InteractiveContextStore: high-volume patterns', () => {
  it('should handle 10 cards with multi-button options per chat', () => {
    const store = new InteractiveContextStore(24 * 60 * 60 * 1000, 10);
    const chatId = 'oc_high_volume';

    // Register 10 cards, each with 5 buttons
    for (let card = 0; card < 10; card++) {
      registerCard(store, chatId, createMultiButtonOptions(`card${card}`, 5), undefined, (card + 1) * 1000);
    }

    expect(store.size).toBe(10);

    // All 50 actions should be findable
    for (let card = 0; card < 10; card++) {
      for (let btn = 1; btn <= 5; btn++) {
        const actionValue = `card${card}_opt_${btn}`;
        const prompts = store.findActionPromptsByChatId(chatId, actionValue);
        expect(prompts).toBeDefined();
        expect(prompts![actionValue]).toBeDefined();
      }
    }
  });

  it('should handle multiple chats with cards simultaneously', () => {
    const store = new InteractiveContextStore();
    const chats = ['oc_chat_a', 'oc_chat_b', 'oc_chat_c'];

    for (const chatId of chats) {
      for (let i = 0; i < 5; i++) {
        registerCard(store, chatId, createMultiButtonOptions(`${chatId}_${i}`, 3), undefined, (i + 1) * 1000);
      }
    }

    expect(store.size).toBe(15);

    // Each chat's actions should be isolated
    for (const chatId of chats) {
      for (let i = 0; i < 5; i++) {
        for (let btn = 1; btn <= 3; btn++) {
          expect(store.findActionPromptsByChatId(chatId, `${chatId}_${i}_opt_${btn}`)).toBeDefined();
        }
      }
      // Should not find actions from other chats
      for (const otherChat of chats) {
        if (otherChat !== chatId) {
          expect(store.findActionPromptsByChatId(chatId, `${otherChat}_0_opt_1`)).toBeUndefined();
        }
      }
    }
  });

  it('should cleanup expired entries without affecting fresh ones', () => {
    const shortMaxAge = 100; // 100ms
    const store = new InteractiveContextStore(shortMaxAge);
    const chatId = 'oc_expiry_test';

    // Register 3 cards rapidly
    registerCard(store, chatId, [{ text: 'Old 1', value: 'old_1' }], undefined, 100);
    registerCard(store, chatId, [{ text: 'Old 2', value: 'old_2' }], undefined, 200);

    // Wait for expiration
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // Register a fresh card
        registerCard(store, chatId, [{ text: 'Fresh', value: 'fresh' }], undefined, Date.now());

        // Cleanup expired
        const cleaned = store.cleanupExpired();
        expect(cleaned).toBe(2);
        expect(store.size).toBe(1);

        // Fresh card should still be accessible
        expect(store.findActionPromptsByChatId(chatId, 'fresh')).toBeDefined();
        expect(store.findActionPromptsByChatId(chatId, 'old_1')).toBeUndefined();
        expect(store.findActionPromptsByChatId(chatId, 'old_2')).toBeUndefined();

        resolve();
      }, 150);
    });
  });
});
