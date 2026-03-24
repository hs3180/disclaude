/**
 * Tests for Interactive Message Builder.
 */

import { describe, it, expect } from 'vitest';
import {
  buildInteractiveCard,
  buildActionPrompts,
} from './interactive-message-builder.js';

describe('Interactive Message Builder', () => {
  describe('buildInteractiveCard', () => {
    const defaultOptions = [
      { text: '✅ Yes', value: 'yes', type: 'primary' as const },
      { text: '❌ No', value: 'no', type: 'danger' as const },
    ];

    it('should build a card with question and options', () => {
      const card = buildInteractiveCard({
        question: 'Do you want to proceed?',
        options: defaultOptions,
      });

      expect(card).toHaveProperty('config.wide_screen_mode', true);
      expect(card).toHaveProperty('header');
      expect(card).toHaveProperty('elements');

      // Default title
      expect((card.header as { title: { content: string } }).title.content).toBe('交互消息');
    });

    it('should use custom title', () => {
      const card = buildInteractiveCard({
        question: 'Continue?',
        options: defaultOptions,
        title: 'Custom Title',
      });

      expect((card.header as { title: { content: string } }).title.content).toBe('Custom Title');
    });

    it('should include context section when provided', () => {
      const card = buildInteractiveCard({
        question: 'Proceed?',
        options: defaultOptions,
        context: 'Background information here',
      });

      const elements = card.elements as unknown[];
      expect(elements[0]).toEqual({ tag: 'markdown', content: 'Background information here' });
      expect(elements[1]).toEqual({ tag: 'markdown', content: 'Proceed?' });
    });

    it('should omit context section when not provided', () => {
      const card = buildInteractiveCard({
        question: 'Proceed?',
        options: defaultOptions,
      });

      const elements = card.elements as unknown[];
      expect(elements[0]).toEqual({ tag: 'markdown', content: 'Proceed?' });
    });

    it('should build correct element structure', () => {
      const card = buildInteractiveCard({
        question: 'Choose one:',
        options: [
          { text: 'Option A', value: 'a' },
          { text: 'Option B', value: 'b' },
        ],
      });

      const elements = card.elements as unknown[];

      // Question
      expect(elements[0]).toEqual({ tag: 'markdown', content: 'Choose one:' });

      // Divider
      expect(elements[1]).toEqual({ tag: 'hr' });

      // Action group
      const actionGroup = elements[2] as { tag: string; actions: unknown[] };
      expect(actionGroup.tag).toBe('action');
      expect(actionGroup.actions).toHaveLength(2);
    });

    it('should use plain string values for buttons', () => {
      const card = buildInteractiveCard({
        question: 'Choose:',
        options: [{ text: 'Click', value: 'click' }],
      });

      const elements = card.elements as unknown[];
      const actionGroup = elements[2] as { actions: Array<{ value: unknown }> };
      // Value should be plain string, not wrapped in object
      expect(actionGroup.actions[0].value).toBe('click');
    });

    it('should default button type to "default" when not specified', () => {
      const card = buildInteractiveCard({
        question: 'Choose:',
        options: [{ text: 'Click', value: 'click' }],
      });

      const elements = card.elements as unknown[];
      const actionGroup = elements[2] as { actions: Array<{ type: string }> };
      expect(actionGroup.actions[0].type).toBe('default');
    });

    it('should preserve button types', () => {
      const card = buildInteractiveCard({
        question: 'Choose:',
        options: [
          { text: 'Primary', value: 'p', type: 'primary' },
          { text: 'Danger', value: 'd', type: 'danger' },
          { text: 'Default', value: 'def' },
        ],
      });

      const elements = card.elements as unknown[];
      const actionGroup = elements[2] as { actions: Array<{ type: string }> };
      expect(actionGroup.actions[0].type).toBe('primary');
      expect(actionGroup.actions[1].type).toBe('danger');
      expect(actionGroup.actions[2].type).toBe('default');
    });

    it('should produce valid Feishu card structure', () => {
      const card = buildInteractiveCard({
        question: 'Test',
        options: [{ text: 'OK', value: 'ok' }],
        title: 'Test Card',
      });

      // Verify required Feishu card fields
      expect(card.config).toEqual({ wide_screen_mode: true });
      expect(card.header).toMatchObject({
        title: { tag: 'plain_text', content: 'Test Card' },
        template: 'blue',
      });
      expect(Array.isArray(card.elements)).toBe(true);
    });
  });

  describe('buildActionPrompts', () => {
    const defaultOptions = [
      { text: '✅ Approve', value: 'approve' },
      { text: '❌ Reject', value: 'reject' },
    ];

    it('should generate prompts using default template', () => {
      const prompts = buildActionPrompts(defaultOptions);

      expect(prompts).toEqual({
        approve: '[用户操作] 用户选择了「✅ Approve」',
        reject: '[用户操作] 用户选择了「❌ Reject」',
      });
    });

    it('should use custom prompts when provided', () => {
      const prompts = buildActionPrompts(defaultOptions, {
        approve: '[用户操作] 用户批准了此操作',
      });

      expect(prompts.approve).toBe('[用户操作] 用户批准了此操作');
      expect(prompts.reject).toBe('[用户操作] 用户选择了「❌ Reject」');
    });

    it('should use custom template', () => {
      const prompts = buildActionPrompts(
        [{ text: 'Click', value: 'click' }],
        undefined,
        'User clicked: {text} ({value})'
      );

      expect(prompts.click).toBe('User clicked: Click (click)');
    });

    it('should handle empty options', () => {
      const prompts = buildActionPrompts([]);
      expect(prompts).toEqual({});
    });

    it('should handle single option', () => {
      const prompts = buildActionPrompts([{ text: 'OK', value: 'ok' }]);

      expect(Object.keys(prompts)).toHaveLength(1);
      expect(prompts.ok).toBe('[用户操作] 用户选择了「OK」');
    });
  });
});
