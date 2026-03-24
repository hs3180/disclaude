/**
 * Tests for Interactive Message Builder.
 *
 * Issue #1571 (Phase 2 of IPC Layer Responsibility Refactoring).
 */

import { describe, it, expect } from 'vitest';
import {
  buildInteractiveCard,
  buildActionPrompts,
} from './interactive-message-builder.js';

describe('Interactive Message Builder', () => {
  describe('buildInteractiveCard', () => {
    it('should build a card with question and options', () => {
      const card = buildInteractiveCard({
        question: 'Choose an option:',
        options: [
          { text: 'Option A', value: 'a', type: 'primary' },
          { text: 'Option B', value: 'b' },
        ],
      });

      expect(card).toHaveProperty('config.wide_screen_mode', true);
      expect(card).toHaveProperty('elements');
      expect(card.elements).toHaveLength(3); // question + hr + action group
    });

    it('should build a card with title', () => {
      const card = buildInteractiveCard({
        question: 'Proceed?',
        options: [{ text: 'Yes', value: 'yes' }],
        title: 'Confirmation',
      });

      expect(card.header).toBeDefined();
      expect(card.header!.title.content).toBe('Confirmation');
      expect(card.header!.template).toBe('blue');
    });

    it('should build a card without title when not provided', () => {
      const card = buildInteractiveCard({
        question: 'Proceed?',
        options: [{ text: 'Yes', value: 'yes' }],
      });

      expect(card.header).toBeUndefined();
    });

    it('should build a card with context section', () => {
      const card = buildInteractiveCard({
        question: 'Choose:',
        options: [{ text: 'OK', value: 'ok' }],
        context: 'Some background info',
      });

      expect(card.elements).toHaveLength(4); // context + question + hr + action group
      expect(card.elements[0]).toEqual({
        tag: 'markdown',
        content: 'Some background info',
      });
    });

    it('should not add context section when not provided', () => {
      const card = buildInteractiveCard({
        question: 'Choose:',
        options: [{ text: 'OK', value: 'ok' }],
      });

      expect(card.elements).toHaveLength(3); // question + hr + action group
    });

    it('should include a divider between content and actions', () => {
      const card = buildInteractiveCard({
        question: 'Choose:',
        options: [{ text: 'OK', value: 'ok' }],
      });

      expect(card.elements[1]).toEqual({ tag: 'hr' });
    });

    it('should build action group with correct button structure', () => {
      const card = buildInteractiveCard({
        question: 'Choose:',
        options: [
          { text: 'Confirm', value: 'confirm', type: 'primary' },
          { text: 'Cancel', value: 'cancel', type: 'danger' },
          { text: 'Maybe', value: 'maybe' },
        ],
      });

      const actionElement = card.elements[2] as { tag: string; actions: unknown[] };
      expect(actionElement.tag).toBe('action');
      expect(actionElement.actions).toHaveLength(3);

      const buttons = actionElement.actions as Array<{
        tag: string;
        text: { tag: string; content: string };
        type: string;
        value: string;
      }>;

      expect(buttons[0].text.content).toBe('Confirm');
      expect(buttons[0].type).toBe('primary');
      expect(buttons[0].value).toBe('confirm');

      expect(buttons[1].text.content).toBe('Cancel');
      expect(buttons[1].type).toBe('danger');

      expect(buttons[2].text.content).toBe('Maybe');
      expect(buttons[2].type).toBe('default');
    });

    it('should default button type to "default" when not specified', () => {
      const card = buildInteractiveCard({
        question: 'Choose:',
        options: [{ text: 'Click', value: 'click' }],
      });

      const actionElement = card.elements[2] as { actions: Array<{ type: string }> };
      expect(actionElement.actions[0].type).toBe('default');
    });

    it('should produce valid Feishu card structure', () => {
      const card = buildInteractiveCard({
        question: 'Test question?',
        options: [{ text: 'OK', value: 'ok', type: 'primary' }],
        title: 'Test',
      });

      // Verify it can be serialized to JSON (Feishu API requirement)
      const json = JSON.stringify(card);
      expect(json).toBeTruthy();

      const parsed = JSON.parse(json);
      expect(parsed.config.wide_screen_mode).toBe(true);
      expect(parsed.header.title.content).toBe('Test');
      expect(parsed.elements).toBeInstanceOf(Array);
    });
  });

  describe('buildActionPrompts', () => {
    it('should build prompts from options with default template', () => {
      const prompts = buildActionPrompts([
        { text: 'Confirm', value: 'confirm' },
        { text: 'Cancel', value: 'cancel' },
      ]);

      expect(prompts).toEqual({
        confirm: '[用户操作] 用户选择了「Confirm」',
        cancel: '[用户操作] 用户选择了「Cancel」',
      });
    });

    it('should build prompts with custom template', () => {
      const prompts = buildActionPrompts(
        [{ text: 'Approve', value: 'approve' }],
        '[用户操作] 用户点击了「{{text}}」按钮，请继续执行任务。'
      );

      expect(prompts).toEqual({
        approve: '[用户操作] 用户点击了「Approve」按钮，请继续执行任务。',
      });
    });

    it('should handle empty options array', () => {
      const prompts = buildActionPrompts([]);
      expect(prompts).toEqual({});
    });

    it('should handle single option', () => {
      const prompts = buildActionPrompts([
        { text: 'OK', value: 'ok' },
      ]);

      expect(Object.keys(prompts)).toHaveLength(1);
      expect(prompts.ok).toBe('[用户操作] 用户选择了「OK」');
    });

    it('should replace {{text}} placeholder in custom template', () => {
      const prompts = buildActionPrompts(
        [{ text: 'Delete', value: 'delete' }],
        'User clicked {{text}}'
      );

      expect(prompts.delete).toBe('User clicked Delete');
    });

    it('should handle special characters in option text', () => {
      const prompts = buildActionPrompts([
        { text: '提交 PR #123', value: 'submit_pr' },
      ]);

      expect(prompts.submit_pr).toBe('[用户操作] 用户选择了「提交 PR #123」');
    });
  });
});
