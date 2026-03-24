/**
 * Unit tests for card-builder utilities.
 *
 * Issue #1570: Phase 1 — MCP Tool 轻量化.
 * Tests for card building functions moved from mcp-server to core.
 */

import { describe, it, expect } from 'vitest';
import { buildQuestionCard, buildActionPrompts, type AskUserOption } from './card-builder.js';

describe('card-builder', () => {
  describe('buildQuestionCard', () => {
    it('should build a card with default title', () => {
      const options: AskUserOption[] = [
        { text: 'Option A', value: 'a' },
        { text: 'Option B', value: 'b' },
      ];

      const card = buildQuestionCard('What is your choice?', options);

      expect(card.config).toEqual({ wide_screen_mode: true });
      expect(card.header).toEqual({
        title: { tag: 'plain_text', content: '🤖 Agent 提问' },
        template: 'blue',
      });
      expect(Array.isArray(card.elements)).toBe(true);
    });

    it('should use custom title when provided', () => {
      const options: AskUserOption[] = [{ text: 'OK', value: 'ok' }];
      const card = buildQuestionCard('Question?', options, 'Custom Title');

      expect((card.header as Record<string, unknown>).title).toBeDefined();
      expect(((card.header as Record<string, unknown>).title as Record<string, unknown>).content).toBe('Custom Title');
    });

    it('should build buttons from options', () => {
      const options: AskUserOption[] = [
        { text: 'Primary', value: 'p', style: 'primary' },
        { text: 'Danger', value: 'd', style: 'danger' },
        { text: 'Default', value: 'def' },
      ];

      const card = buildQuestionCard('Pick one', options);
      const elements = card.elements as Array<Record<string, unknown>>;
      const action = elements[1] as { tag: string; actions: Array<Record<string, unknown>> };
      expect(action.tag).toBe('action');
      expect(action.actions).toHaveLength(3);

      expect(action.actions[0]).toMatchObject({ tag: 'button', type: 'primary' });
      expect(action.actions[0].text).toEqual({ tag: 'plain_text', content: 'Primary' });
      expect(action.actions[0].value).toBe('p');

      expect(action.actions[1]).toMatchObject({ tag: 'button', type: 'danger' });

      expect(action.actions[2]).toMatchObject({ tag: 'button', type: 'default' });
    });

    it('should generate default values for options without value', () => {
      const options: AskUserOption[] = [
        { text: 'First' },
        { text: 'Second' },
      ];

      const card = buildQuestionCard('Pick', options);
      const elements = card.elements as Array<Record<string, unknown>>;
      const action = elements[1] as { tag: string; actions: Array<Record<string, unknown>> };

      expect(action.actions[0].value).toBe('option_0');
      expect(action.actions[1].value).toBe('option_1');
    });

    it('should include question as markdown element', () => {
      const options: AskUserOption[] = [{ text: 'OK', value: 'ok' }];
      const card = buildQuestionCard('Hello **world**?', options);

      const elements = card.elements as Array<Record<string, unknown>>;
      const markdown = elements[0] as { tag: string; content: string };
      expect(markdown.tag).toBe('markdown');
      expect(markdown.content).toBe('Hello **world**?');
    });
  });

  describe('buildActionPrompts', () => {
    it('should build prompts from options', () => {
      const options: AskUserOption[] = [
        { text: 'Merge', value: 'merge' },
        { text: 'Close', value: 'close' },
      ];

      const prompts = buildActionPrompts(options);

      expect(Object.keys(prompts)).toEqual(['merge', 'close']);
      expect(prompts.merge).toContain('用户选择了「Merge」选项');
      expect(prompts.close).toContain('用户选择了「Close」选项');
    });

    it('should include context when provided', () => {
      const options: AskUserOption[] = [{ text: 'OK', value: 'ok' }];
      const prompts = buildActionPrompts(options, 'PR #123');

      expect(prompts.ok).toContain('PR #123');
    });

    it('should include action description when provided', () => {
      const options: AskUserOption[] = [
        { text: 'Merge', value: 'merge', action: '执行 gh pr merge' },
      ];

      const prompts = buildActionPrompts(options);

      expect(prompts.merge).toContain('执行 gh pr merge');
    });

    it('should generate default values for options without value', () => {
      const options: AskUserOption[] = [
        { text: 'First' },
        { text: 'Second' },
      ];

      const prompts = buildActionPrompts(options);

      expect(Object.keys(prompts)).toEqual(['option_0', 'option_1']);
    });

    it('should return empty object for empty options', () => {
      const prompts = buildActionPrompts([]);
      expect(prompts).toEqual({});
    });
  });
});
