/**
 * Integration Test: IPC sendInteractive full chain.
 *
 * Tests the complete sendInteractive flow:
 *   validateInteractiveParams → buildInteractiveCard → sendMessage →
 *   actionPrompts registration → generatePrompt (callback resolution)
 *
 * This test is gated by FEISHU_INTEGRATION_TEST env var.
 * When not set, all tests are automatically skipped.
 *
 * @see Issue #1626 — Optional Feishu integration tests (skip by default)
 * @see Issue #1570 — sendInteractive IPC flow
 * @see Issue #1572 — InteractiveContextStore migration to Primary Node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { describeIfFeishu } from './helpers.js';
import {
  InteractiveContextStore,
} from '../../../interactive-context.js';
import {
  validateInteractiveParams,
  buildInteractiveCard,
  buildActionPrompts,
} from '../../../platforms/feishu/card-builders/index.js';

// ---------------------------------------------------------------------------
// Mock logger — prevent real logger from writing during tests
// ---------------------------------------------------------------------------

vi.mock('@disclaude/core', async () => {
  const actual = await vi.importActual<typeof import('@disclaude/core')>('@disclaude/core');
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    }),
  };
});

describeIfFeishu('IPC sendInteractive — full chain', () => {
  let contextStore: InteractiveContextStore;

  beforeEach(() => {
    contextStore = new InteractiveContextStore();
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Phase 1: Parameter validation
  // -----------------------------------------------------------------------

  describe('parameter validation', () => {
    it('should accept valid params', () => {
      const params = {
        question: 'Choose an option:',
        options: [{ text: 'OK', value: 'ok' }],
      };
      expect(validateInteractiveParams(params)).toBeNull();
    });

    it('should reject empty question', () => {
      const params = { question: '', options: [{ text: 'OK', value: 'ok' }] };
      expect(validateInteractiveParams(params)).toMatch(/question/i);
    });

    it('should reject empty options array', () => {
      const params = { question: 'Q?', options: [] };
      expect(validateInteractiveParams(params)).toMatch(/option/i);
    });

    it('should reject missing options', () => {
      const params = { question: 'Q?' } as any;
      expect(validateInteractiveParams(params)).toMatch(/option/i);
    });
  });

  // -----------------------------------------------------------------------
  // Phase 2: Card building
  // -----------------------------------------------------------------------

  describe('card building', () => {
    it('should build a valid interactive card JSON', () => {
      const card = buildInteractiveCard({
        question: 'Pick one:',
        options: [
          { text: 'Confirm', value: 'confirm', type: 'primary' },
          { text: 'Cancel', value: 'cancel' },
        ],
        title: 'Action Required',
        context: 'Additional context',
      });

      // Card must have the expected Feishu card structure
      expect(card).toHaveProperty('config');
      expect(card).toHaveProperty('header');
      expect(card).toHaveProperty('elements');
      expect(card.elements!.length).toBeGreaterThanOrEqual(1);
    });

    it('should build card without optional fields', () => {
      const card = buildInteractiveCard({
        question: 'Simple question',
        options: [{ text: 'Yes', value: 'yes' }],
      });

      expect(card).toBeDefined();
      expect(card.elements!.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // Phase 3: Action prompt generation
  // -----------------------------------------------------------------------

  describe('action prompt generation', () => {
    it('should generate default prompts from options', () => {
      const options = [
        { text: 'Confirm', value: 'confirm' },
        { text: 'Cancel', value: 'cancel' },
      ];
      const prompts = buildActionPrompts(options);

      expect(prompts).toHaveProperty('confirm');
      expect(prompts).toHaveProperty('cancel');
      expect(prompts.confirm).toContain('Confirm');
      expect(prompts.cancel).toContain('Cancel');
    });

    it('should use caller-provided prompts when available', () => {
      const options = [{ text: 'OK', value: 'ok' }];
      const customPrompts = { ok: 'Custom prompt for OK' };
      // Simulate the logic from wired-descriptors.ts
      const resolved = Object.keys(customPrompts).length > 0
        ? customPrompts
        : buildActionPrompts(options);

      expect(resolved.ok).toBe('Custom prompt for OK');
    });
  });

  // -----------------------------------------------------------------------
  // Phase 4: Full chain — register → resolve
  // -----------------------------------------------------------------------

  describe('full chain: register → callback resolution', () => {
    it('should register action prompts and resolve them on callback', () => {
      const chatId = 'oc_test_chat';
      const options = [
        { text: 'Approve', value: 'approve' },
        { text: 'Reject', value: 'reject' },
      ];
      const customPrompts = {
        approve: '[用户操作] 用户选择了「{{actionText}}」',
        reject: '[用户操作] 用户拒绝了「{{actionText}}」',
      };

      // Step 1: Build card (as IPC handler would)
      const card = buildInteractiveCard({
        question: 'Review this PR?',
        options,
        title: 'PR Review',
      });
      expect(card).toBeDefined();

      // Step 2: Register action prompts (simulates MCP Server registration)
      const syntheticMessageId = `interactive_${chatId}_${Date.now()}`;
      contextStore.register(syntheticMessageId, chatId, customPrompts);
      expect(contextStore.size).toBe(1);

      // Step 3: Simulate card action callback (user clicks "Approve")
      const resolvedPrompt = contextStore.generatePrompt(
        syntheticMessageId,
        chatId,
        'approve',
        'Approve',
      );

      expect(resolvedPrompt).toBe('[用户操作] 用户选择了「Approve」');

      // Step 4: Simulate card action callback (user clicks "Reject")
      const rejectPrompt = contextStore.generatePrompt(
        syntheticMessageId,
        chatId,
        'reject',
        'Reject',
      );

      expect(rejectPrompt).toBe('[用户操作] 用户拒绝了「Reject」');
    });

    it('should fall back to chatId-based lookup when messageId differs', () => {
      const chatId = 'oc_fallback_test';
      const syntheticMessageId = `interactive_${chatId}_${Date.now()}`;
      const realFeishuMessageId = 'om_real_feishu_id';

      contextStore.register(syntheticMessageId, chatId, {
        action1: 'Prompt for action1: {{actionText}}',
      });

      // Feishu callback uses the real messageId, not our synthetic one
      const prompt = contextStore.generatePrompt(
        realFeishuMessageId,
        chatId,
        'action1',
        'Click',
      );

      expect(prompt).toBe('Prompt for action1: Click');
    });

    it('should handle multiple cards in the same chat (multi-card coexistence)', () => {
      const chatId = 'oc_multi_card';
      const card1Id = `interactive_${chatId}_card1_${Date.now()}`;
      const card2Id = `interactive_${chatId}_card2_${Date.now() + 1}`;

      // Register two different cards for the same chat
      contextStore.register(card1Id, chatId, {
        option_a: 'Card1: User selected A',
        option_b: 'Card1: User selected B',
      });

      contextStore.register(card2Id, chatId, {
        option_x: 'Card2: User selected X',
        option_y: 'Card2: User selected Y',
      });

      expect(contextStore.size).toBe(2);

      // chatId-based lookup should return the LATEST card
      const latestPrompts = contextStore.getActionPromptsByChatId(chatId);
      expect(latestPrompts).toEqual({
        option_x: 'Card2: User selected X',
        option_y: 'Card2: User selected Y',
      });

      // But exact messageId lookup should still work for both cards
      expect(contextStore.getActionPrompts(card1Id)).toEqual({
        option_a: 'Card1: User selected A',
        option_b: 'Card1: User selected B',
      });
      expect(contextStore.getActionPrompts(card2Id)).toEqual({
        option_x: 'Card2: User selected X',
        option_y: 'Card2: User selected Y',
      });
    });
  });
});
