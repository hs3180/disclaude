/**
 * Tests for SOUL.md Loader.
 *
 * @see Issue #1315
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  parseSoulContent,
  getSoulLocations,
  mergeSoulContents,
  formatSoulForPrompt,
  SoulLoader,
  type SoulContent,
} from './soul-loader.js';

describe('parseSoulContent', () => {
  it('should parse Core Truths section with bullet points', () => {
    const content = `# Test SOUL

## Core Truths
- Truth 1
- Truth 2
`;
    const result = parseSoulContent(content);
    expect(result.coreTruths).toEqual(['Truth 1', 'Truth 2']);
    expect(result.boundaries).toEqual([]);
  });

  it('should parse Core Truths section with numbered list', () => {
    const content = `# Test SOUL

## Core Truths
1. First truth
2. Second truth
`;
    const result = parseSoulContent(content);
    expect(result.coreTruths).toEqual(['First truth', 'Second truth']);
  });

  it('should parse Boundaries section', () => {
    const content = `# Test SOUL

## Boundaries
- Do not do X
- Do not do Y
`;
    const result = parseSoulContent(content);
    expect(result.boundaries).toEqual(['Do not do X', 'Do not do Y']);
  });

  it('should parse Lifecycle section with stop condition', () => {
    const content = `# Test SOUL

## Lifecycle
Stop Condition: When user says goodbye
Trigger Phrase: See you later
`;
    const result = parseSoulContent(content);
    expect(result.lifecycle).toEqual({
      stopCondition: 'When user says goodbye',
      triggerPhrase: 'See you later',
    });
  });

  it('should handle empty content', () => {
    const result = parseSoulContent('');
    expect(result.coreTruths).toEqual([]);
    expect(result.boundaries).toEqual([]);
    expect(result.lifecycle).toBeUndefined();
  });

  it('should handle content without sections', () => {
    const content = `# Just a title

Some random text without sections.
`;
    const result = parseSoulContent(content);
    expect(result.coreTruths).toEqual([]);
    expect(result.boundaries).toEqual([]);
  });
});

describe('getSoulLocations', () => {
  it('should return all three locations with correct priorities', () => {
    const locations = getSoulLocations('test-skill', '/config', '/skills');

    expect(locations).toHaveLength(3);

    const userLocation = locations.find(l => l.source === 'user-defined');
    const skillLocation = locations.find(l => l.source === 'skill:test-skill');
    const systemLocation = locations.find(l => l.source === 'system-default');

    expect(userLocation?.priority).toBe(3);
    expect(skillLocation?.priority).toBe(2);
    expect(systemLocation?.priority).toBe(1);
  });

  it('should exclude skill location when skillName is not provided', () => {
    const locations = getSoulLocations(undefined, '/config', '/skills');

    expect(locations).toHaveLength(2);
    expect(locations.find(l => l.source.startsWith('skill:'))).toBeUndefined();
  });

  it('should use correct paths', () => {
    const homeDir = os.homedir();
    const locations = getSoulLocations('my-skill', '/my-config', '/my-skills');

    const userLocation = locations.find(l => l.source === 'user-defined');
    const skillLocation = locations.find(l => l.source === 'skill:my-skill');
    const systemLocation = locations.find(l => l.source === 'system-default');

    expect(userLocation?.path).toBe(path.join(homeDir, '.disclaude', 'SOUL.md'));
    expect(skillLocation?.path).toBe(path.join('/my-skills', 'my-skill', 'SOUL.md'));
    expect(systemLocation?.path).toBe(path.join('/my-config', 'SOUL.md'));
  });
});

describe('mergeSoulContents', () => {
  it('should merge multiple SoulContent objects', () => {
    const content1: SoulContent = {
      coreTruths: ['Truth 1'],
      boundaries: ['Boundary 1'],
    };
    const content2: SoulContent = {
      coreTruths: ['Truth 2'],
      boundaries: ['Boundary 2'],
      lifecycle: { stopCondition: 'Stop condition' },
    };

    const merged = mergeSoulContents([content1, content2]);

    expect(merged.coreTruths).toEqual(['Truth 1', 'Truth 2']);
    expect(merged.boundaries).toEqual(['Boundary 1', 'Boundary 2']);
    expect(merged.lifecycle?.stopCondition).toBe('Stop condition');
  });

  it('should handle empty array', () => {
    const merged = mergeSoulContents([]);
    expect(merged.coreTruths).toEqual([]);
    expect(merged.boundaries).toEqual([]);
  });

  it('should combine lifecycle properties', () => {
    const content1: SoulContent = {
      coreTruths: [],
      boundaries: [],
      lifecycle: { stopCondition: 'Stop 1' },
    };
    const content2: SoulContent = {
      coreTruths: [],
      boundaries: [],
      lifecycle: { triggerPhrase: 'Trigger 2' },
    };

    const merged = mergeSoulContents([content1, content2]);

    expect(merged.lifecycle).toEqual({
      stopCondition: 'Stop 1',
      triggerPhrase: 'Trigger 2',
    });
  });
});

describe('formatSoulForPrompt', () => {
  it('should format Core Truths section', () => {
    const soul: SoulContent = {
      coreTruths: ['Be helpful', 'Be accurate'],
      boundaries: [],
    };

    const formatted = formatSoulForPrompt(soul);

    expect(formatted).toContain('## Core Truths');
    expect(formatted).toContain('- Be helpful');
    expect(formatted).toContain('- Be accurate');
  });

  it('should format Boundaries section', () => {
    const soul: SoulContent = {
      coreTruths: [],
      boundaries: ['Do not lie', 'Do not be rude'],
    };

    const formatted = formatSoulForPrompt(soul);

    expect(formatted).toContain('## Boundaries');
    expect(formatted).toContain('- Do not lie');
    expect(formatted).toContain('- Do not be rude');
  });

  it('should format Lifecycle section', () => {
    const soul: SoulContent = {
      coreTruths: [],
      boundaries: [],
      lifecycle: {
        stopCondition: 'User says bye',
        triggerPhrase: 'Goodbye',
      },
    };

    const formatted = formatSoulForPrompt(soul);

    expect(formatted).toContain('## Lifecycle');
    expect(formatted).toContain('**Stop Condition**: User says bye');
    expect(formatted).toContain('**Trigger Phrase**: Goodbye');
  });

  it('should return empty string for empty soul', () => {
    const soul: SoulContent = {
      coreTruths: [],
      boundaries: [],
    };

    const formatted = formatSoulForPrompt(soul);
    expect(formatted).toBe('');
  });
});

describe('SoulLoader', () => {
  const tempDir = path.join(os.tmpdir(), `soul-loader-test-${Date.now()}`);
  const configDir = path.join(tempDir, 'config');
  const skillsDir = path.join(tempDir, 'skills');

  beforeEach(() => {
    // Create temp directories
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.join(skillsDir, 'test-skill'), { recursive: true });
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should load and merge SOUL from multiple sources', () => {
    // Create system default SOUL
    fs.writeFileSync(
      path.join(configDir, 'SOUL.md'),
      `# System SOUL
## Core Truths
- System truth
`
    );

    // Create skill-specific SOUL
    fs.writeFileSync(
      path.join(skillsDir, 'test-skill', 'SOUL.md'),
      `# Skill SOUL
## Core Truths
- Skill truth
## Boundaries
- Skill boundary
`
    );

    const loader = new SoulLoader({ configDir, skillsDir });
    const soul = loader.loadMergedSoul('test-skill');

    expect(soul).not.toBeNull();
    expect(soul?.coreTruths).toContain('System truth');
    expect(soul?.coreTruths).toContain('Skill truth');
    expect(soul?.boundaries).toContain('Skill boundary');
  });

  it('should return null when no SOUL files exist', () => {
    const loader = new SoulLoader({ configDir, skillsDir });
    const soul = loader.loadMergedSoul();

    expect(soul).toBeNull();
  });

  it('should cache loaded content', () => {
    fs.writeFileSync(
      path.join(configDir, 'SOUL.md'),
      `# SOUL
## Core Truths
- Cached truth
`
    );

    const loader = new SoulLoader({ configDir, skillsDir });

    // First load
    const soul1 = loader.loadMergedSoul();

    // Delete file
    fs.unlinkSync(path.join(configDir, 'SOUL.md'));

    // Second load should return cached content
    const soul2 = loader.loadMergedSoul();

    expect(soul1).toEqual(soul2);
    expect(soul2?.coreTruths).toContain('Cached truth');
  });

  it('should force refresh cache', () => {
    fs.writeFileSync(
      path.join(configDir, 'SOUL.md'),
      `# SOUL
## Core Truths
- Old truth
`
    );

    const loader = new SoulLoader({ configDir, skillsDir });

    // Clear cache first to ensure clean state
    loader.clearCache();

    // First load
    const soul1 = loader.loadMergedSoul();
    expect(soul1?.coreTruths).toContain('Old truth');

    // Update file
    fs.writeFileSync(
      path.join(configDir, 'SOUL.md'),
      `# SOUL
## Core Truths
- New truth
`
    );

    // Force refresh
    const soul2 = loader.loadMergedSoul(undefined, true);
    expect(soul2?.coreTruths).toContain('New truth');
  });

  it('should clear cache', () => {
    fs.writeFileSync(
      path.join(configDir, 'SOUL.md'),
      `# SOUL
## Core Truths
- Truth
`
    );

    const loader = new SoulLoader({ configDir, skillsDir });
    loader.loadMergedSoul();
    loader.clearCache();

    // Delete file
    fs.unlinkSync(path.join(configDir, 'SOUL.md'));

    // Should return null after cache cleared
    const soul = loader.loadMergedSoul();
    expect(soul).toBeNull();
  });
});
