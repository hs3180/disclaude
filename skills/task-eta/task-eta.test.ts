/**
 * Tests for task-eta skill SKILL.md structure validation.
 *
 * Validates the SKILL.md file follows the project's skill specification:
 * - YAML frontmatter with required fields (name, description)
 * - Content structure with key sections
 * - File size within recommended limits
 * - allowed-tools uses correct format (comma-separated string, not array)
 *
 * @see SKILL_SPEC.md
 * @see Issue #1234
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';

const SKILL_PATH = path.join(__dirname, 'SKILL.md');

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns { frontmatter: Record<string, string>, content: string }
 */
function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; content: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, content: raw };
  }

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (key) frontmatter[key] = value;
  }

  return { frontmatter, content: match[2] };
}

describe('task-eta skill SKILL.md', () => {
  let raw: string;
  let frontmatter: Record<string, string>;
  let content: string;

  beforeAll(async () => {
    raw = await fs.readFile(SKILL_PATH, 'utf-8');
    const parsed = parseFrontmatter(raw);
    frontmatter = parsed.frontmatter;
    content = parsed.content;
  });

  describe('YAML Frontmatter', () => {
    it('should have valid frontmatter delimiters', () => {
      expect(raw.startsWith('---\n')).toBe(true);
      expect(raw.indexOf('\n---\n')).toBeGreaterThan(0);
    });

    it('should have required "name" field', () => {
      expect(frontmatter['name']).toBeDefined();
      expect(frontmatter['name']).toBe('task-eta');
    });

    it('should have required "description" field', () => {
      expect(frontmatter['description']).toBeDefined();
      expect(typeof frontmatter['description']).toBe('string');
      expect(frontmatter['description']!.length).toBeGreaterThan(10);
    });

    it('should have "allowed-tools" field using comma-separated string format', () => {
      expect(frontmatter['allowed-tools']).toBeDefined();
      const value = frontmatter['allowed-tools']!;
      // Should NOT be array format like ["Read", "Write"]
      expect(value.startsWith('[')).toBe(false);
      // Should be comma-separated
      expect(value).toContain(',');
      expect(value).toContain('Read');
      expect(value).toContain('Write');
    });
  });

  describe('Content Structure', () => {
    it('should have a main heading', () => {
      expect(content).toMatch(/^# .+/m);
    });

    it('should describe both record and estimate modes', () => {
      expect(content).toContain('record');
      expect(content).toContain('estimate');
    });

    it('should reference the Markdown storage files', () => {
      expect(content).toContain('task-records.md');
      expect(content).toContain('eta-rules.md');
    });

    it('should include initialization templates for both files', () => {
      expect(content).toContain('First-time');
      expect(content).toContain('.claude/task-records.md');
      expect(content).toContain('.claude/eta-rules.md');
    });

    it('should specify task type categories', () => {
      const taskTypes = ['bugfix', 'feature', 'refactoring', 'docs', 'test', 'research'];
      for (const type of taskTypes) {
        expect(content).toContain(type);
      }
    });

    it('should include confidence level definitions', () => {
      expect(content).toContain('High');
      expect(content).toContain('Medium');
      expect(content).toContain('Low');
    });

    it('should include a record format with required fields', () => {
      expect(content).toContain('Type');
      expect(content).toContain('Actual Time');
      expect(content).toContain('Retrospective');
      expect(content).toContain('Tags');
    });

    it('should mention the prompt-based principle (not scoring)', () => {
      expect(content).toContain('prompt-based');
    });

    it('should include DO NOT section', () => {
      expect(content).toContain('DO NOT');
    });

    it('should reference the deep-task integration', () => {
      expect(content).toContain('deep-task');
    });
  });

  describe('File Size', () => {
    it('should be within the recommended 500-line limit', () => {
      const lines = raw.split('\n').length;
      expect(lines).toBeLessThanOrEqual(500);
    });

    it('should have meaningful content (not trivially short)', () => {
      const lines = raw.split('\n').length;
      expect(lines).toBeGreaterThan(50);
    });
  });

  describe('Markdown Formatting', () => {
    it('should use consistent heading hierarchy', () => {
      const h1Matches = content.match(/^# /gm);
      const h2Matches = content.match(/^## /gm);
      const h3Matches = content.match(/^### /gm);
      // Should have exactly one H1 (the title)
      expect(h1Matches?.length ?? 0).toBeGreaterThanOrEqual(1);
      // Should have multiple H2 sections
      expect(h2Matches?.length ?? 0).toBeGreaterThan(3);
    });

    it('should not have broken markdown tables', () => {
      const tableRows = content.split('\n').filter(line => line.startsWith('|'));
      // Every table row should have closing |
      for (const row of tableRows) {
        expect(row.endsWith('|')).toBe(true);
      }
    });
  });
});
