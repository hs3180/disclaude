/**
 * Tests for Discussion SOUL Profile.
 *
 * Issue #1228: 讨论焦点保持 - 基于 SOUL.md 系统的讨论人格定义
 */

import { describe, it, expect } from 'vitest';
import {
  buildDiscussionSoulContent,
  DISCUSSION_SOUL_TEMPLATE,
  DEFAULT_DISCUSSION_SOUL_PATH,
  isDiscussionSoulContent,
} from './discussion-profile.js';

describe('Discussion Soul Profile', () => {
  describe('buildDiscussionSoulContent', () => {
    it('should include the initial question in the content', () => {
      const content = buildDiscussionSoulContent('Should we use TypeScript?');
      expect(content).toContain('Should we use TypeScript?');
    });

    it('should replace the placeholder with the question', () => {
      const content = buildDiscussionSoulContent('Should we use TypeScript?');
      expect(content).not.toContain('{{initialQuestion}}');
    });

    it('should use generic instruction when no question is provided', () => {
      const content = buildDiscussionSoulContent();
      expect(content).toContain('No specific topic has been set');
    });

    it('should use generic instruction when question is empty string', () => {
      const content = buildDiscussionSoulContent('');
      expect(content).toContain('No specific topic has been set');
    });

    it('should use generic instruction when question is only whitespace', () => {
      const content = buildDiscussionSoulContent('   ');
      expect(content).toContain('No specific topic has been set');
    });

    it('should contain core focus keywords (topic anchoring)', () => {
      const content = buildDiscussionSoulContent('test question');
      expect(content).toContain('Stay on topic');
      expect(content).toContain('north star');
    });

    it('should contain redirect guidance keywords (drift detection)', () => {
      const content = buildDiscussionSoulContent('test question');
      expect(content).toContain('redirect');
      expect(content).toContain('drift');
    });

    it('should contain depth over breadth principle', () => {
      const content = buildDiscussionSoulContent('test question');
      expect(content).toContain('Depth over breadth');
    });

    it('should contain periodic summary guidance', () => {
      const content = buildDiscussionSoulContent('test question');
      expect(content).toContain('Summarize progress');
    });

    it('should contain the Discussion SOUL header', () => {
      const content = buildDiscussionSoulContent('test');
      expect(content).toContain('# Discussion SOUL');
    });

    it('should contain boundary rules', () => {
      const content = buildDiscussionSoulContent('test');
      expect(content).toContain('## Boundaries');
      expect(content).toContain('tangent');
    });

    it('should trim whitespace from the question', () => {
      const content = buildDiscussionSoulContent('  spaced question  ');
      expect(content).toContain('spaced question');
      expect(content).not.toContain('  spaced question  ');
    });

    it('should handle multi-line questions', () => {
      const question = 'Should we use TypeScript?\n\nPros: type safety\nCons: build complexity';
      const content = buildDiscussionSoulContent(question);
      expect(content).toContain('Should we use TypeScript?');
      expect(content).toContain('Pros: type safety');
      expect(content).toContain('Cons: build complexity');
    });

    it('should contain genuine helpfulness principle', () => {
      const content = buildDiscussionSoulContent('test');
      expect(content).toContain('genuinely helpful');
    });

    it('should contain conciseness boundary', () => {
      const content = buildDiscussionSoulContent('test');
      expect(content).toContain('concise');
    });

    it('should always produce non-empty content', () => {
      const content = buildDiscussionSoulContent();
      expect(content.length).toBeGreaterThan(0);
    });

    it('should place the topic under Discussion Topic section', () => {
      const content = buildDiscussionSoulContent('My specific question');
      const topicIndex = content.indexOf('## Discussion Topic');
      const questionIndex = content.indexOf('My specific question');
      expect(topicIndex).toBeGreaterThan(-1);
      expect(questionIndex).toBeGreaterThan(topicIndex);
    });
  });

  describe('DISCUSSION_SOUL_TEMPLATE', () => {
    it('should contain the {{initialQuestion}} placeholder', () => {
      expect(DISCUSSION_SOUL_TEMPLATE).toContain('{{initialQuestion}}');
    });

    it('should contain Core Truths section', () => {
      expect(DISCUSSION_SOUL_TEMPLATE).toContain('## Core Truths');
    });

    it('should contain Boundaries section', () => {
      expect(DISCUSSION_SOUL_TEMPLATE).toContain('## Boundaries');
    });

    it('should contain Discussion Topic section', () => {
      expect(DISCUSSION_SOUL_TEMPLATE).toContain('## Discussion Topic');
    });

    it('should have exactly one placeholder', () => {
      const matches = DISCUSSION_SOUL_TEMPLATE.match(/\{\{initialQuestion\}\}/g);
      expect(matches).toHaveLength(1);
    });
  });

  describe('DEFAULT_DISCUSSION_SOUL_PATH', () => {
    it('should point to souls directory in .disclaude', () => {
      expect(DEFAULT_DISCUSSION_SOUL_PATH).toBe('~/.disclaude/souls/discussion.md');
    });

    it('should start with tilde for home directory expansion', () => {
      expect(DEFAULT_DISCUSSION_SOUL_PATH).toMatch(/^~/);
    });

    it('should have .md extension', () => {
      expect(DEFAULT_DISCUSSION_SOUL_PATH).toMatch(/\.md$/);
    });
  });

  describe('isDiscussionSoulContent', () => {
    it('should return true for content generated by buildDiscussionSoulContent', () => {
      const content = buildDiscussionSoulContent('test question');
      expect(isDiscussionSoulContent(content)).toBe(true);
    });

    it('should return true for content with # Discussion SOUL header', () => {
      expect(isDiscussionSoulContent('# Discussion SOUL\nSome content')).toBe(true);
    });

    it('should return true for content with ## Discussion Topic', () => {
      expect(isDiscussionSoulContent('Some content\n## Discussion Topic')).toBe(true);
    });

    it('should return false for unrelated SOUL content', () => {
      expect(isDiscussionSoulContent('# Code Review SOUL\nReview code carefully')).toBe(false);
    });

    it('should return false for empty content', () => {
      expect(isDiscussionSoulContent('')).toBe(false);
    });

    it('should return false for generic agent content', () => {
      expect(isDiscussionSoulContent('You are a helpful assistant.')).toBe(false);
    });

    it('should be case-sensitive for the header', () => {
      expect(isDiscussionSoulContent('# discussion soul\ncontent')).toBe(false);
    });
  });
});
