/**
 * Unit tests for TasteManager — per-project user preference management.
 *
 * Tests cover:
 * - Initialization (first run, reload, corrupted file)
 * - Adding rules (validation, deduplication, correction counting)
 * - Removing rules (by index, by text)
 * - Listing rules (unfiltered, filtered)
 * - Clearing rules
 * - Persistence (YAML serialization round-trip, atomic write)
 * - Prompt formatting
 * - Edge cases (empty rules, max rules, invalid input)
 *
 * @see Issue #2335 — auto-summarize user taste to avoid repeated corrections
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TasteManager } from './taste-manager.js';
import type { TasteManagerOptions } from './types.js';

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
  return {
    projectDir: createTempDir(),
    ...overrides,
  };
}

// Cleanup all temp directories after each test
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
// Initialization
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager init()', () => {
  it('should initialize with no taste file (first run)', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.init();
    expect(result.ok).toBe(true);
    expect(tm.getRuleCount()).toBe(0);
  });

  it('should load existing taste rules', () => {
    const opts = createOptions();
    const { projectDir } = opts;

    // Create taste.yaml manually
    writeFileSync(join(projectDir, 'taste.yaml'), `# Taste
version: 1

rules:
  - rule: "Use const/let, never var"
    category: code_style
    source: auto
    correctionCount: 3
    lastSeen: "2026-04-14T00:00:00.000Z"
  - rule: "Reply concisely"
    category: interaction
    source: manual
    correctionCount: 0
    lastSeen: "2026-04-15T00:00:00.000Z"
`, 'utf8');

    const tm = new TasteManager(opts);
    const result = tm.init();
    expect(result.ok).toBe(true);
    expect(tm.getRuleCount()).toBe(2);
  });

  it('should handle corrupted YAML gracefully', () => {
    const opts = createOptions();
    const { projectDir } = opts;

    writeFileSync(join(projectDir, 'taste.yaml'), '{{{{invalid yaml}}}}', 'utf8');

    const tm = new TasteManager(opts);
    tm.init();
    // Should not crash; returns error but starts with empty rules
    expect(tm.getRuleCount()).toBe(0);
  });

  it('should handle missing project directory', () => {
    const opts = createOptions({ projectDir: '/nonexistent/path/taste-test' });
    const tm = new TasteManager(opts);
    const result = tm.init();
    expect(result.ok).toBe(true);
    expect(tm.getRuleCount()).toBe(0);
  });

  it('should auto-init on first operation if not explicitly called', () => {
    const tm = new TasteManager(createOptions());
    // Don't call init() — should auto-init
    const rules = tm.listRules();
    expect(rules).toEqual([]);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// addRule()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager addRule()', () => {
  let tm: TasteManager;

  beforeEach(() => {
    tm = new TasteManager(createOptions());
    tm.init();
  });

  it('should add a valid rule', () => {
    const result = tm.addRule({
      rule: 'Use const/let, never var',
      category: 'code_style',
      source: 'auto',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.rule).toBe('Use const/let, never var');
      expect(result.data.category).toBe('code_style');
      expect(result.data.source).toBe('auto');
      expect(result.data.correctionCount).toBe(1); // auto starts at 1
      expect(result.data.lastSeen).toBeTruthy();
    }
  });

  it('should add a manual rule with correctionCount 0', () => {
    const result = tm.addRule({
      rule: 'Reply concisely',
      category: 'interaction',
      source: 'manual',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.correctionCount).toBe(0);
    }
  });

  it('should add a rule from claude_md', () => {
    const result = tm.addRule({
      rule: 'Always use TypeScript',
      category: 'tech_stack',
      source: 'claude_md',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe('claude_md');
    }
  });

  it('should reject empty rule text', () => {
    const result = tm.addRule({
      rule: '',
      category: 'code_style',
      source: 'manual',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不能为空');
    }
  });

  it('should reject whitespace-only rule text', () => {
    const result = tm.addRule({
      rule: '   ',
      category: 'code_style',
      source: 'manual',
    });
    expect(result.ok).toBe(false);
  });

  it('should reject rule exceeding max length', () => {
    const result = tm.addRule({
      rule: 'x'.repeat(501),
      category: 'code_style',
      source: 'manual',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('500');
    }
  });

  it('should accept rule at exactly max length', () => {
    const result = tm.addRule({
      rule: 'x'.repeat(500),
      category: 'code_style',
      source: 'manual',
    });
    expect(result.ok).toBe(true);
  });

  it('should reject custom category without customCategoryName', () => {
    const result = tm.addRule({
      rule: 'Some rule',
      category: 'custom',
      source: 'manual',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('customCategoryName');
    }
  });

  it('should accept custom category with customCategoryName', () => {
    const result = tm.addRule({
      rule: 'Some rule',
      category: 'custom',
      source: 'manual',
      customCategoryName: 'My Custom Category',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.customCategoryName).toBe('My Custom Category');
    }
  });

  // ── Deduplication ──

  it('should deduplicate rules with same text (case-insensitive)', () => {
    tm.addRule({ rule: 'Use TypeScript', category: 'tech_stack', source: 'auto' });
    const result = tm.addRule({ rule: 'use typescript', category: 'tech_stack', source: 'auto' });

    expect(tm.getRuleCount()).toBe(1);
    if (result.ok) {
      expect(result.data.correctionCount).toBe(2); // Incremented
    }
  });

  it('should deduplicate rules with extra whitespace', () => {
    tm.addRule({ rule: 'Use TypeScript', category: 'tech_stack', source: 'auto' });
    tm.addRule({ rule: '  Use   TypeScript  ', category: 'tech_stack', source: 'auto' });

    expect(tm.getRuleCount()).toBe(1);
  });

  it('should not increment count when incrementIfExists is false', () => {
    tm.addRule({ rule: 'Use TypeScript', category: 'tech_stack', source: 'auto' });
    const result = tm.addRule({
      rule: 'Use TypeScript',
      category: 'tech_stack',
      source: 'manual',
      incrementIfExists: false,
    });

    if (result.ok) {
      expect(result.data.correctionCount).toBe(1); // Not incremented
    }
  });

  it('should upgrade source to more authoritative on merge', () => {
    tm.addRule({ rule: 'Use TypeScript', category: 'tech_stack', source: 'auto' });
    const result = tm.addRule({
      rule: 'Use TypeScript',
      category: 'tech_stack',
      source: 'manual',
    });

    if (result.ok) {
      expect(result.data.source).toBe('manual'); // manual > auto
    }
  });

  // ── Max Rules ──

  it('should reject adding beyond max rules limit', () => {
    for (let i = 0; i < 100; i++) {
      tm.addRule({
        rule: `Rule ${i} - unique text ${Math.random()}`,
        category: 'code_style',
        source: 'manual',
      });
    }

    const result = tm.addRule({
      rule: 'One rule too many',
      category: 'code_style',
      source: 'manual',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('100');
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// removeRule()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager removeRule()', () => {
  let tm: TasteManager;

  beforeEach(() => {
    tm = new TasteManager(createOptions());
    tm.init();
  });

  it('should remove rule by index', () => {
    tm.addRule({ rule: 'Rule A', category: 'code_style', source: 'manual' });
    tm.addRule({ rule: 'Rule B', category: 'interaction', source: 'manual' });

    const result = tm.removeRule(0);
    expect(result.ok).toBe(true);
    expect(tm.getRuleCount()).toBe(1);

    const rules = tm.listRules();
    expect(rules[0].rule).toBe('Rule B');
  });

  it('should remove rule by text match', () => {
    tm.addRule({ rule: 'Rule A', category: 'code_style', source: 'manual' });
    tm.addRule({ rule: 'Rule B', category: 'interaction', source: 'manual' });

    const result = tm.removeRule(undefined, 'Rule A');
    expect(result.ok).toBe(true);
    expect(tm.getRuleCount()).toBe(1);
  });

  it('should reject invalid index', () => {
    tm.addRule({ rule: 'Only rule', category: 'code_style', source: 'manual' });

    const result = tm.removeRule(5);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('超出范围');
    }
  });

  it('should reject negative index', () => {
    tm.addRule({ rule: 'Only rule', category: 'code_style', source: 'manual' });

    const result = tm.removeRule(-1);
    expect(result.ok).toBe(false);
  });

  it('should reject non-matching text', () => {
    tm.addRule({ rule: 'Only rule', category: 'code_style', source: 'manual' });

    const result = tm.removeRule(undefined, 'nonexistent');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('未找到');
    }
  });

  it('should reject call with neither index nor text', () => {
    const result = tm.removeRule();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('必须提供');
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// listRules()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager listRules()', () => {
  let tm: TasteManager;

  beforeEach(() => {
    tm = new TasteManager(createOptions());
    tm.init();
  });

  it('should return empty array when no rules', () => {
    expect(tm.listRules()).toEqual([]);
  });

  it('should return all rules without filter', () => {
    tm.addRule({ rule: 'Rule A', category: 'code_style', source: 'auto' });
    tm.addRule({ rule: 'Rule B', category: 'interaction', source: 'manual' });
    tm.addRule({ rule: 'Rule C', category: 'tech_stack', source: 'claude_md' });

    const rules = tm.listRules();
    expect(rules).toHaveLength(3);
  });

  it('should filter by category', () => {
    tm.addRule({ rule: 'Rule A', category: 'code_style', source: 'manual' });
    tm.addRule({ rule: 'Rule B', category: 'interaction', source: 'manual' });
    tm.addRule({ rule: 'Rule C', category: 'code_style', source: 'manual' });

    const rules = tm.listRules({ category: 'code_style' });
    expect(rules).toHaveLength(2);
    expect(rules.every((r) => r.category === 'code_style')).toBe(true);
  });

  it('should filter by source', () => {
    tm.addRule({ rule: 'Rule A', category: 'code_style', source: 'auto' });
    tm.addRule({ rule: 'Rule B', category: 'interaction', source: 'manual' });

    const rules = tm.listRules({ source: 'auto' });
    expect(rules).toHaveLength(1);
    expect(rules[0].source).toBe('auto');
  });

  it('should filter by minCorrections', () => {
    tm.addRule({ rule: 'Rule A', category: 'code_style', source: 'auto' }); // count = 1
    tm.addRule({ rule: 'Rule A', category: 'code_style', source: 'auto' }); // count = 2
    tm.addRule({ rule: 'Rule B', category: 'interaction', source: 'manual' }); // count = 0

    const rules = tm.listRules({ minCorrections: 2 });
    expect(rules).toHaveLength(1);
    expect(rules[0].rule).toBe('Rule A');
  });

  it('should combine multiple filters with AND logic', () => {
    tm.addRule({ rule: 'Rule A', category: 'code_style', source: 'auto' });
    tm.addRule({ rule: 'Rule B', category: 'code_style', source: 'manual' });
    tm.addRule({ rule: 'Rule C', category: 'interaction', source: 'auto' });

    const rules = tm.listRules({ category: 'code_style', source: 'auto' });
    expect(rules).toHaveLength(1);
    expect(rules[0].rule).toBe('Rule A');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// clearRules()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager clearRules()', () => {
  it('should remove all rules', () => {
    const tm = new TasteManager(createOptions());
    tm.init();
    tm.addRule({ rule: 'Rule A', category: 'code_style', source: 'manual' });
    tm.addRule({ rule: 'Rule B', category: 'interaction', source: 'manual' });

    expect(tm.getRuleCount()).toBe(2);

    const result = tm.clearRules();
    expect(result.ok).toBe(true);
    expect(tm.getRuleCount()).toBe(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Persistence
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager persistence', () => {
  it('should create taste.yaml on first add', () => {
    const opts = createOptions();
    const tm = new TasteManager(opts);
    tm.init();

    tm.addRule({ rule: 'Test rule', category: 'code_style', source: 'manual' });

    expect(existsSync(join(opts.projectDir, 'taste.yaml'))).toBe(true);
  });

  it('should persist rules as readable YAML', () => {
    const opts = createOptions();
    const tm = new TasteManager(opts);
    tm.init();

    tm.addRule({ rule: 'Use const/let', category: 'code_style', source: 'auto' });

    const raw = readFileSync(join(opts.projectDir, 'taste.yaml'), 'utf8');
    expect(raw).toContain('Use const/let');
    expect(raw).toContain('code_style');
    expect(raw).toContain('auto');
  });

  it('should survive full round-trip: add → persist → reload', () => {
    const opts = createOptions();

    // Phase 1: Add rules
    const tm1 = new TasteManager(opts);
    tm1.init();
    tm1.addRule({ rule: 'Rule A', category: 'code_style', source: 'auto' });
    tm1.addRule({ rule: 'Rule B', category: 'interaction', source: 'manual' });

    // Phase 2: Reload from disk
    const tm2 = new TasteManager(opts);
    tm2.init();

    expect(tm2.getRuleCount()).toBe(2);
    const rules = tm2.listRules();
    expect(rules.some((r) => r.rule === 'Rule A')).toBe(true);
    expect(rules.some((r) => r.rule === 'Rule B')).toBe(true);
  });

  it('should persist after remove', () => {
    const opts = createOptions();

    const tm1 = new TasteManager(opts);
    tm1.init();
    tm1.addRule({ rule: 'Keep me', category: 'code_style', source: 'manual' });
    tm1.addRule({ rule: 'Remove me', category: 'interaction', source: 'manual' });
    tm1.removeRule(undefined, 'Remove me');

    // Reload
    const tm2 = new TasteManager(opts);
    tm2.init();

    expect(tm2.getRuleCount()).toBe(1);
    expect(tm2.listRules()[0].rule).toBe('Keep me');
  });

  it('should persist after clear', () => {
    const opts = createOptions();

    const tm1 = new TasteManager(opts);
    tm1.init();
    tm1.addRule({ rule: 'Rule', category: 'code_style', source: 'manual' });
    tm1.clearRules();

    // Reload
    const tm2 = new TasteManager(opts);
    tm2.init();

    expect(tm2.getRuleCount()).toBe(0);
  });

  it('should not leave .tmp files after successful persist', () => {
    const opts = createOptions();
    const tm = new TasteManager(opts);
    tm.init();
    tm.addRule({ rule: 'Rule', category: 'code_style', source: 'manual' });

    expect(existsSync(join(opts.projectDir, 'taste.yaml.tmp'))).toBe(false);
  });

  it('should handle YAML with quoted strings containing special chars', () => {
    const opts = createOptions();
    const tm = new TasteManager(opts);
    tm.init();

    tm.addRule({ rule: 'Use "quotes" in code', category: 'code_style', source: 'manual' });

    // Reload
    const tm2 = new TasteManager(opts);
    tm2.init();

    const rules = tm2.listRules();
    expect(rules[0].rule).toBe('Use "quotes" in code');
  });

  it('should preserve correctionCount through persist/reload cycle', () => {
    const opts = createOptions();

    const tm1 = new TasteManager(opts);
    tm1.init();
    tm1.addRule({ rule: 'Test rule', category: 'code_style', source: 'auto' }); // count = 1
    tm1.addRule({ rule: 'Test rule', category: 'code_style', source: 'auto' }); // count = 2
    tm1.addRule({ rule: 'Test rule', category: 'code_style', source: 'auto' }); // count = 3

    // Reload
    const tm2 = new TasteManager(opts);
    tm2.init();

    const rules = tm2.listRules();
    expect(rules[0].correctionCount).toBe(3);
  });

  it('should handle hand-edited YAML file', () => {
    const opts = createOptions();
    const { projectDir } = opts;

    // Write a manually edited taste.yaml
    writeFileSync(join(projectDir, 'taste.yaml'), `# My custom taste file
version: 1

rules:
  - rule: "Always use pnpm"
    category: tech_stack
    source: manual
    correctionCount: 0
    lastSeen: "2026-04-20T10:00:00.000Z"
`, 'utf8');

    const tm = new TasteManager(opts);
    tm.init();

    expect(tm.getRuleCount()).toBe(1);
    expect(tm.listRules()[0].rule).toBe('Always use pnpm');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// formatForPrompt()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager formatForPrompt()', () => {
  it('should return null when no rules', () => {
    const tm = new TasteManager(createOptions());
    tm.init();
    expect(tm.formatForPrompt()).toBeNull();
  });

  it('should format rules grouped by category', () => {
    const tm = new TasteManager(createOptions());
    tm.init();
    tm.addRule({ rule: 'Use const/let', category: 'code_style', source: 'auto' });
    tm.addRule({ rule: 'Reply concisely', category: 'interaction', source: 'manual' });

    const formatted = tm.formatForPrompt();
    expect(formatted).toBeTruthy();
    expect(formatted!).toContain('User Preferences');
    expect(formatted!).toContain('Use const/let');
    expect(formatted!).toContain('Reply concisely');
    expect(formatted!).toContain('Code Style');
    expect(formatted!).toContain('Interaction');
  });

  it('should include provenance information', () => {
    const tm = new TasteManager(createOptions());
    tm.init();
    tm.addRule({ rule: 'Use const/let', category: 'code_style', source: 'auto' });

    const formatted = tm.formatForPrompt();
    expect(formatted).toContain('corrected');
  });

  it('should use custom category name for custom category', () => {
    const tm = new TasteManager(createOptions());
    tm.init();
    tm.addRule({
      rule: 'Custom rule',
      category: 'custom',
      source: 'manual',
      customCategoryName: 'My Special Rules',
    });

    const formatted = tm.formatForPrompt();
    expect(formatted).toContain('My Special Rules');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// getFormattedRules()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager getFormattedRules()', () => {
  it('should return formatted rules with labels', () => {
    const tm = new TasteManager(createOptions());
    tm.init();
    tm.addRule({ rule: 'Use const/let', category: 'code_style', source: 'auto' });

    const formatted = tm.getFormattedRules();
    expect(formatted).toHaveLength(1);
    expect(formatted[0].rule).toBe('Use const/let');
    expect(formatted[0].categoryLabel).toBe('Code Style');
    expect(formatted[0].provenance).toBeTruthy();
  });

  it('should support filter parameter', () => {
    const tm = new TasteManager(createOptions());
    tm.init();
    tm.addRule({ rule: 'Rule A', category: 'code_style', source: 'auto' });
    tm.addRule({ rule: 'Rule B', category: 'interaction', source: 'manual' });

    const formatted = tm.getFormattedRules({ category: 'interaction' });
    expect(formatted).toHaveLength(1);
    expect(formatted[0].rule).toBe('Rule B');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// getTastePath()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager getTastePath()', () => {
  it('should return the correct taste.yaml path', () => {
    const opts = createOptions();
    const tm = new TasteManager(opts);
    expect(tm.getTastePath()).toBe(join(opts.projectDir, 'taste.yaml'));
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Edge Cases
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager — edge cases', () => {
  it('should handle rule text with special characters', () => {
    const tm = new TasteManager(createOptions());
    tm.init();

    const result = tm.addRule({
      rule: 'Use `backticks` and "quotes" and /slashes/',
      category: 'code_style',
      source: 'manual',
    });

    expect(result.ok).toBe(true);
  });

  it('should handle rapid sequential add operations', () => {
    const tm = new TasteManager(createOptions());
    tm.init();

    for (let i = 0; i < 50; i++) {
      tm.addRule({
        rule: `Rule number ${i}`,
        category: 'code_style',
        source: 'manual',
      });
    }

    expect(tm.getRuleCount()).toBe(50);
  });

  it('should handle unicode in rule text', () => {
    const tm = new TasteManager(createOptions());
    tm.init();

    const result = tm.addRule({
      rule: '使用中文命名变量 (使用 camelCase)',
      category: 'code_style',
      source: 'manual',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.rule).toBe('使用中文命名变量 (使用 camelCase)');
    }
  });

  it('should trim whitespace from rule text', () => {
    const tm = new TasteManager(createOptions());
    tm.init();

    const result = tm.addRule({
      rule: '  Use TypeScript  ',
      category: 'tech_stack',
      source: 'manual',
    });

    if (result.ok) {
      expect(result.data.rule).toBe('Use TypeScript');
    }
  });
});
