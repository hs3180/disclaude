/**
 * Tests for agents/discussion.md - Discussion Focus Agent definition.
 *
 * Issue #1228: Validates the discussion focus agent definition follows
 * the correct format and contains required behavioral guidelines.
 *
 * Tests ensure:
 * - YAML frontmatter has required fields (name, description, tools)
 * - Content covers all key behavioral guidelines from #1228
 * - Integration references to start-discussion and chat infrastructure are present
 * - Content follows the established agent definition pattern (like site-miner.md)
 * - Does not depend on rejected SOUL.md system (per #1315 closure)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const AGENTS_DIR = path.join(PROJECT_ROOT, 'agents');
const DISCUSSION_AGENT_PATH = path.join(AGENTS_DIR, 'discussion.md');
const SITE_MINER_AGENT_PATH = path.join(AGENTS_DIR, 'site-miner.md');

/**
 * Simple YAML frontmatter parser for test purposes.
 * Handles basic key: value and key: [array] syntax.
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    throw new Error('No valid YAML frontmatter found');
  }

  const yamlStr = fmMatch[1];
  const body = fmMatch[2];
  const frontmatter: Record<string, unknown> = {};

  for (const line of yamlStr.split('\n')) {
    const kvMatch = line.match(/^(\w+):\s*(.+)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      let value: unknown = kvMatch[2].trim();
      if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1).split(',').map((s: string) => s.trim().replace(/["']/g, ''));
      } else if (typeof value === 'string') {
        value = value.replace(/^["']|["']$/g, '');
      }
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}

describe('agents/discussion.md - Discussion Focus Agent (#1228)', () => {
  let content: string;
  let frontmatter: Record<string, unknown>;
  let body: string;

  beforeAll(async () => {
    content = await fs.readFile(DISCUSSION_AGENT_PATH, 'utf-8');
    ({ frontmatter, body } = parseFrontmatter(content));
  });

  // =========================================================================
  // Frontmatter Validation
  // =========================================================================

  describe('frontmatter', () => {
    it('should have name field set to "discussion"', () => {
      expect(frontmatter.name).toBe('discussion');
    });

    it('should have a non-empty description mentioning discussion focus', () => {
      expect(frontmatter.description).toBeDefined();
      expect(typeof frontmatter.description).toBe('string');
      const desc = frontmatter.description as string;
      expect(desc.length).toBeGreaterThan(10);
      // Description should relate to discussion or focus
      const lower = desc.toLowerCase();
      expect(
        lower.includes('discussion') || lower.includes('focus') || lower.includes('topic'),
        `Description should mention discussion/focus/topic: "${desc}"`,
      ).toBe(true);
    });

    it('should specify allowed tools as an array', () => {
      expect(frontmatter.tools).toBeDefined();
      expect(Array.isArray(frontmatter.tools)).toBe(true);
      expect((frontmatter.tools as string[]).length).toBeGreaterThan(0);
    });

    it('should include Read tool for context access', () => {
      expect(frontmatter.tools).toContain('Read');
    });

    it('should include Bash tool for script execution', () => {
      expect(frontmatter.tools).toContain('Bash');
    });
  });

  // =========================================================================
  // Content Structure & Behavioral Guidelines (#1228 Requirements)
  // =========================================================================

  describe('content structure', () => {
    it('should have a main heading (# )', () => {
      expect(body).toMatch(/^#\s+/m);
    });

    it('should cover topic anchoring behavior (issue #1228: 问题锚定)', () => {
      const lowerBody = body.toLowerCase();
      expect(
        lowerBody.includes('anchor') ||
        lowerBody.includes('north star') ||
        lowerBody.includes('original question') ||
        lowerBody.includes('初始'),
        'Should mention topic anchoring or original question tracking',
      ).toBe(true);
    });

    it('should cover drift detection and redirection (issue #1228: 偏离检测 + 回归引导)', () => {
      const lowerBody = body.toLowerCase();
      expect(
        lowerBody.includes('redirect') ||
        lowerBody.includes('drift') ||
        lowerBody.includes('course.correct'),
        'Should mention drift detection or redirection',
      ).toBe(true);
    });

    it('should cover discussion lifecycle (opening/middle/closing)', () => {
      const lowerBody = body.toLowerCase();
      const hasOpening = lowerBody.includes('opening') || lowerBody.includes('开始');
      const hasClosing = lowerBody.includes('closing') || lowerBody.includes('结束');
      expect(hasOpening, 'Should mention opening phase').toBe(true);
      expect(hasClosing, 'Should mention closing phase').toBe(true);
    });

    it('should reference start-discussion or chat infrastructure (integration)', () => {
      const lowerBody = body.toLowerCase();
      const hasIntegrationRef =
        lowerBody.includes('start-discussion') ||
        lowerBody.includes('chat') ||
        lowerBody.includes('讨论');
      expect(hasIntegrationRef, 'Should reference discussion infrastructure').toBe(true);
    });

    it('should mention depth over breadth as a principle', () => {
      const lowerBody = body.toLowerCase();
      expect(
        lowerBody.includes('depth') ||
        lowerBody.includes('thoroughly') ||
        lowerBody.includes('深度'),
        'Should mention depth over breadth',
      ).toBe(true);
    });

    it('should include anti-patterns or "do not" section', () => {
      const lowerBody = body.toLowerCase();
      expect(
        lowerBody.includes('anti-pattern') ||
        lowerBody.includes('do not') ||
        lowerBody.includes("don't") ||
        lowerBody.includes('avoid'),
        'Should include anti-patterns or do-not section',
      ).toBe(true);
    });

    it('should mention periodic summarization (issue #1228: 问题锚定)', () => {
      const lowerBody = body.toLowerCase();
      expect(
        lowerBody.includes('summar') || lowerBody.includes('recap'),
        'Should mention summarization/recap for maintaining focus',
      ).toBe(true);
    });
  });

  // =========================================================================
  // SOUL.md Independence (per #1315 closure)
  // =========================================================================

  describe('SOUL.md independence', () => {
    it('should NOT reference SOUL.md system (closed #1315)', () => {
      expect(body).not.toContain('SOUL.md');
      expect(body).not.toContain('SoulLoader');
      expect(body).not.toContain('soul.md');
    });

    it('should NOT reference rejected infrastructure', () => {
      expect(body).not.toContain('SoulConfig');
      expect(body).not.toContain('soulMdPath');
    });
  });

  // =========================================================================
  // Consistency with Existing Agent Definitions
  // =========================================================================

  describe('consistency with existing agents', () => {
    it('should follow the same .md format as site-miner.md', async () => {
      let siteMinerContent: string;
      try {
        siteMinerContent = await fs.readFile(SITE_MINER_AGENT_PATH, 'utf-8');
      } catch {
        // site-miner.md is the reference pattern; if missing, skip
        return;
      }

      // Both should have YAML frontmatter with --- delimiters
      const siteMinerFm = siteMinerContent.match(/^---\n[\s\S]*?\n---\n/);
      expect(siteMinerFm, 'site-miner.md should have frontmatter').toBeTruthy();

      const discussionFm = content.match(/^---\n[\s\S]*?\n---\n/);
      expect(discussionFm, 'discussion.md should have frontmatter').toBeTruthy();

      // Both should have name in frontmatter
      const { frontmatter: siteMinerFmParsed } = parseFrontmatter(siteMinerContent);
      expect(siteMinerFmParsed.name).toBeDefined();
      expect(frontmatter.name).toBeDefined();

      // Both should have description in frontmatter
      expect(siteMinerFmParsed.description).toBeDefined();
      expect(frontmatter.description).toBeDefined();
    });
  });
});
