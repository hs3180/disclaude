/**
 * Tests for skills/auto-trigger.ts
 *
 * Issue #3687: Tests for automatic skill matching and injection:
 * - matchSkills: keyword-based matching of user messages against skill descriptions
 * - buildSkillInjection: formatting matched skills for context injection
 * - Frontmatter parsing and keyword extraction
 * - Cache invalidation
 * - Respect for disable-model-invocation flag
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  matchSkills,
  buildSkillInjection,
  invalidateCache,
  type MatchedSkillResult,
} from './auto-trigger.js';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(),
  },
  readFile: vi.fn(),
}));

// Mock finder module
vi.mock('./finder.js', () => ({
  listSkills: vi.fn(),
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import * as fs from 'fs/promises';
import { listSkills } from './finder.js';

const mockReadFile = vi.mocked(fs.readFile);
const mockListSkills = vi.mocked(listSkills);

function makeSkillContent(name: string, description: string, extra?: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extra || ''}\n---\n\n# ${name}\n\nSkill body for ${name}.`;
}

describe('SkillAutoTrigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateCache();
  });

  describe('matchSkills', () => {
    it('should match skills by quoted keywords in description', async () => {
      mockListSkills.mockResolvedValue([
        { name: 'schedule', path: '/skills/schedule/SKILL.md', domain: 'package' as const },
      ]);

      mockReadFile.mockResolvedValue(
        makeSkillContent(
          'schedule',
          'Schedule tasks. Triggered by keywords: "定时任务", "schedule", "cron".'
        )
      );

      const results = await matchSkills('帮我创建一个定时任务');

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('schedule');
      expect(results[0].matchedKeywords).toContain('定时任务');
    });

    it('should match case-insensitively', async () => {
      mockListSkills.mockResolvedValue([
        { name: 'schedule', path: '/skills/schedule/SKILL.md', domain: 'package' as const },
      ]);

      mockReadFile.mockResolvedValue(
        makeSkillContent(
          'schedule',
          'Triggered by keywords: "Schedule", "CRON".'
        )
      );

      const results = await matchSkills('I need a schedule for my CRON task');

      expect(results).toHaveLength(1);
      expect(results[0].matchedKeywords.length).toBeGreaterThanOrEqual(2);
    });

    it('should skip skills with disable-model-invocation', async () => {
      mockListSkills.mockResolvedValue([
        { name: 'manual-only', path: '/skills/manual-only/SKILL.md', domain: 'package' as const },
      ]);

      mockReadFile.mockResolvedValue(
        makeSkillContent(
          'manual-only',
          'Triggered by keywords: "manual", "only".',
          'disable-model-invocation: true'
        )
      );

      const results = await matchSkills('I want to do manual things');

      expect(results).toHaveLength(0);
    });

    it('should not match when no keywords are present', async () => {
      mockListSkills.mockResolvedValue([
        { name: 'schedule', path: '/skills/schedule/SKILL.md', domain: 'package' as const },
      ]);

      mockReadFile.mockResolvedValue(
        makeSkillContent(
          'schedule',
          'Triggered by keywords: "定时任务", "schedule".'
        )
      );

      const results = await matchSkills('Hello, how are you today?');

      expect(results).toHaveLength(0);
    });

    it('should sort by match count (descending)', async () => {
      mockListSkills.mockResolvedValue([
        { name: 'weak-match', path: '/skills/weak/SKILL.md', domain: 'package' as const },
        { name: 'strong-match', path: '/skills/strong/SKILL.md', domain: 'package' as const },
      ]);

      mockReadFile
        .mockResolvedValueOnce(
          makeSkillContent('weak-match', 'Keywords: "schedule".')
        )
        .mockResolvedValueOnce(
          makeSkillContent('strong-match', 'Keywords: "schedule", "定时任务", "task".')
        );

      const results = await matchSkills('帮我创建一个定时任务 schedule');

      expect(results).toHaveLength(2);
      expect(results[0].name).toBe('strong-match');
      expect(results[1].name).toBe('weak-match');
    });

    it('should limit results to MAX_MATCHES (3)', async () => {
      mockListSkills.mockResolvedValue([
        { name: 'a', path: '/skills/a/SKILL.md', domain: 'package' as const },
        { name: 'b', path: '/skills/b/SKILL.md', domain: 'package' as const },
        { name: 'c', path: '/skills/c/SKILL.md', domain: 'package' as const },
        { name: 'd', path: '/skills/d/SKILL.md', domain: 'package' as const },
      ]);

      mockReadFile.mockResolvedValue(
        makeSkillContent('skill', 'Keywords: "task".')
      );

      const results = await matchSkills('do a task');

      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('should handle file read errors gracefully', async () => {
      mockListSkills.mockResolvedValue([
        { name: 'broken', path: '/skills/broken/SKILL.md', domain: 'package' as const },
      ]);

      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      const results = await matchSkills('any message');

      expect(results).toHaveLength(0);
    });

    it('should return empty array when no skills available', async () => {
      mockListSkills.mockResolvedValue([]);

      const results = await matchSkills('帮我创建一个定时任务');

      expect(results).toHaveLength(0);
    });

    it('should handle skills without quoted keywords in description', async () => {
      mockListSkills.mockResolvedValue([
        { name: 'no-quotes', path: '/skills/no-quotes/SKILL.md', domain: 'package' as const },
      ]);

      mockReadFile.mockResolvedValue(
        makeSkillContent('no-quotes', 'A simple skill with no quoted keywords.')
      );

      const results = await matchSkills('simple task');

      expect(results).toHaveLength(0);
    });
  });

  describe('buildSkillInjection', () => {
    it('should return empty string for empty matches', () => {
      expect(buildSkillInjection([])).toBe('');
    });

    it('should format matched skill with header and content', () => {
      const matches: MatchedSkillResult[] = [
        {
          name: 'schedule',
          path: '/skills/schedule/SKILL.md',
          matchedKeywords: ['定时任务', 'schedule'],
          content: '---\nname: schedule\n---\n\n# Schedule\n\nBody content.',
        },
      ];

      const result = buildSkillInjection(matches);

      expect(result).toContain('Auto-loaded Skill: schedule');
      expect(result).toContain('Matched keywords: 定时任务, schedule');
      expect(result).toContain('# Schedule');
      expect(result).toContain('Body content.');
      expect(result).not.toContain('---\nname: schedule\n---'); // Frontmatter stripped
    });

    it('should separate multiple skills with dividers', () => {
      const matches: MatchedSkillResult[] = [
        {
          name: 'skill-a',
          path: '/a/SKILL.md',
          matchedKeywords: ['a'],
          content: '---\n---\n\n# A\n\nBody A.',
        },
        {
          name: 'skill-b',
          path: '/b/SKILL.md',
          matchedKeywords: ['b'],
          content: '---\n---\n\n# B\n\nBody B.',
        },
      ];

      const result = buildSkillInjection(matches);

      expect(result).toContain('Auto-loaded Skill: skill-a');
      expect(result).toContain('Auto-loaded Skill: skill-b');
      expect(result).toContain('---');
    });
  });

  describe('cache invalidation', () => {
    it('should use cached results within TTL', async () => {
      mockListSkills.mockResolvedValue([
        { name: 'schedule', path: '/skills/schedule/SKILL.md', domain: 'package' as const },
      ]);

      mockReadFile.mockResolvedValue(
        makeSkillContent('schedule', 'Keywords: "task".')
      );

      // First call populates cache
      await matchSkills('task');
      // Second call should use cache (no listSkills call)
      await matchSkills('task');

      // listSkills called only once; second call hits cache
      expect(mockListSkills).toHaveBeenCalledTimes(1);
    });

    it('should refresh cache after invalidation', async () => {
      mockListSkills.mockResolvedValue([
        { name: 'schedule', path: '/skills/schedule/SKILL.md', domain: 'package' as const },
      ]);

      mockReadFile.mockResolvedValue(
        makeSkillContent('schedule', 'Keywords: "task".')
      );

      await matchSkills('task');
      invalidateCache();
      await matchSkills('task');

      expect(mockListSkills).toHaveBeenCalledTimes(2);
    });
  });
});
