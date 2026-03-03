/**
 * Tests for Human-in-the-Loop Tools.
 *
 * @see Issue #532 - Human-in-the-Loop interaction system
 */

import { describe, it, expect, vi } from 'vitest';
import { formatMention, buildInteractionCard } from './human-loop-tools.js';
import type { InteractionButton } from './types.js';

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}));

describe('HumanLoopTools', () => {
  describe('formatMention', () => {
    it('should format @mention correctly', () => {
      const mention = formatMention('ou_user_123');
      expect(mention).toBe('<at user_id="ou_user_123"></at>');
    });

    it('should handle different open_id formats', () => {
      expect(formatMention('ou_abc')).toBe('<at user_id="ou_abc"></at>');
      expect(formatMention('ou_12345678')).toBe('<at user_id="ou_12345678"></at>');
    });
  });

  describe('buildInteractionCard', () => {
    it('should build a valid Feishu card with buttons', () => {
      const title = 'Confirm Action';
      const content = 'Do you want to proceed?';
      const buttons: InteractionButton[] = [
        { label: 'Yes', value: 'confirm', promptTemplate: 'User confirmed to proceed' },
        { label: 'No', value: 'cancel', promptTemplate: 'User cancelled the action' },
      ];

      const card = buildInteractionCard(title, content, buttons);

      // Verify card structure
      expect(card).toHaveProperty('config');
      expect(card).toHaveProperty('header');
      expect(card).toHaveProperty('elements');

      // Verify header
      const header = card.header as { title: { content: string } };
      expect(header.title.content).toBe(title);

      // Verify elements
      const elements = card.elements as Array<{ tag: string }>;
      expect(elements.length).toBe(2);
      expect(elements[0].tag).toBe('markdown');
      expect(elements[1].tag).toBe('action');
    });

    it('should include prompt templates in button values', () => {
      const buttons: InteractionButton[] = [
        { label: 'Approve', value: 'approve', promptTemplate: 'User approved the request' },
      ];

      const card = buildInteractionCard('Test', 'Content', buttons);
      const elements = card.elements as Array<{
        tag: string;
        actions?: Array<{ value: { prompt: string } }>;
      }>;
      const actionElement = elements[1];

      expect(actionElement.actions?.[0]?.value?.prompt).toBe('User approved the request');
    });
  });
});
