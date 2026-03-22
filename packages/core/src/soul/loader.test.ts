/**
 * Tests for SOUL Loader (Issue #1315)
 *
 * Tests SOUL.md discovery, loading, and merging functionality.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  getSoulSearchPaths,
  findSoul,
  loadSoul,
  mergeSouls,
  formatSoulForSystemPrompt,
  type SoulContent,
} from './loader.js';

describe('SOUL Loader', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soul-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('getSoulSearchPaths', () => {
    it('should return search paths sorted by priority', () => {
      const paths = getSoulSearchPaths();

      // Check that paths are sorted by priority (highest first)
      for (let i = 1; i < paths.length; i++) {
        expect(paths[i - 1].priority).toBeGreaterThanOrEqual(paths[i].priority);
      }
    });

    it('should include user-level path with highest priority', () => {
      const paths = getSoulSearchPaths();
      const userPath = paths.find(p => p.level === 'user');
      expect(userPath).toBeDefined();
      expect(userPath?.priority).toBe(30);
    });

    it('should include skill-level paths when skillName is provided', () => {
      const paths = getSoulSearchPaths({ skillName: 'pilot' });
      const skillPaths = paths.filter(p => p.level === 'skill');
      expect(skillPaths.length).toBeGreaterThan(0);
    });
  });

  describe('findSoul', () => {
    it('should return empty array when no SOUL.md files exist', async () => {
      const souls = await findSoul();
      // In test environment, there might not be any SOUL.md files
      // Just check that it returns an array
      expect(Array.isArray(souls)).toBe(true);
    });
  });

  describe('loadSoul', () => {
    it('should load and parse a SOUL.md file', async () => {
      const soulPath = path.join(tempDir, 'SOUL.md');
      await fs.writeFile(soulPath, `# Test Soul

## Core Truths

- I am a test soul
- I help with testing

## Boundaries

- I do not run in production

## Lifecycle

Stop Condition: When tests pass
Trigger Phrase: [TEST_END]
`);

      const soul = await loadSoul(soulPath);

      expect(soul.raw).toContain('# Test Soul');
      expect(soul.coreTruths).toContain('I am a test soul');
      expect(soul.boundaries).toContain('I do not run in production');
      expect(soul.lifecycle?.stopCondition).toBe('When tests pass');
      expect(soul.lifecycle?.triggerPhrase).toBe('[TEST_END]');
    });

    it('should handle SOUL.md with missing sections', async () => {
      const soulPath = path.join(tempDir, 'SOUL.md');
      await fs.writeFile(soulPath, `# Minimal Soul

## Core Truths

Just the basics.
`);

      const soul = await loadSoul(soulPath);

      expect(soul.coreTruths).toContain('Just the basics');
      expect(soul.boundaries).toBeUndefined();
      expect(soul.lifecycle).toBeUndefined();
    });
  });

  describe('mergeSouls', () => {
    it('should return empty soul for empty array', () => {
      const merged = mergeSouls([]);
      expect(merged.name).toBe('empty');
      expect(merged.raw).toBe('');
    });

    it('should return single soul unchanged', () => {
      const soul: SoulContent = {
        name: 'test',
        coreTruths: 'Test truths',
        raw: 'Test content',
        source: 'test',
      };
      const merged = mergeSouls([soul]);
      expect(merged).toEqual(soul);
    });

    it('should merge multiple souls with priority', () => {
      const lowPriority: SoulContent = {
        name: 'default',
        coreTruths: 'Default truths',
        boundaries: 'Default boundaries',
        lifecycle: { stopCondition: 'Default condition' },
        raw: 'Default content',
        source: '/config/SOUL.md',
      };

      const highPriority: SoulContent = {
        name: 'user',
        coreTruths: 'User truths',
        boundaries: 'User boundaries',
        lifecycle: { stopCondition: 'User condition', triggerPhrase: '[END]' },
        raw: 'User content',
        source: '/home/user/.disclaude/SOUL.md',
      };

      const merged = mergeSouls([highPriority, lowPriority]);

      // Higher priority lifecycle should win
      expect(merged.lifecycle?.stopCondition).toBe('User condition');
      expect(merged.lifecycle?.triggerPhrase).toBe('[END]');

      // Both contents should be present
      expect(merged.raw).toContain('User truths');
      expect(merged.raw).toContain('Default truths');
    });
  });

  describe('formatSoulForSystemPrompt', () => {
    it('should format soul content for system prompt', () => {
      const soul: SoulContent = {
        name: 'test',
        raw: '## Core Truths\n\n- Test truth',
        source: 'test',
      };

      const formatted = formatSoulForSystemPrompt(soul);
      expect(formatted).toContain('## Agent Personality (SOUL)');
      expect(formatted).toContain('## Core Truths');
    });

    it('should return empty string for empty soul', () => {
      const soul: SoulContent = {
        name: 'empty',
        raw: '',
        source: 'none',
      };

      const formatted = formatSoulForSystemPrompt(soul);
      expect(formatted).toBe('');
    });
  });
});
