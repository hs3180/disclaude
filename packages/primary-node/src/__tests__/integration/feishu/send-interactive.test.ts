/**
 * Feishu Integration Test: IPC sendInteractive full chain.
 *
 * Tests the complete sendInteractive flow:
 * 1. Card construction from parameters
 * 2. Action prompt generation (default and custom)
 * 3. Synthetic messageId format
 * 4. Integration with InteractiveContextStore (register → lookup → generate)
 *
 * P0 priority per Issue #1626.
 *
 * These tests are gated behind FEISHU_INTEGRATION_TEST=true.
 * They exercise the sendInteractive handler logic with a mock channel,
 * verifying the full card → actionPrompts → callback chain.
 *
 * @module integration/feishu/send-interactive
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InteractiveContextStore } from '../../../interactive-context.js';
import {
  buildInteractiveCard,
  buildActionPrompts,
  validateInteractiveParams,
} from '../../../platforms/feishu/card-builders/interactive-message-builder.js';
import { createChannelApiHandlers } from '../../../utils/channel-handlers.js';
import { createMockChannel, getSentMessages } from './helpers.js';

// ============================================================================
// Tests: Card building and validation (always runs — no API needed)
// ============================================================================

describe('sendInteractive: card building', () => {
  it('should build a card with question and buttons', () => {
    const card = buildInteractiveCard({
      question: 'Which option do you prefer?',
      options: [
        { text: '✅ Approve', value: 'approve', type: 'primary' },
        { text: '❌ Reject', value: 'reject', type: 'danger' },
      ],
      title: 'Code Review',
    });

    expect(card.config.wide_screen_mode).toBe(true);
    expect(card.header.title.content).toBe('Code Review');
    expect(card.header.template).toBe('blue');
    expect(card.elements).toHaveLength(3); // question + hr + action
  });

  it('should build a card with context section', () => {
    const card = buildInteractiveCard({
      question: 'Proceed with deployment?',
      context: 'PR #123 by @alice',
      options: [
        { text: 'Deploy', value: 'deploy' },
        { text: 'Cancel', value: 'cancel' },
      ],
    });

    const markdownElements = card.elements.filter((e) => e.tag === 'markdown');
    expect(markdownElements).toHaveLength(2);
    expect(markdownElements[0].content).toBe('PR #123 by @alice');
    expect(markdownElements[1].content).toBe('Proceed with deployment?');
  });

  it('should default title to "交互消息" when not provided', () => {
    const card = buildInteractiveCard({
      question: 'Test',
      options: [{ text: 'OK', value: 'ok' }],
    });
    expect(card.header.title.content).toBe('交互消息');
  });

  it('should support default button type', () => {
    const card = buildInteractiveCard({
      question: 'Pick one',
      options: [{ text: 'Normal', value: 'normal' }],
    });
    const actionGroup = card.elements.find((e) => e.tag === 'action');
    expect(actionGroup).toBeDefined();
    expect(actionGroup!.actions[0].type).toBe('default');
  });

  it('should preserve custom button types', () => {
    const card = buildInteractiveCard({
      question: 'Confirm?',
      options: [
        { text: 'Yes', value: 'yes', type: 'primary' },
        { text: 'No', value: 'no', type: 'danger' },
        { text: 'Later', value: 'later', type: 'default' },
      ],
    });
    const actionGroup = card.elements.find((e) => e.tag === 'action');
    expect(actionGroup!.actions.map((a) => a.type)).toEqual(['primary', 'danger', 'default']);
  });
});

// ============================================================================
// Tests: Param validation (always runs)
// ============================================================================

describe('sendInteractive: param validation', () => {
  it('should reject null params', () => {
    expect(validateInteractiveParams(null)).toBe('params must be a non-null object');
  });

  it('should reject non-object params', () => {
    expect(validateInteractiveParams('string')).toBe('params must be a non-null object');
  });

  it('should reject missing question', () => {
    expect(validateInteractiveParams({ options: [{ text: 'A', value: 'a' }] }))
      .toBe('params.question must be a non-empty string');
  });

  it('should reject empty question', () => {
    expect(validateInteractiveParams({ question: '  ', options: [{ text: 'A', value: 'a' }] }))
      .toBe('params.question must be a non-empty string');
  });

  it('should reject missing options', () => {
    expect(validateInteractiveParams({ question: 'Test?' })).toBe('params.options must be a non-empty array');
  });

  it('should reject empty options array', () => {
    expect(validateInteractiveParams({ question: 'Test?', options: [] }))
      .toBe('params.options must be a non-empty array');
  });

  it('should reject option with empty text', () => {
    expect(validateInteractiveParams({
      question: 'Test?',
      options: [{ text: '', value: 'a' }],
    })).toBe('params.options[0].text must be a non-empty string');
  });

  it('should reject option with empty value', () => {
    expect(validateInteractiveParams({
      question: 'Test?',
      options: [{ text: 'OK', value: '' }],
    })).toBe('params.options[0].value must be a non-empty string');
  });

  it('should reject option with invalid type', () => {
    expect(validateInteractiveParams({
      question: 'Test?',
      options: [{ text: 'OK', value: 'ok', type: 'invalid' }],
    })).toBe('params.options[0].type must be one of: primary, default, danger');
  });

  it('should accept valid params with minimal fields', () => {
    expect(validateInteractiveParams({
      question: 'Test?',
      options: [{ text: 'OK', value: 'ok' }],
    })).toBeNull();
  });

  it('should accept valid params with all fields', () => {
    expect(validateInteractiveParams({
      question: 'Deploy?',
      options: [
        { text: 'Yes', value: 'yes', type: 'primary' },
        { text: 'No', value: 'no', type: 'danger' },
      ],
      title: 'Deploy Gate',
      context: 'PR #42',
    })).toBeNull();
  });
});

// ============================================================================
// Tests: Action prompt generation (always runs)
// ============================================================================

describe('sendInteractive: action prompt generation', () => {
  it('should generate default action prompts from options', () => {
    const prompts = buildActionPrompts([
      { text: '✅ Approve', value: 'approve' },
      { text: '❌ Reject', value: 'reject' },
    ]);

    expect(prompts).toEqual({
      approve: '[用户操作] 用户选择了「✅ Approve」',
      reject: '[用户操作] 用户选择了「❌ Reject」',
    });
  });

  it('should use custom prompts when provided', () => {
    const prompts = buildActionPrompts(
      [{ text: 'OK', value: 'ok' }],
      { ok: 'User confirmed the action' }
    );

    expect(prompts).toEqual({ ok: 'User confirmed the action' });
  });

  it('should use custom prompts only for matching values', () => {
    const prompts = buildActionPrompts(
      [
        { text: 'Approve', value: 'approve' },
        { text: 'Reject', value: 'reject' },
      ],
      { approve: 'Custom approve prompt' }
    );

    expect(prompts.approve).toBe('Custom approve prompt');
    expect(prompts.reject).toBe('[用户操作] 用户选择了「Reject」');
  });

  it('should use custom template when provided', () => {
    const prompts = buildActionPrompts(
      [{ text: 'Click', value: 'click' }],
      undefined,
      'Action: {text} (value={value})'
    );

    expect(prompts).toEqual({ click: 'Action: Click (value=click)' });
  });
});

// ============================================================================
// Tests: sendInteractive handler with mock channel (always runs)
// ============================================================================

describe('sendInteractive: handler integration with mock channel', () => {
  let mockChannel: ReturnType<typeof createMockChannel>;

  beforeEach(() => {
    mockChannel = createMockChannel();
  });

  it('should send card via channel.sendMessage', async () => {
    const handlers = createChannelApiHandlers(mockChannel, {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      channelName: 'Feishu',
    });

    const card = buildInteractiveCard({
      question: 'Test question',
      options: [{ text: 'OK', value: 'ok' }],
    });

    await handlers.sendCard('test-chat-id', card, undefined, 'Test description');

    const sent = getSentMessages(mockChannel);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      chatId: 'test-chat-id',
      type: 'card',
      description: 'Test description',
    });
  });

  it('should send text message via channel.sendMessage', async () => {
    const handlers = createChannelApiHandlers(mockChannel, {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      channelName: 'Feishu',
    });

    await handlers.sendMessage('test-chat-id', 'Hello from test');

    const sent = getSentMessages(mockChannel);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      chatId: 'test-chat-id',
      type: 'text',
      text: 'Hello from test',
    });
  });

  it('should send file via channel.sendMessage and return metadata', async () => {
    const handlers = createChannelApiHandlers(mockChannel, {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      channelName: 'Feishu',
    });

    const result = await handlers.uploadFile('test-chat-id', '/tmp/test-report.pdf');

    const sent = getSentMessages(mockChannel);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      chatId: 'test-chat-id',
      type: 'file',
      filePath: '/tmp/test-report.pdf',
    });
    expect(result).toEqual({
      fileKey: '',
      fileType: 'file',
      fileName: 'test-report.pdf',
      fileSize: 0,
    });
  });
});

// ============================================================================
// Tests: Full chain — card → actionPrompts → InteractiveContextStore (always runs)
// ============================================================================

describe('sendInteractive: full chain with InteractiveContextStore', () => {
  let store: InteractiveContextStore;

  beforeEach(() => {
    store = new InteractiveContextStore();
  });

  it('should simulate the complete sendInteractive → register → generate flow', () => {
    // Step 1: Build card (as sendInteractive handler does)
    const options: Array<{ text: string; value: string; type?: 'primary' | 'default' | 'danger' }> = [
      { text: '✅ Deploy', value: 'deploy', type: 'primary' },
      { text: '❌ Cancel', value: 'cancel', type: 'danger' },
      { text: '⏸️ Defer', value: 'defer' },
    ];
    const card = buildInteractiveCard({
      question: 'Deploy v2.0 to production?',
      context: 'Release #42 — 3 commits ahead of main',
      options,
    });

    // Verify card structure
    expect(card.header.title.content).toBe('交互消息');
    expect(card.elements.filter((e) => e.tag === 'markdown')).toHaveLength(2);

    // Step 2: Generate action prompts (as sendInteractive handler does)
    const actionPrompts = buildActionPrompts(options);
    expect(Object.keys(actionPrompts)).toEqual(['deploy', 'cancel', 'defer']);

    // Step 3: Generate synthetic messageId (as sendInteractive handler does)
    const chatId = 'oc_test_chat';
    const syntheticMessageId = `interactive_${chatId}_${Date.now()}`;
    expect(syntheticMessageId).toMatch(/^interactive_oc_test_chat_\d+$/);

    // Step 4: Register in store (MCP server would do this)
    store.register(syntheticMessageId, chatId, actionPrompts);
    expect(store.size).toBe(1);

    // Step 5: Simulate card action callback
    const prompt = store.generatePrompt(syntheticMessageId, chatId, 'deploy', '✅ Deploy');
    expect(prompt).toBe('[用户操作] 用户选择了「✅ Deploy」');
  });

  it('should handle cross-card lookup in the full chain', () => {
    const chatId = 'oc_group_chat';

    // Card A: sent by IPC script with AI-related actions
    const cardAOptions = [
      { text: 'Explain AI', value: 'explain_ai' },
      { text: 'AI Applications', value: 'ai_applications' },
    ];
    const promptsA = buildActionPrompts(cardAOptions);
    const messageIdA = `interactive_${chatId}_${Date.now() - 5000}`;
    store.register(messageIdA, chatId, promptsA);

    // Card B: sent by Agent with confirmation actions
    const cardBOptions: Array<{ text: string; value: string; type?: 'primary' | 'default' | 'danger' }> = [
      { text: 'Yes', value: 'yes', type: 'primary' },
      { text: 'No', value: 'no', type: 'danger' },
    ];
    const promptsB = buildActionPrompts(cardBOptions);
    const messageIdB = `interactive_${chatId}_${Date.now()}`;
    store.register(messageIdB, chatId, promptsB);

    expect(store.size).toBe(2);

    // User clicks Card A's "Explain AI" button, but Feishu sends different messageId
    const feishuMessageId = 'om_real_feishu_msg_id';
    const prompt = store.generatePrompt(feishuMessageId, chatId, 'explain_ai', 'Explain AI');
    expect(prompt).toBe('[用户操作] 用户选择了「Explain AI」');

    // User clicks Card B's "Yes" button
    const prompt2 = store.generatePrompt(feishuMessageId, chatId, 'yes', 'Yes');
    expect(prompt2).toBe('[用户操作] 用户选择了「Yes」');
  });

  it('should handle LRU eviction in the full chain', () => {
    const store = new InteractiveContextStore(24 * 60 * 60 * 1000, 2);
    const chatId = 'oc_lru_test';

    // Register 3 cards (max is 2)
    for (let i = 1; i <= 3; i++) {
      const options = [{ text: `Card ${i}`, value: `card_${i}` }];
      const prompts = buildActionPrompts(options);
      const messageId = `interactive_${chatId}_${Date.now() + i}`;
      store.register(messageId, chatId, prompts);
    }

    // Only 2 should remain
    expect(store.size).toBe(2);

    // Oldest card (card_1) should be evicted
    const evictedPrompt = store.generatePrompt('unknown', chatId, 'card_1', 'Card 1');
    expect(evictedPrompt).toBeUndefined();
  });

  it('should handle custom action prompts in the full chain', () => {
    const chatId = 'oc_custom_prompt';

    const options = [
      { text: 'Confirm', value: 'confirm' },
      { text: 'Cancel', value: 'cancel' },
    ];
    const customPrompts = {
      confirm: '[Deploy] User approved deployment of v2.0',
      cancel: '[Deploy] User cancelled deployment',
    };
    const prompts = buildActionPrompts(options, customPrompts);
    const messageId = `interactive_${chatId}_${Date.now()}`;
    store.register(messageId, chatId, prompts);

    const prompt = store.generatePrompt(messageId, chatId, 'confirm', 'Confirm');
    expect(prompt).toBe('[Deploy] User approved deployment of v2.0');
  });
});
