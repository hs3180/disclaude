/**
 * Tests for discussion-focus skill structure and content validation.
 *
 * Validates that the SKILL.md file exists, has correct frontmatter,
 * and contains all required sections defined in Issue #1228 acceptance criteria.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const SKILL_PATH = resolve(__dirname, '..', 'SKILL.md');

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    frontmatter[key] = value;
  }
  return frontmatter;
}

describe('discussion-focus skill', () => {
  let skillContent: string;

  it('should have a SKILL.md file', () => {
    expect(existsSync(SKILL_PATH)).toBe(true);
    skillContent = readFileSync(SKILL_PATH, 'utf-8');
  });

  it('should have valid YAML frontmatter with required fields', () => {
    skillContent = readFileSync(SKILL_PATH, 'utf-8');
    const frontmatter = parseFrontmatter(skillContent);

    expect(frontmatter.name).toBe('discussion-focus');
    expect(frontmatter.description).toBeDefined();
    expect(frontmatter.description.length).toBeGreaterThan(10);
    // allowed-tools is an array, just verify it exists in raw content
    expect(skillContent).toContain('allowed-tools');
  });

  it('should have required content sections per acceptance criteria', () => {
    skillContent = readFileSync(SKILL_PATH, 'utf-8');

    // Acceptance criteria: discussion personality defined
    expect(skillContent).toContain('Core Personality');
    expect(skillContent).toContain('Stay on topic');

    // Acceptance criteria: topic anchoring behavior
    expect(skillContent).toContain('Topic Anchoring');

    // Acceptance criteria: drift detection and correction
    expect(skillContent).toContain('Drift Recognition');
    expect(skillContent).toContain('redirect');

    // Acceptance criteria: progress summarization
    expect(skillContent).toContain('Progress Summarization');

    // Acceptance criteria: integration with start-discussion
    expect(skillContent).toContain('start-discussion');
    expect(skillContent).toContain('CHAT_CONTEXT');

    // Acceptance criteria: discussion closure
    expect(skillContent).toContain('Discussion Closure');
  });

  it('should have trigger keywords for discussion focus', () => {
    skillContent = readFileSync(SKILL_PATH, 'utf-8');
    const frontmatter = parseFrontmatter(skillContent);

    expect(frontmatter.description).toContain('discussion focus');
    expect(frontmatter.description).toContain('stay on topic');
  });

  it('should have self-check protocol', () => {
    skillContent = readFileSync(SKILL_PATH, 'utf-8');

    expect(skillContent).toContain('Self-Check Protocol');
    expect(skillContent).toContain('Relevance check');
    expect(skillContent).toContain('Progress check');
  });

  it('should define anti-patterns and boundaries', () => {
    skillContent = readFileSync(SKILL_PATH, 'utf-8');

    expect(skillContent).toContain('Anti-Patterns');
    expect(skillContent).toContain('DO NOT');
    expect(skillContent).toContain('Scope Boundaries');
  });

  it('should not affect normal multi-round discussions', () => {
    skillContent = readFileSync(SKILL_PATH, 'utf-8');

    // The skill should activate only in specific contexts
    expect(skillContent).toContain('When This Skill Activates');
    // Should not be aggressive in redirection
    expect(skillContent).toContain('gently');
    // Should allow natural discussion flow
    expect(skillContent).toContain('natural');
  });

  it('should reference chat context topic field for integration', () => {
    skillContent = readFileSync(SKILL_PATH, 'utf-8');

    expect(skillContent).toContain('topic');
    expect(skillContent).toContain('chat/query.ts');
  });
});
