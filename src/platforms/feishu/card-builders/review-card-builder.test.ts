/**
 * Tests for Review Card Builder.
 *
 * This module tests the review card builder functionality for the
 * "御书房批奏折" review experience (Issue #946).
 */

import { describe, it, expect } from 'vitest';
import {
  buildReviewCard,
  buildQuickReviewCard,
  REVIEW_THEMES,
  type ReviewCardConfig,
} from './review-card-builder.js';

describe('Review Card Builder', () => {
  describe('buildReviewCard', () => {
    it('should build imperial theme card', () => {
      const config: ReviewCardConfig = {
        title: 'Code Review',
        changes: [
          { path: 'src/utils/helper.ts', type: 'modified', additions: 5, deletions: 2 },
          { path: 'src/new-feature.ts', type: 'added', additions: 10 },
          { path: 'src/deprecated.ts', type: 'deleted', deletions: 50 },
        ],
        theme: 'imperial',
        summary: 'Added new feature, refactored helper function',
        details: 'See commit details for more information...',
        footerNote: 'Generated with Claude Code',
      };
      const card = buildReviewCard(config);

      expect(card.header!.title.content).toBe('🏛️ 御书房');
      expect(card.header!.template).toBe('red');
      expect(card.elements.length).toBeGreaterThan(0);
    });

    it('should build modern theme card', () => {
      const config: ReviewCardConfig = {
        title: 'Code Review',
        changes: [
          { path: 'src/utils/helper.ts', type: 'modified', additions: 5, deletions: 2 },
          { path: 'src/new-feature.ts', type: 'added', additions: 10 },
        ],
        theme: 'modern',
        summary: 'Refactored helper function',
      };
      const card = buildReviewCard(config);

      expect(card.header!.title.content).toBe('📋 审批中心');
      expect(card.header!.template).toBe('blue');
    });

    it('should build minimal theme card', () => {
      const config: ReviewCardConfig = {
        title: 'Code Review',
        changes: [
          { path: 'src/utils/helper.ts', type: 'modified' },
        ],
        theme: 'minimal',
        summary: 'Minor changes',
      };
      const card = buildReviewCard(config);

      expect(card.header!.title.content).toBe('审核请求');
      expect(card.header!.template).toBe('grey');
    });

    it('should build card without changes', () => {
      const config: ReviewCardConfig = {
        title: 'Simple Review',
        summary: 'Please review this change',
      };
      const card = buildReviewCard(config);

      expect(card.header!.title.content).toBe('📋 审批中心');
      expect(card.elements.length).toBeGreaterThan(0);
    });

    it('should build card with custom theme', () => {
      const config: ReviewCardConfig = {
        title: 'Custom Review',
        changes: [{ path: 'file.ts', type: 'modified' }],
        theme: {
          title: '🎯 Custom Theme',
          template: 'purple',
          approveText: 'Accept',
          rejectText: 'Decline',
          requestChangesText: 'Revise',
          viewDetailsText: 'Details',
          icon: '✨',
        },
        summary: 'Custom themed review',
      };
      const card = buildReviewCard(config);

      expect(card.header!.title.content).toBe('🎯 Custom Theme');
      expect(card.header!.template).toBe('purple');
    });

    it('should build card with many changes', () => {
      const config: ReviewCardConfig = {
        title: 'Large Review',
        changes: Array.from({ length: 20 }, (_, i) => ({
          path: `src/file${i}.ts`,
          type: 'modified' as const,
        })),
        theme: 'modern',
        summary: 'Many files changed',
      };
      const card = buildReviewCard(config);

      expect(card.header).toBeDefined();
      expect(card.elements.length).toBeGreaterThan(0);
    });
  });

  describe('buildQuickReviewCard', () => {
    it('should build quick review card with imperial theme', () => {
        const card = buildQuickReviewCard(
          'Quick Review',
          'Please review this change',
          'approve',
          'reject',
          'imperial'
        );

        expect(card.header!.title.content).toBe('🏛️ 御书房');
        expect(card.elements.length).toBeGreaterThan(0);
    });

    it('should build quick review card with modern theme', () => {
      const card = buildQuickReviewCard(
        'Empty Review',
        'Nothing to review',
        'approve',
        'reject',
        'modern'
      );

      expect(card.header!.title.content).toBe('📋 审批中心');
    });
  });

  describe('REVIEW_THEMES', () => {
    it('should have imperial theme', () => {
      expect(REVIEW_THEMES.imperial.title).toBe('🏛️ 御书房');
      expect(REVIEW_THEMES.imperial.template).toBe('red');
      expect(REVIEW_THEMES.imperial.approveText).toBe('👑 准奏');
    });

    it('should have modern theme', () => {
      expect(REVIEW_THEMES.modern.title).toBe('📋 审批中心');
      expect(REVIEW_THEMES.modern.template).toBe('blue');
    });

    it('should have minimal theme', () => {
      expect(REVIEW_THEMES.minimal.title).toBe('审核请求');
      expect(REVIEW_THEMES.minimal.template).toBe('grey');
    });
  });
});
