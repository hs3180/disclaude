/**
 * Tests for Interactive Message Builder.
 *
 * Phase 2 of IPC Layer Responsibility Refactoring (#1568).
 */

import { describe, it, expect } from 'vitest';
import {
  buildInteractiveCard,
  buildActionPrompts,
  type InteractiveOption,
} from './interactive-message-builder.js';

describe('Interactive Message Builder', () => {
  describe('buildActionPrompts', () => {
    it('should build action prompts with default template', () => {
      const options: InteractiveOption[] = [
        { text: 'Confirm', value: 'confirm' },
        { text: 'Cancel', value: 'cancel' },
      ];

      const prompts = buildActionPrompts(options);

      expect(prompts).toEqual({
        confirm: '[用户操作] 用户点击了「Confirm」按钮',
        cancel: '[用户操作] 用户点击了「Cancel」按钮',
      });
    });

    it('should use custom prompt when provided', () => {
      const options: InteractiveOption[] = [
        { text: 'Delete', value: 'delete', prompt: 'User wants to delete.' },
        { text: 'Keep', value: 'keep' },
      ];

      const prompts = buildActionPrompts(options);

      expect(prompts).toEqual({
        delete: 'User wants to delete.',
        keep: '[用户操作] 用户点击了「Keep」按钮',
      });
    });

    it('should replace {{actionValue}} placeholder', () => {
      const options: InteractiveOption[] = [
        { text: 'Option A', value: 'a', prompt: 'Selected: {{actionValue}}' },
      ];

      const prompts = buildActionPrompts(options);

      expect(prompts.a).toBe('Selected: a');
    });

    it('should use custom default template', () => {
      const options: InteractiveOption[] = [
        { text: 'OK', value: 'ok' },
      ];

      const prompts = buildActionPrompts(options, 'User clicked {{actionText}}');

      expect(prompts.ok).toBe('User clicked OK');
    });

    it('should handle empty options', () => {
      const prompts = buildActionPrompts([]);
      expect(prompts).toEqual({});
    });
  });

  describe('buildInteractiveCard', () => {
    it('should build a card with question and options', () => {
      const result = buildInteractiveCard({
        question: 'What is your preference?',
        options: [
          { text: 'Option A', value: 'a', style: 'primary' },
          { text: 'Option B', value: 'b' },
        ],
      });

      // Card should have config and elements
      expect(result.card).toHaveProperty('config');
      expect(result.card.config.wide_screen_mode).toBe(true);
      expect(result.card).toHaveProperty('elements');

      // Should have content div, divider, and action group
      expect(result.card.elements.length).toBeGreaterThanOrEqual(2);

      // Action prompts should match options
      expect(result.actionPrompts).toHaveProperty('a');
      expect(result.actionPrompts).toHaveProperty('b');
    });

    it('should build a card with title', () => {
      const result = buildInteractiveCard({
        question: 'Choose one:',
        options: [{ text: 'Yes', value: 'yes', style: 'primary' }],
        title: 'Confirmation',
      });

      expect(result.card.header).toBeDefined();
      expect(result.card.header!.title.content).toBe('Confirmation');
      expect(result.card.header!.template).toBe('blue');
    });

    it('should build a card without title', () => {
      const result = buildInteractiveCard({
        question: 'Simple question',
        options: [{ text: 'OK', value: 'ok' }],
      });

      expect(result.card.header).toBeUndefined();
    });

    it('should build a card with custom template', () => {
      const result = buildInteractiveCard({
        question: 'Warning!',
        options: [{ text: 'Acknowledge', value: 'ack' }],
        title: 'Warning',
        template: 'red',
      });

      expect(result.card.header!.template).toBe('red');
    });

    it('should build a card with additional content', () => {
      const result = buildInteractiveCard({
        question: 'Proceed?',
        options: [{ text: 'Yes', value: 'yes' }],
        content: 'Here is some context information.',
      });

      // First element should be content div
      expect(result.card.elements[0]).toMatchObject({
        tag: 'div',
      });

      // Second element should be question div
      expect(result.card.elements[1]).toMatchObject({
        tag: 'div',
      });
    });

    it('should include action buttons with correct values', () => {
      const result = buildInteractiveCard({
        question: 'Pick one:',
        options: [
          { text: 'First', value: 'first', style: 'primary' },
          { text: 'Second', value: 'second', style: 'danger' },
        ],
      });

      // Find the action group element
      const actionGroup = result.card.elements.find(
        (el) => 'tag' in el && el.tag === 'action'
      );
      expect(actionGroup).toBeDefined();
      expect('actions' in actionGroup!).toBe(true);

      const actions = (actionGroup as unknown as { actions: Array<{ value: { action: string } }> }).actions;
      expect(actions).toHaveLength(2);
      expect(actions[0].value.action).toBe('first');
      expect(actions[1].value.action).toBe('second');
    });

    it('should generate action prompts matching button values', () => {
      const result = buildInteractiveCard({
        question: 'Choose:',
        options: [
          { text: 'Approve', value: 'approve', style: 'primary' },
          { text: 'Reject', value: 'reject', style: 'danger' },
          { text: 'Defer', value: 'defer' },
        ],
      });

      expect(Object.keys(result.actionPrompts)).toEqual(['approve', 'reject', 'defer']);
      expect(result.actionPrompts.approve).toContain('Approve');
      expect(result.actionPrompts.reject).toContain('Reject');
      expect(result.actionPrompts.defer).toContain('Defer');
    });

    it('should use custom prompts when provided in options', () => {
      const result = buildInteractiveCard({
        question: 'Delete?',
        options: [
          { text: 'Delete', value: 'delete', prompt: 'User confirmed deletion.' },
          { text: 'Cancel', value: 'cancel' },
        ],
      });

      expect(result.actionPrompts.delete).toBe('User confirmed deletion.');
      expect(result.actionPrompts.cancel).toContain('Cancel');
    });

    it('should handle single option', () => {
      const result = buildInteractiveCard({
        question: 'Acknowledge?',
        options: [{ text: 'Got it', value: 'got_it', style: 'primary' }],
        title: 'Notice',
      });

      expect(result.card.header!.title.content).toBe('Notice');
      expect(result.actionPrompts.got_it).toContain('Got it');
    });

    it('should produce valid Feishu card structure', () => {
      const result = buildInteractiveCard({
        question: 'Test question?',
        options: [{ text: 'OK', value: 'ok' }],
        title: 'Test',
      });

      // Verify the card has the required Feishu card fields
      expect(result.card).toHaveProperty('config');
      expect(result.card.config.wide_screen_mode).toBe(true);
      expect(result.card).toHaveProperty('elements');
      expect(Array.isArray(result.card.elements)).toBe(true);
    });
  });
});
