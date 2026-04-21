/**
 * Unit tests for TasteManager — auto-summarized user taste persistence.
 *
 * Tests cover:
 * - Adding rules (new and duplicate detection)
 * - Removing rules (by description and index)
 * - Clearing rules (category-specific and full)
 * - Listing rules
 * - YAML persistence (write, load, round-trip)
 * - Prompt formatting
 * - Input validation
 * - Edge cases (empty data, capacity limits, corrupted files)
 *
 * @see Issue #2335 (feat: auto-summarize user taste)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TasteManager } from './taste-manager.js';
import {
  CATEGORY_LABELS,
  TASTE_CATEGORIES,
  type TasteManagerOptions,
} from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Fixtures
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'taste-test-'));
  tempDirs.push(dir);
  return dir;
}

function createOptions(overrides?: Partial<TasteManagerOptions>): TasteManagerOptions {
  const workspaceDir = createTempDir();
  return {
    workspaceDir,
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Constructor
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager constructor', () => {
  it('should construct with valid options', () => {
    const tm = new TasteManager(createOptions());
    expect(tm.hasRules()).toBe(false);
    expect(tm.getRuleCount()).toBe(0);
  });

  it('should load existing taste.yaml on construction', () => {
    const workspaceDir = createTempDir();
    const dataDir = join(workspaceDir, '.disclaude');
    const { mkdirSync, writeFileSync } = require('node:fs');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'taste.yaml'), `# Test
taste:
  code_style:
    - description: "use const"
      source: manual
      lastSeen: "2026-04-14T10:00:00.000Z"
      createdAt: "2026-04-14T10:00:00.000Z"
`);
    const tm = new TasteManager({ workspaceDir });
    expect(tm.hasRules()).toBe(true);
    expect(tm.getRuleCount()).toBe(1);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// addRule()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('addRule()', () => {
  it('should add a new rule successfully', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.addRule('code_style', '使用 const/let，禁止 var');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.description).toBe('使用 const/let，禁止 var');
      expect(result.data.source).toBe('auto');
      expect(result.data.correctionCount).toBe(1);
    }
  });

  it('should add a rule with manual source', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.addRule('interaction', '回复简洁', 'manual');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe('manual');
      expect(result.data.correctionCount).toBeUndefined();
    }
  });

  it('should increment count for duplicate description', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule('code_style', '使用 const/let');
    const result = tm.addRule('code_style', '使用 const/let');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.correctionCount).toBe(2);
    }
    expect(tm.getRuleCount()).toBe(1);
  });

  it('should match case-insensitively for duplicates', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule('code_style', 'Use const');
    const result = tm.addRule('code_style', 'use const');
    expect(result.ok).toBe(true);
    expect(tm.getRuleCount()).toBe(1);
  });

  it('should reject invalid category', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.addRule('invalid' as any, 'test');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('无效的分类');
    }
  });

  it('should reject empty description', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.addRule('code_style', '');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不能为空');
    }
  });

  it('should reject too-long description', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.addRule('code_style', 'x'.repeat(201));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不能超过');
    }
  });

  it('should evict oldest rule when category is full', () => {
    const tm = new TasteManager(createOptions());
    // Add 21 rules (max is 20)
    for (let i = 0; i < 21; i++) {
      tm.addRule('code_style', `Rule ${i}`, 'manual');
    }
    expect(tm.getRuleCount()).toBe(20);
    const rules = tm.listRules('code_style');
    // First rule (Rule 0) should be evicted
    expect(rules.find(r => r.rule.description === 'Rule 0')).toBeUndefined();
    // Last rule should exist
    expect(rules.find(r => r.rule.description === 'Rule 20')).toBeDefined();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// removeRule() & removeRuleByIndex()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('removeRule()', () => {
  it('should remove an existing rule', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule('code_style', 'Use const');
    const result = tm.removeRule('code_style', 'Use const');
    expect(result.ok).toBe(true);
    expect(tm.getRuleCount()).toBe(0);
  });

  it('should fail for non-existent rule', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.removeRule('code_style', 'Non-existent');
    expect(result.ok).toBe(false);
  });

  it('should fail for non-existent category', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.removeRule('interaction', 'test');
    expect(result.ok).toBe(false);
  });
});

describe('removeRuleByIndex()', () => {
  it('should remove rule by index', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule('code_style', 'Rule 1');
    tm.addRule('code_style', 'Rule 2');
    const result = tm.removeRuleByIndex('code_style', 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.description).toBe('Rule 1');
    }
    expect(tm.getRuleCount()).toBe(1);
  });

  it('should fail for out-of-range index', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule('code_style', 'Rule 1');
    const result = tm.removeRuleByIndex('code_style', 5);
    expect(result.ok).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// clear()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('clear()', () => {
  it('should clear all rules', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule('code_style', 'Rule 1');
    tm.addRule('interaction', 'Rule 2');
    const result = tm.clear();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe(2);
    }
    expect(tm.getRuleCount()).toBe(0);
  });

  it('should clear specific category', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule('code_style', 'Rule 1');
    tm.addRule('interaction', 'Rule 2');
    const result = tm.clear('code_style');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe(1);
    }
    expect(tm.getRuleCount()).toBe(1);
  });

  it('should fail for empty category', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.clear('code_style');
    expect(result.ok).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// listRules()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('listRules()', () => {
  it('should list all rules across categories', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule('code_style', 'Rule 1');
    tm.addRule('interaction', 'Rule 2');
    const rules = tm.listRules();
    expect(rules).toHaveLength(2);
  });

  it('should filter by category', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule('code_style', 'Rule 1');
    tm.addRule('interaction', 'Rule 2');
    const rules = tm.listRules('code_style');
    expect(rules).toHaveLength(1);
    expect(rules[0].category).toBe('code_style');
  });

  it('should return empty array for empty category', () => {
    const tm = new TasteManager(createOptions());
    const rules = tm.listRules('code_style');
    expect(rules).toHaveLength(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Persistence
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('persistence', () => {
  it('should persist rules to taste.yaml', () => {
    const workspaceDir = createTempDir();
    const tm = new TasteManager({ workspaceDir });
    tm.addRule('code_style', 'Use const/let');

    const tastePath = join(workspaceDir, '.disclaude', 'taste.yaml');
    expect(existsSync(tastePath)).toBe(true);

    const content = readFileSync(tastePath, 'utf8');
    expect(content).toContain('code_style');
    expect(content).toContain('Use const/let');
  });

  it('should round-trip data through persist and load', () => {
    const workspaceDir = createTempDir();

    // Create and populate
    const tm1 = new TasteManager({ workspaceDir });
    tm1.addRule('code_style', 'Use const/let');
    tm1.addRule('interaction', 'Reply concisely', 'manual');

    // Load from persisted file
    const tm2 = new TasteManager({ workspaceDir });
    expect(tm2.getRuleCount()).toBe(2);
    expect(tm2.hasRules()).toBe(true);
  });

  it('should handle corrupted YAML gracefully', () => {
    const workspaceDir = createTempDir();
    const dataDir = join(workspaceDir, '.disclaude');
    const { mkdirSync, writeFileSync } = require('node:fs');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'taste.yaml'), '{{invalid yaml: [}');

    // Should not crash
    const tm = new TasteManager({ workspaceDir });
    expect(tm.hasRules()).toBe(false);
  });

  it('should handle missing taste.yaml gracefully', () => {
    const workspaceDir = createTempDir();
    const tm = new TasteManager({ workspaceDir });
    expect(tm.hasRules()).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// formatForPrompt()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('formatForPrompt()', () => {
  it('should return empty string when no rules exist', () => {
    const tm = new TasteManager(createOptions());
    expect(tm.formatForPrompt()).toBe('');
  });

  it('should format rules with category labels', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule('code_style', 'Use const/let');
    const prompt = tm.formatForPrompt();
    expect(prompt).toContain('User Taste');
    expect(prompt).toContain('代码风格');
    expect(prompt).toContain('Use const/let');
  });

  it('should show correction count for auto rules', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule('code_style', 'Use const');
    tm.addRule('code_style', 'Use const');
    tm.addRule('code_style', 'Use const');
    const prompt = tm.formatForPrompt();
    expect(prompt).toContain('被纠正 3 次');
  });

  it('should show CLAUDE.md source label', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule('code_style', 'Use TypeScript', 'claude_md');
    const prompt = tm.formatForPrompt();
    expect(prompt).toContain('来自 CLAUDE.md');
  });

  it('should not show count for manual rules', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule('interaction', 'Reply concisely', 'manual');
    const prompt = tm.formatForPrompt();
    expect(prompt).not.toContain('被纠正');
  });

  it('should sort by correction count (highest first)', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule('code_style', 'Low priority');
    tm.addRule('code_style', 'High priority');
    tm.addRule('code_style', 'High priority');
    tm.addRule('code_style', 'High priority');

    const prompt = tm.formatForPrompt();
    const highIdx = prompt.indexOf('High priority');
    const lowIdx = prompt.indexOf('Low priority');
    expect(highIdx).toBeLessThan(lowIdx);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Constants
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('constants', () => {
  it('should have labels for all categories', () => {
    for (const cat of TASTE_CATEGORIES) {
      expect(CATEGORY_LABELS[cat]).toBeDefined();
      expect(CATEGORY_LABELS[cat].length).toBeGreaterThan(0);
    }
  });
});
