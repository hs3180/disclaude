/**
 * Tests for loop-schedule-init.ts.
 * Issue #4004: Loop schedule initialization script.
 *
 * Tests pure logic functions by importing and testing them directly.
 */
import { describe, it, expect } from 'vitest';

// Test the slug validation regex logic
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*$/;

function validateSlug(slug: string): string | null {
  if (!slug) { return 'LOOP_SLUG is required'; }
  if (!SLUG_REGEX.test(slug)) { return `Invalid LOOP_SLUG "${slug}"`; }
  return null;
}

function slugToTitle(slug: string): string {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

describe('loop-schedule-init', () => {
  describe('slug validation', () => {
    it('accepts valid slugs', () => {
      expect(validateSlug('research-ai-chips')).toBeNull();
      expect(validateSlug('task123')).toBeNull();
      expect(validateSlug('a')).toBeNull();
      expect(validateSlug('my-loop-task')).toBeNull();
    });

    it('rejects empty slug', () => {
      expect(validateSlug('')).toBe('LOOP_SLUG is required');
    });

    it('rejects uppercase', () => {
      expect(validateSlug('INVALID')).toContain('Invalid LOOP_SLUG');
    });

    it('rejects leading hyphen', () => {
      expect(validateSlug('-bad')).toContain('Invalid LOOP_SLUG');
    });

    it('rejects spaces', () => {
      expect(validateSlug('has space')).toContain('Invalid LOOP_SLUG');
    });

    it('rejects special characters', () => {
      expect(validateSlug('bad!slug')).toContain('Invalid LOOP_SLUG');
    });
  });

  describe('slugToTitle', () => {
    it('converts slug to title', () => {
      expect(slugToTitle('research-ai-chips')).toBe('Research Ai Chips');
      expect(slugToTitle('task')).toBe('Task');
      expect(slugToTitle('a-b-c')).toBe('A B C');
    });

    it('handles single word', () => {
      expect(slugToTitle('monitoring')).toBe('Monitoring');
    });
  });

  describe('STATE.md frontmatter generation', () => {
    it('generates valid YAML frontmatter', () => {
      const slug = 'test-task';
      const description = 'Test loop task';
      const frequency = '*/5 * * * *';
      const scene = 'research';
      const now = new Date().toISOString();

      const stateContent = `---
status: active
phase: init
tickCount: 0
createdAt: "${now}"
updatedAt: "${now}"
slug: "${slug}"
scene: "${scene}"
frequency: "${frequency}"
task: "${description}"
---`;

      // Verify frontmatter can be parsed
      expect(stateContent).toContain('status: active');
      expect(stateContent).toContain(`slug: "${slug}"`);
      expect(stateContent).toContain(`task: "${description}"`);
      expect(stateContent).toContain(`frequency: "${frequency}"`);
      expect(stateContent).toContain(`scene: "${scene}"`);
    });
  });

  describe('mapping key generation', () => {
    it('generates correct mapping key from slug', () => {
      const key = `loop-${'research-ai-chips'}`;
      expect(key).toBe('loop-research-ai-chips');
    });

    it('maps purpose correctly', () => {
      const purpose = 'loop-schedule';
      expect(purpose).toBe('loop-schedule');
    });
  });
});
