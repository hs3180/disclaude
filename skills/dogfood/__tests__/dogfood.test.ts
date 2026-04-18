import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Tests for the dogfood skill's static properties.
 *
 * These tests verify that the SKILL.md file exists, has valid frontmatter,
 * and contains the expected content structure. They do NOT test runtime behavior
 * (which requires the full agent stack).
 */
describe('dogfood skill', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const skillsDir = path.join(repoRoot, 'skills');
  const skillFile = path.join(__dirname, '..', 'SKILL.md');

  describe('SKILL.md file', () => {
    it('should exist at the expected path', () => {
      expect(fs.existsSync(skillFile)).toBe(true);
    });

    it('should be a non-empty file', () => {
      const content = fs.readFileSync(skillFile, 'utf-8');
      expect(content.length).toBeGreaterThan(100);
    });

    it('should start with YAML frontmatter', () => {
      const content = fs.readFileSync(skillFile, 'utf-8');
      expect(content.startsWith('---')).toBe(true);

      const closingIndex = content.indexOf('---', 3);
      expect(closingIndex).toBeGreaterThan(3);
    });

    it('should have a name field in frontmatter', () => {
      const content = fs.readFileSync(skillFile, 'utf-8');
      const frontmatter = extractFrontmatter(content);
      expect(frontmatter).toContain('name: dogfood');
    });

    it('should have a description field in frontmatter', () => {
      const content = fs.readFileSync(skillFile, 'utf-8');
      const frontmatter = extractFrontmatter(content);
      expect(frontmatter).toContain('description:');
    });

    it('should have a meaningful description (>50 chars)', () => {
      const content = fs.readFileSync(skillFile, 'utf-8');
      const frontmatter = extractFrontmatter(content);
      const descMatch = frontmatter.match(/description:\s*(.+)/);
      expect(descMatch).not.toBeNull();
      expect(descMatch![1].length).toBeGreaterThan(50);
    });

    it('should declare allowed-tools', () => {
      const content = fs.readFileSync(skillFile, 'utf-8');
      const frontmatter = extractFrontmatter(content);
      expect(frontmatter).toContain('allowed-tools:');
    });

    it('should include Read, Glob, and Bash in allowed-tools', () => {
      const content = fs.readFileSync(skillFile, 'utf-8');
      const frontmatter = extractFrontmatter(content);
      expect(frontmatter).toContain('Read');
      expect(frontmatter).toContain('Glob');
      expect(frontmatter).toContain('Bash');
    });
  });

  describe('content structure', () => {
    it('should have a level-1 heading', () => {
      const content = fs.readFileSync(skillFile, 'utf-8');
      const body = extractBody(content);
      expect(body).toMatch(/^#\s+/m);
    });

    it('should contain testing process steps', () => {
      const content = fs.readFileSync(skillFile, 'utf-8');
      const body = extractBody(content);
      expect(body).toContain('Step 1');
      expect(body).toContain('Step 2');
      expect(body).toContain('Step 3');
    });

    it('should contain a Checklist section', () => {
      const content = fs.readFileSync(skillFile, 'utf-8');
      expect(content).toContain('## Checklist');
    });

    it('should contain a DO NOT section', () => {
      const content = fs.readFileSync(skillFile, 'utf-8');
      expect(content).toContain('## DO NOT');
    });

    it('should reference send_user_feedback', () => {
      const content = fs.readFileSync(skillFile, 'utf-8');
      expect(content).toContain('send_user_feedback');
    });

    it('should contain trigger keywords', () => {
      const content = fs.readFileSync(skillFile, 'utf-8');
      expect(content).toContain('dogfood');
      expect(content).toContain('self-test');
      expect(content).toContain('自我测试');
    });
  });

  describe('skill discovery compatibility', () => {
    it('should be discoverable from the skills directory', () => {
      const skillPath = path.join(skillsDir, 'dogfood', 'SKILL.md');
      expect(fs.existsSync(skillPath)).toBe(true);
    });

    it('should have the correct directory name matching the skill name', () => {
      const dirName = path.basename(path.join(__dirname, '..'));
      expect(dirName).toBe('dogfood');
    });
  });
});

/**
 * Extract YAML frontmatter from SKILL.md content.
 */
function extractFrontmatter(content: string): string {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error('No frontmatter found');
  }
  return match[1];
}

/**
 * Extract body content (everything after frontmatter) from SKILL.md.
 */
function extractBody(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)/);
  if (!match) {
    throw new Error('No body found after frontmatter');
  }
  return match[1];
}
