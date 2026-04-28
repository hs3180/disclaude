/**
 * Tests for PR Review Card Builder.
 *
 * Issue #2983: PR Review interactive card template design.
 */

import { describe, it, expect } from 'vitest';
import {
  buildPrDetailCard,
  buildPrMergedNotificationCard,
  buildPrClosedNotificationCard,
  type PrDetailCardParams,
} from './pr-review-card-builder.js';

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

const basePrParams: PrDetailCardParams = {
  prNumber: 1234,
  title: 'feat(core): add interactive card templates',
  author: 'developer',
  headRef: 'feature/card-templates',
  baseRef: 'main',
  additions: 120,
  deletions: 30,
  changedFiles: 8,
};

const fullPrParams: PrDetailCardParams = {
  ...basePrParams,
  body: 'This PR adds interactive card templates for the PR Scanner system. The templates include PR detail cards, merged/closed notifications, and disband confirmation.',
  changeSummary: '• Added pr-review-card-builder.ts with 3 card templates\n• Added unit tests for all templates\n• Updated card-builders index.ts exports',
};

// ---------------------------------------------------------------------------
// PR Detail Card
// ---------------------------------------------------------------------------

describe('buildPrDetailCard', () => {
  it('should build a card with correct header', () => {
    const { card } = buildPrDetailCard(basePrParams);

    expect(card.config).toEqual({ wide_screen_mode: true });
    expect(card.header).toBeDefined();
    expect(card.header!.title).toEqual({ tag: 'plain_text', content: 'PR Review #1234' });
    expect(card.header!.template).toBe('blue');
  });

  it('should include PR metadata in the first div element', () => {
    const { card } = buildPrDetailCard(basePrParams);
    const [firstElement] = card.elements;

    expect(firstElement.tag).toBe('div');
    if (firstElement.tag === 'div') {
      expect(firstElement.text.tag).toBe('lark_md');
      expect(firstElement.text.content).toContain('📝 **标题**: feat(core): add interactive card templates');
      expect(firstElement.text.content).toContain('👤 **作者**: developer');
      expect(firstElement.text.content).toContain('🔀 **分支**: feature/card-templates → main');
      expect(firstElement.text.content).toContain('📏 **变更**: +120 -30 (8 files)');
    }
  });

  it('should include divider after metadata', () => {
    const { card } = buildPrDetailCard(basePrParams);
    const [, secondElement] = card.elements;
    expect(secondElement.tag).toBe('hr');
  });

  it('should not include description section when body is empty', () => {
    const { card } = buildPrDetailCard(basePrParams);
    // elements: [metadata, divider, action_buttons, note]
    expect(card.elements.length).toBe(4);
    // No description section (index 2 should be action group, not description)
    const [, , thirdElement] = card.elements;
    expect(thirdElement.tag).toBe('action');
  });

  it('should include description section when body is provided', () => {
    const { card } = buildPrDetailCard(fullPrParams);
    // elements: [metadata, divider, description, divider, change_summary, divider, action_buttons, note]
    expect(card.elements.length).toBe(8);

    const [, , descElement] = card.elements;
    expect(descElement.tag).toBe('div');
    if (descElement.tag === 'div') {
      expect(descElement.text.content).toContain('📋 **描述**:');
      expect(descElement.text.content).toContain('This PR adds interactive card templates');
    }
  });

  it('should include change summary section when provided', () => {
    const { card } = buildPrDetailCard(fullPrParams);

    const [, , , , summaryElement] = card.elements;
    expect(summaryElement.tag).toBe('div');
    if (summaryElement.tag === 'div') {
      expect(summaryElement.text.content).toContain('🔍 **变更摘要**:');
      expect(summaryElement.text.content).toContain('Added pr-review-card-builder.ts');
    }
  });

  it('should truncate long body text to 500 characters', () => {
    const longBody = 'A'.repeat(600);
    const { card } = buildPrDetailCard({ ...basePrParams, body: longBody });

    const [, , descElement] = card.elements;
    expect(descElement.tag).toBe('div');
    if (descElement.tag === 'div') {
      const {content} = descElement.text;
      // Description prefix + 500 chars + "..."
      expect(content.length).toBeLessThan(longBody.length + 20);
      expect(content).toContain('...');
    }
  });

  it('should include action buttons with correct values and types', () => {
    const { card } = buildPrDetailCard(basePrParams);

    // Find action group element
    const actionGroup = card.elements.find(el => el.tag === 'action');
    expect(actionGroup).toBeDefined();

    // Type assertion to access actions
    const {actions} = (actionGroup as unknown as { actions: Array<{ tag: string; value: string; type: string }> });
    expect(actions).toHaveLength(3);

    expect(actions[0]).toMatchObject({
      tag: 'button',
      value: 'approve',
      type: 'primary',
    });
    expect(actions[0].text).toEqual({ tag: 'plain_text', content: '✅ Approve' });

    expect(actions[1]).toMatchObject({
      tag: 'button',
      value: 'close',
      type: 'danger',
    });

    expect(actions[2]).toMatchObject({
      tag: 'button',
      value: 'review',
      type: 'default',
    });
  });

  it('should include footer note with PR link', () => {
    const { card } = buildPrDetailCard(basePrParams);

    const noteElement = card.elements[card.elements.length - 1];
    expect(noteElement.tag).toBe('note');
    if (noteElement.tag === 'note') {
      expect(noteElement.elements[0].content).toContain(
        'https://github.com/hs3180/disclaude/pull/1234'
      );
    }
  });

  it('should return correct action prompts', () => {
    const { actionPrompts } = buildPrDetailCard(basePrParams);

    expect(Object.keys(actionPrompts)).toEqual(['approve', 'close', 'review']);

    expect(actionPrompts.approve).toContain('PR #1234');
    expect(actionPrompts.approve).toContain('gh pr review 1234');
    expect(actionPrompts.approve).toContain('--approve');

    expect(actionPrompts.close).toContain('gh pr close 1234');

    expect(actionPrompts.review).toContain('gh pr diff 1234');
    expect(actionPrompts.review).toContain('详细代码审查');
  });

  it('should embed PR number in action prompts', () => {
    const { actionPrompts } = buildPrDetailCard({ ...basePrParams, prNumber: 5678 });

    expect(actionPrompts.approve).toContain('PR #5678');
    expect(actionPrompts.approve).toContain('gh pr review 5678');
    expect(actionPrompts.close).toContain('gh pr close 5678');
    expect(actionPrompts.review).toContain('gh pr diff 5678');
  });

  it('should handle minimal params (no body, no changeSummary)', () => {
    const { card, actionPrompts } = buildPrDetailCard(basePrParams);

    // Should still have valid structure: [metadata, divider, actions, note]
    expect(card.elements.length).toBe(4);
    expect(card.header).toBeDefined();
    expect(Object.keys(actionPrompts)).toHaveLength(3);
  });

  it('should handle body without changeSummary', () => {
    const params = { ...basePrParams, body: 'Some description' };
    const { card } = buildPrDetailCard(params);

    // elements: [metadata, divider, description, divider, actions, note]
    expect(card.elements.length).toBe(6);
  });

  it('should handle changeSummary without body', () => {
    const params = { ...basePrParams, changeSummary: 'Some summary' };
    const { card } = buildPrDetailCard(params);

    // elements: [metadata, divider, summary, divider, actions, note]
    expect(card.elements.length).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// PR Merged Notification Card
// ---------------------------------------------------------------------------

describe('buildPrMergedNotificationCard', () => {
  it('should build a card with green header', () => {
    const { card } = buildPrMergedNotificationCard(1234, 'oc_test_chat');

    expect(card.config).toEqual({ wide_screen_mode: true });
    expect(card.header).toBeDefined();
    expect(card.header!.title.content).toBe('✅ PR #1234 has been merged');
    expect(card.header!.template).toBe('green');
  });

  it('should include disband button', () => {
    const { card } = buildPrMergedNotificationCard(1234, 'oc_test_chat');

    expect(card.elements).toHaveLength(1);
    const [actionGroup] = card.elements;
    expect(actionGroup.tag).toBe('action');

    const {actions} = (actionGroup as unknown as { actions: Array<{ tag: string; value: string; type: string }> });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      tag: 'button',
      value: 'disband',
      type: 'danger',
    });
    expect(actions[0].text).toEqual({ tag: 'plain_text', content: '解散群' });
  });

  it('should return correct action prompts with chatId', () => {
    const { actionPrompts } = buildPrMergedNotificationCard(1234, 'oc_test_chat');

    expect(Object.keys(actionPrompts)).toEqual(['disband']);
    expect(actionPrompts.disband).toContain('PR #1234');
    expect(actionPrompts.disband).toContain('lark-cli im chat disband --chat_id oc_test_chat');
    expect(actionPrompts.disband).toContain('pr-1234');
    expect(actionPrompts.disband).toContain('closed');
  });

  it('should embed PR number and chatId in disband prompt', () => {
    const { actionPrompts } = buildPrMergedNotificationCard(9999, 'oc_another_chat');

    expect(actionPrompts.disband).toContain('PR #9999');
    expect(actionPrompts.disband).toContain('oc_another_chat');
    expect(actionPrompts.disband).toContain('pr-9999');
  });
});

// ---------------------------------------------------------------------------
// PR Closed Notification Card
// ---------------------------------------------------------------------------

describe('buildPrClosedNotificationCard', () => {
  it('should build a card with red header', () => {
    const { card } = buildPrClosedNotificationCard(1234, 'oc_test_chat');

    expect(card.config).toEqual({ wide_screen_mode: true });
    expect(card.header).toBeDefined();
    expect(card.header!.title.content).toBe('❌ PR #1234 has been closed without merge');
    expect(card.header!.template).toBe('red');
  });

  it('should include disband button', () => {
    const { card } = buildPrClosedNotificationCard(1234, 'oc_test_chat');

    expect(card.elements).toHaveLength(1);
    const [actionGroup] = card.elements;
    expect(actionGroup.tag).toBe('action');

    const {actions} = (actionGroup as unknown as { actions: Array<{ tag: string; value: string; type: string }> });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      tag: 'button',
      value: 'disband',
      type: 'danger',
    });
  });

  it('should return correct action prompts with chatId', () => {
    const { actionPrompts } = buildPrClosedNotificationCard(1234, 'oc_test_chat');

    expect(Object.keys(actionPrompts)).toEqual(['disband']);
    expect(actionPrompts.disband).toContain('PR #1234');
    expect(actionPrompts.disband).toContain('lark-cli im chat disband --chat_id oc_test_chat');
    expect(actionPrompts.disband).toContain('pr-1234');
  });

  it('should have same action prompts structure as merged card', () => {
    const merged = buildPrMergedNotificationCard(1234, 'oc_test');
    const closed = buildPrClosedNotificationCard(1234, 'oc_test');

    // Same keys and same disband action content
    expect(Object.keys(merged.actionPrompts)).toEqual(Object.keys(closed.actionPrompts));
    expect(merged.actionPrompts.disband).toBe(closed.actionPrompts.disband);
  });
});

