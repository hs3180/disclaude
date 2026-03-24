/**
 * Tests for Interactive Message Builder.
 */

import { describe, it, expect } from 'vitest';
import {
  buildInteractiveCard,
  buildActionPrompts,
  validateInteractiveParams,
  type InteractiveCard,
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
      expect(card.header.title.content).toBe('交互消息');
    });

    it('should use custom title', () => {
      const card = buildInteractiveCard({
        question: 'Continue?',
        options: defaultOptions,
        title: 'Custom Title',
      });

      expect(card.header.title.content).toBe('Custom Title');
    });

    it('should include context section when provided', () => {
      const card = buildInteractiveCard({
        question: 'Proceed?',
        options: defaultOptions,
        context: 'Background information here',
      });

      const markdownElements = card.elements.filter((e) => e.tag === 'markdown');
      expect(markdownElements).toHaveLength(2);
      expect(markdownElements[0]).toEqual({ tag: 'markdown', content: 'Background information here' });
      expect(markdownElements[1]).toEqual({ tag: 'markdown', content: 'Proceed?' });
    });

    it('should omit context section when not provided', () => {
      const card = buildInteractiveCard({
        question: 'Proceed?',
        options: defaultOptions,
      });

      const markdownElements = card.elements.filter((e) => e.tag === 'markdown');
      expect(markdownElements).toHaveLength(1);
      expect(markdownElements[0]).toEqual({ tag: 'markdown', content: 'Proceed?' });
    });

    it('should build correct element structure', () => {
      const card = buildInteractiveCard({
        question: 'Choose one:',
        options: [
          { text: 'Option A', value: 'a' },
          { text: 'Option B', value: 'b' },
        ],
      });

      // Question
      expect(card.elements[0]).toEqual({ tag: 'markdown', content: 'Choose one:' });

      // Divider
      expect(card.elements[1]).toEqual({ tag: 'hr' });

      // Action group
      const actionGroup = card.elements.find((e) => e.tag === 'action');
      expect(actionGroup).toBeDefined();
      if (actionGroup && actionGroup.tag === 'action') {
        expect(actionGroup.actions).toHaveLength(2);
      }
    });

    it('should use plain string values for buttons', () => {
      const card = buildInteractiveCard({
        question: 'Choose:',
        options: [{ text: 'Click', value: 'click' }],
      });

      const actionGroup = card.elements.find((e) => e.tag === 'action');
      expect(actionGroup).toBeDefined();
      if (actionGroup && actionGroup.tag === 'action') {
        // Value should be plain string, not wrapped in object
        expect(actionGroup.actions[0].value).toBe('click');
      }
    });

    it('should default button type to "default" when not specified', () => {
      const card = buildInteractiveCard({
        question: 'Choose:',
        options: [{ text: 'Click', value: 'click' }],
      });

      const actionGroup = card.elements.find((e) => e.tag === 'action');
      expect(actionGroup).toBeDefined();
      if (actionGroup && actionGroup.tag === 'action') {
        expect(actionGroup.actions[0].type).toBe('default');
      }
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

      const actionGroup = card.elements.find((e) => e.tag === 'action');
      expect(actionGroup).toBeDefined();
      if (actionGroup && actionGroup.tag === 'action') {
        expect(actionGroup.actions[0].type).toBe('primary');
        expect(actionGroup.actions[1].type).toBe('danger');
        expect(actionGroup.actions[2].type).toBe('default');
      }
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

    it('should return strongly-typed InteractiveCard', () => {
      const card = buildInteractiveCard({
        question: 'Test',
        options: [{ text: 'OK', value: 'ok' }],
      });

      // Verify TypeScript type is correct (no unknown types)
      const typedCard: InteractiveCard = card;
      expect(typedCard).toBeDefined();
      expect(typeof typedCard.config.wide_screen_mode).toBe('boolean');
      expect(typeof typedCard.header.title.content).toBe('string');
      expect(typeof typedCard.header.template).toBe('string');
      expect(Array.isArray(typedCard.elements)).toBe(true);
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

  describe('validateInteractiveParams', () => {
    it('should return error for null params', () => {
      expect(validateInteractiveParams(null)).toBe('params must be a non-null object');
    });

    it('should return error for non-object params', () => {
      expect(validateInteractiveParams('string')).toBe('params must be a non-null object');
    });

    it('should return error for missing question', () => {
      expect(validateInteractiveParams({ options: [{ text: 'A', value: 'a' }] }))
        .toBe('params.question must be a non-empty string');
    });

    it('should return error for empty question', () => {
      expect(validateInteractiveParams({ question: '  ', options: [{ text: 'A', value: 'a' }] }))
        .toBe('params.question must be a non-empty string');
    });

    it('should return error for missing options', () => {
      expect(validateInteractiveParams({ question: 'Q?' }))
        .toBe('params.options must be a non-empty array');
    });

    it('should return error for empty options array', () => {
      expect(validateInteractiveParams({ question: 'Q?', options: [] }))
        .toBe('params.options must be a non-empty array');
    });

    it('should return error for option with empty text', () => {
      expect(validateInteractiveParams({ question: 'Q?', options: [{ text: '', value: 'a' }] }))
        .toBe('params.options[0].text must be a non-empty string');
    });

    it('should return error for option with empty value', () => {
      expect(validateInteractiveParams({ question: 'Q?', options: [{ text: 'A', value: '' }] }))
        .toBe('params.options[0].value must be a non-empty string');
    });

    it('should return error for invalid button type', () => {
      expect(validateInteractiveParams({ question: 'Q?', options: [{ text: 'A', value: 'a', type: 'invalid' }] }))
        .toBe('params.options[0].type must be one of: primary, default, danger');
    });

    it('should return null for valid params', () => {
      const result = validateInteractiveParams({
        question: 'Choose?',
        options: [{ text: 'OK', value: 'ok', type: 'primary' }],
      });
      expect(result).toBeNull();
    });

    it('should accept valid params without optional fields', () => {
      const result = validateInteractiveParams({
        question: 'Choose?',
        options: [{ text: 'OK', value: 'ok' }],
      });
      expect(result).toBeNull();
    });

    it('should accept valid params with all optional fields', () => {
      const result = validateInteractiveParams({
        question: 'Choose?',
        options: [{ text: 'OK', value: 'ok' }],
        title: 'Title',
        context: 'Context',
      });
      expect(result).toBeNull();
    });

    it('should reject non-string title', () => {
      const result = validateInteractiveParams({
        question: 'Q?',
        options: [{ text: 'A', value: 'a' }],
        title: 123,
      });
      expect(result).toBe('params.title must be a string if provided');
    });

    it('should reject non-string context', () => {
      const result = validateInteractiveParams({
        question: 'Q?',
        options: [{ text: 'A', value: 'a' }],
        context: {},
      });
      expect(result).toBe('params.context must be a string if provided');
    });
  });
});
