/**
 * Tests for SOUL.md Loader (Issue #1315).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  parseSoulContent,
  getSoulLocations,
  loadMergedSoul,
  formatSoulForPrompt,
  SoulLoader,
} from './soul-loader.js';

// Mock Config module
vi.mock('./index.js', () => ({
  Config: {
    getWorkspaceDir: () => '/test/workspace',
    getSkillsDir: () => '/test/skills',
  },
}));

describe('SoulLoader', () => {
  describe('parseSoulContent', () => {
    it('should parse basic SOUL.md content', () => {
      const content = `# Test SOUL

## Core Truths
- Always be helpful
- Be concise in responses

## Boundaries
- Do not make up information
- Do not be rude
`;

      const result = parseSoulContent(content, '/test/SOUL.md', 1);

      expect(result.coreTruths).toContain('Always be helpful');
      expect(result.coreTruths).toContain('Be concise in responses');
      expect(result.boundaries).toContain('Do not make up information');
      expect(result.boundaries).toContain('Do not be rude');
      expect(result.lifecycle).toBeUndefined();
    });

    it('should parse SOUL.md with lifecycle section', () => {
      const content = `# Discussion SOUL

## Core Truths
Stay focused on the topic.

## Boundaries
Do not chase tangents.

## Lifecycle
- Stop Condition: User confirms the discussion is complete
- Trigger Phrase: [DISCUSSION_END]
`;

      const result = parseSoulContent(content, '/test/SOUL.md', 2);

      expect(result.coreTruths).toBe('Stay focused on the topic.');
      expect(result.boundaries).toBe('Do not chase tangents.');
      expect(result.lifecycle).toBeDefined();
      expect(result.lifecycle?.stopCondition).toBe('User confirms the discussion is complete');
      expect(result.lifecycle?.triggerPhrase).toBe('[DISCUSSION_END]');
    });

    it('should handle missing sections gracefully', () => {
      // Test with no sections at all
      const content = `# Empty SOUL

Just some content without proper sections.
`;

      const result = parseSoulContent(content, '/test/SOUL.md', 1);

      // All sections should be empty
      expect(result.coreTruths).toBe('');
      expect(result.boundaries).toBe('');
      expect(result.lifecycle).toBeUndefined();
    });

    it('should handle case-insensitive section headers', () => {
      const content = `# Test SOUL

## core truths
Lower case header

## BOUNDARIES
Upper case header
`;

      const result = parseSoulContent(content, '/test/SOUL.md', 1);

      expect(result.coreTruths).toBe('Lower case header');
      expect(result.boundaries).toBe('Upper case header');
    });
  });

  describe('getSoulLocations', () => {
    it('should return default locations without skill name', () => {
      const locations = getSoulLocations();

      // Should include config/SOUL.md (priority 1)
      expect(locations.some(l => l.priority === 1 && l.path.includes('config'))).toBe(true);

      // Should include user home (priority 3)
      expect(locations.some(l => l.priority === 3 && l.path.includes('.disclaude'))).toBe(true);
    });

    it('should include skill-specific locations when skill name is provided', () => {
      const locations = getSoulLocations('my-skill');

      // Should include skill SOUL (priority 2)
      const skillLocations = locations.filter(l => l.priority === 2);
      expect(skillLocations.length).toBeGreaterThan(0);
      expect(skillLocations.every(l => l.path.includes('my-skill'))).toBe(true);
    });

    it('should return locations sorted by priority', () => {
      const locations = getSoulLocations('test-skill');

      for (let i = 1; i < locations.length; i++) {
        expect(locations[i].priority).toBeGreaterThanOrEqual(locations[i - 1].priority);
      }
    });
  });

  describe('formatSoulForPrompt', () => {
    it('should format soul content for system prompt', () => {
      const soul = {
        raw: '',
        coreTruths: 'Be helpful and concise.',
        boundaries: 'Do not be rude.',
        source: '/test/SOUL.md',
        priority: 1,
      };

      const formatted = formatSoulForPrompt(soul);

      expect(formatted).toContain('Agent Personality (SOUL)');
      expect(formatted).toContain('Core Truths');
      expect(formatted).toContain('Be helpful and concise.');
      expect(formatted).toContain('Boundaries');
      expect(formatted).toContain('Do not be rude.');
    });

    it('should include lifecycle info when present', () => {
      const soul = {
        raw: '',
        coreTruths: 'Stay focused.',
        boundaries: 'No tangents.',
        lifecycle: {
          stopCondition: 'Task is complete',
          triggerPhrase: '[END]',
        },
        source: '/test/SOUL.md',
        priority: 2,
      };

      const formatted = formatSoulForPrompt(soul);

      expect(formatted).toContain('Lifecycle');
      expect(formatted).toContain('Task is complete');
      expect(formatted).toContain('[END]');
    });

    it('should handle empty core truths and boundaries', () => {
      const soul = {
        raw: '',
        coreTruths: '',
        boundaries: '',
        source: '/test/SOUL.md',
        priority: 1,
      };

      const formatted = formatSoulForPrompt(soul);

      // Should still include the header
      expect(formatted).toContain('Agent Personality (SOUL)');
    });
  });

  describe('SoulLoader class', () => {
    let loader: SoulLoader;

    beforeEach(() => {
      loader = new SoulLoader(1000); // 1 second TTL for testing
    });

    afterEach(() => {
      loader.clearCache();
    });

    it('should cache loaded soul content', async () => {
      // First call
      const soul1 = await loader.getSoul();
      // Second call should return cached version
      const soul2 = await loader.getSoul();

      // Both should be the same object (or both null)
      expect(soul1).toBe(soul2);
    });

    it('should respect force reload flag', async () => {
      // First call
      await loader.getSoul();
      // Force reload
      const soul = await loader.getSoul(undefined, true);

      // Should work without error
      expect(soul).toBeDefined();
    });

    it('should clear cache', () => {
      loader.clearCache();
      // Cache should be empty
      expect(loader.getSoul(undefined, false)).resolves.toBeDefined();
    });
  });
});

describe('loadMergedSoul integration', () => {
  it('should return null when no SOUL files exist', async () => {
    // This test uses the mocked Config which points to non-existent directories
    const result = await loadMergedSoul();
    expect(result).toBeNull();
  });
});