// ---------------------------------------------------------------------------
// Cross-template consistency checks
// ---------------------------------------------------------------------------

describe('Cross-template consistency', () => {
  it('all cards should have wide_screen_mode enabled', () => {
    const detail = buildPrDetailCard(basePrParams);
    const merged = buildPrMergedNotificationCard(1, 'oc_test');
    const closed = buildPrClosedNotificationCard(1, 'oc_test');

    expect(detail.card.config.wide_screen_mode).toBe(true);
    expect(merged.card.config.wide_screen_mode).toBe(true);
    expect(closed.card.config.wide_screen_mode).toBe(true);
  });

  it('all cards should have a header', () => {
    const detail = buildPrDetailCard(basePrParams);
    const merged = buildPrMergedNotificationCard(1, 'oc_test');
    const closed = buildPrClosedNotificationCard(1, 'oc_test');

    expect(detail.card.header).toBeDefined();
    expect(merged.card.header).toBeDefined();
    expect(closed.card.header).toBeDefined();
  });

  it('all action prompts should use [用户操作] prefix', () => {
    const detail = buildPrDetailCard(basePrParams);
    const merged = buildPrMergedNotificationCard(1, 'oc_test');
    const closed = buildPrClosedNotificationCard(1, 'oc_test');

    for (const prompt of Object.values(detail.actionPrompts)) {
      expect(prompt).toMatch(/^\[用户操作\]/);
    }
    for (const prompt of Object.values(merged.actionPrompts)) {
      expect(prompt).toMatch(/^\[用户操作\]/);
    }
    for (const prompt of Object.values(closed.actionPrompts)) {
      expect(prompt).toMatch(/^\[用户操作\]/);
    }
  });

  it('detail card should have distinct button values from notification cards', () => {
    const detail = buildPrDetailCard(basePrParams);
    const merged = buildPrMergedNotificationCard(1, 'oc_test');

    const detailValues = Object.keys(detail.actionPrompts);
    const notificationValues = Object.keys(merged.actionPrompts);

    // No overlap between detail card actions and notification card actions
    const overlap = detailValues.filter(v => notificationValues.includes(v));
    expect(overlap).toHaveLength(0);
  });
});
