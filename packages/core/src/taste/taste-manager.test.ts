/**
 * Unit tests for TasteManager — taste rule CRUD and persistence.
 *
 * Tests cover:
 * - Rule creation with validation
 * - Rule removal and update
 * - Duplicate detection
 * - Auto-detected rule recording (recordCorrection)
 * - Persistence (atomic write, load, restore, corruption handling)
 * - Guidance data export
 * - Edge cases (empty content, max rules, etc.)
 *
 * @see Issue #2335 (auto-summarize user taste)
 */

import { describe, it, expect, afterEach } from 'vitest';
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
  const workingDir = createTempDir();
  return {
    workingDir,
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
// Constructor & load()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager constructor', () => {
  it('should construct with valid options and start empty', () => {
    const tm = new TasteManager(createOptions());
    expect(tm.getRuleCount()).toBe(0);
    expect(tm.getRules()).toEqual([]);
  });

  it('should auto-load existing taste.json from disk', () => {
    const dir = createTempDir();
    const tastePath = join(dir, 'taste.json');
    writeFileSync(tastePath, JSON.stringify({
      rules: [
        {
          id: 'test-1',
          content: '使用 const/let，禁止 var',
          category: 'code_style',
          source: 'manual',
          createdAt: '2026-04-01T00:00:00Z',
        },
      ],
    }), 'utf8');

    const tm = new TasteManager({ workingDir: dir });
    expect(tm.getRuleCount()).toBe(1);
    expect(tm.getRule('test-1')?.content).toBe('使用 const/let，禁止 var');
  });

  it('should handle missing taste.json gracefully', () => {
    const tm = new TasteManager(createOptions());
    expect(tm.hasData()).toBe(false);
    expect(tm.getRuleCount()).toBe(0);
  });

  it('should handle corrupted taste.json gracefully', () => {
    const dir = createTempDir();
    const tastePath = join(dir, 'taste.json');
    writeFileSync(tastePath, 'not valid json {{{', 'utf8');

    const tm = new TasteManager({ workingDir: dir });
    expect(tm.getRuleCount()).toBe(0);
  });

  it('should handle invalid schema in taste.json gracefully', () => {
    const dir = createTempDir();
    const tastePath = join(dir, 'taste.json');
    writeFileSync(tastePath, JSON.stringify({ rules: 'not an array' }), 'utf8');

    const tm = new TasteManager({ workingDir: dir });
    expect(tm.getRuleCount()).toBe(0);
  });

  it('should skip invalid individual rules when loading', () => {
    const dir = createTempDir();
    const tastePath = join(dir, 'taste.json');
    writeFileSync(tastePath, JSON.stringify({
      rules: [
        { id: 'valid', content: 'valid rule', category: 'other', source: 'manual', createdAt: '2026-04-01T00:00:00Z' },
        { id: '', content: 'missing fields' },
        null,
      ],
    }), 'utf8');

    const tm = new TasteManager({ workingDir: dir });
    expect(tm.getRuleCount()).toBe(1);
    expect(tm.getRule('valid')?.content).toBe('valid rule');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// addRule()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('addRule', () => {
  it('should add a rule with minimal options', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.addRule({ content: '使用 const/let' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.content).toBe('使用 const/let');
      expect(result.data.category).toBe('other');
      expect(result.data.source).toBe('manual');
      expect(result.data.id).toBeDefined();
    }
    expect(tm.getRuleCount()).toBe(1);
  });

  it('should add a rule with all options', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.addRule({
      content: '回复简洁',
      category: 'interaction',
      source: 'auto_detected',
      count: 3,
      id: 'custom-id',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe('custom-id');
      expect(result.data.category).toBe('interaction');
      expect(result.data.source).toBe('auto_detected');
      expect(result.data.count).toBe(3);
      expect(result.data.lastSeen).toBeDefined();
    }
  });

  it('should trim whitespace from content', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.addRule({ content: '  使用 TypeScript  ' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.content).toBe('使用 TypeScript');
    }
  });

  it('should reject empty content', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.addRule({ content: '' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不能为空');
    }
  });

  it('should reject whitespace-only content', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.addRule({ content: '   ' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不能为空');
    }
  });

  it('should reject duplicate content (case-insensitive)', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule({ content: '使用 const/let' });
    const result = tm.addRule({ content: '使用 CONST/LET' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('已存在');
    }
  });

  it('should persist after adding a rule', () => {
    const dir = createTempDir();
    const tm = new TasteManager({ workingDir: dir });
    tm.addRule({ content: '使用 TypeScript' });

    expect(existsSync(join(dir, 'taste.json'))).toBe(true);
    const data = JSON.parse(readFileSync(join(dir, 'taste.json'), 'utf8'));
    expect(data.rules).toHaveLength(1);
    expect(data.rules[0].content).toBe('使用 TypeScript');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// removeRule()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('removeRule', () => {
  it('should remove an existing rule', () => {
    const tm = new TasteManager(createOptions());
    const added = tm.addRule({ content: '使用 const/let' });
    expect(tm.getRuleCount()).toBe(1);

    if (!added.ok) {throw new Error('addRule failed');}
    const result = tm.removeRule(added.data.id);
    expect(result.ok).toBe(true);
    expect(tm.getRuleCount()).toBe(0);
  });

  it('should return error for non-existent rule', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.removeRule('non-existent-id');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不存在');
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// updateRule()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('updateRule', () => {
  it('should update rule content', () => {
    const tm = new TasteManager(createOptions());
    const added = tm.addRule({ content: '使用 var' });
    if (!added.ok) {throw new Error('addRule failed');}
    const result = tm.updateRule(added.data.id, '使用 const/let');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.content).toBe('使用 const/let');
      expect(tm.getRule(added.data.id)!.content).toBe('使用 const/let');
    }
  });

  it('should reject empty new content', () => {
    const tm = new TasteManager(createOptions());
    const added = tm.addRule({ content: 'some rule' });
    if (!added.ok) {throw new Error('addRule failed');}
    const result = tm.updateRule(added.data.id, '');

    expect(result.ok).toBe(false);
  });

  it('should return error for non-existent rule', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.updateRule('non-existent-id', 'new content');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不存在');
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// recordCorrection()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('recordCorrection', () => {
  it('should create new auto-detected rule on first correction', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.recordCorrection('不要用 var', 'code_style');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.content).toBe('不要用 var');
      expect(result.data.category).toBe('code_style');
      expect(result.data.source).toBe('auto_detected');
      expect(result.data.count).toBe(1);
      expect(result.data.lastSeen).toBeDefined();
    }
  });

  it('should increment count for existing rule on repeated correction', () => {
    const tm = new TasteManager(createOptions());
    tm.recordCorrection('不要用 var');

    const result = tm.recordCorrection('不要用 var');
    if (!result.ok) {throw new Error('expected ok');}
    expect(result.data.count).toBe(2);
    expect(result.data.content).toBe('不要用 var');
  });

  it('should be case-insensitive when matching existing rules', () => {
    const tm = new TasteManager(createOptions());
    tm.recordCorrection('不要用 var');

    const result = tm.recordCorrection('不要用 VAR');
    if (!result.ok) {throw new Error('expected ok');}
    expect(result.data.count).toBe(2);
  });

  it('should update lastSeen on repeated correction', () => {
    const tm = new TasteManager(createOptions());
    tm.recordCorrection('不要用 var');
    const before = new Date().toISOString();

    const result = tm.recordCorrection('不要用 var');
    if (!result.ok) {throw new Error('expected ok');}
    expect(result.data.lastSeen).toBeDefined();
    expect(result.data.lastSeen! >= before).toBe(true);
  });

  it('should reject empty content', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.recordCorrection('');

    if (result.ok) {throw new Error('expected error');}
    expect(result.error).toContain('不能为空');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// getRules() & getRulesByCategory()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('getRules & getRulesByCategory', () => {
  it('should return rules sorted by category then creation time', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule({ content: 'rule B', category: 'code_style' });
    tm.addRule({ content: 'rule A', category: 'interaction' });
    tm.addRule({ content: 'rule C', category: 'code_style' });

    const rules = tm.getRules();
    expect(rules[0].category).toBe('code_style');
    expect(rules[0].content).toBe('rule B');
    expect(rules[1].category).toBe('code_style');
    expect(rules[1].content).toBe('rule C');
    expect(rules[2].category).toBe('interaction');
  });

  it('should filter rules by category', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule({ content: 'rule 1', category: 'code_style' });
    tm.addRule({ content: 'rule 2', category: 'interaction' });
    tm.addRule({ content: 'rule 3', category: 'code_style' });

    const codeStyleRules = tm.getRulesByCategory('code_style');
    expect(codeStyleRules).toHaveLength(2);
  });

  it('should return empty array for non-existent category', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule({ content: 'rule 1', category: 'code_style' });

    const result = tm.getRulesByCategory('nonexistent');
    expect(result).toEqual([]);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// clearAll()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('clearAll', () => {
  it('should remove all rules', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule({ content: 'rule 1' });
    tm.addRule({ content: 'rule 2' });
    expect(tm.getRuleCount()).toBe(2);

    tm.clearAll();
    expect(tm.getRuleCount()).toBe(0);
  });

  it('should persist after clearing', () => {
    const dir = createTempDir();
    const tm = new TasteManager({ workingDir: dir });
    tm.addRule({ content: 'rule 1' });
    tm.clearAll();

    const data = JSON.parse(readFileSync(join(dir, 'taste.json'), 'utf8'));
    expect(data.rules).toHaveLength(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// toGuidanceData()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('toGuidanceData', () => {
  it('should return empty array when no rules', () => {
    const tm = new TasteManager(createOptions());
    expect(tm.toGuidanceData()).toEqual([]);
  });

  it('should group rules by category', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule({ content: 'rule 1', category: 'code_style' });
    tm.addRule({ content: 'rule 2', category: 'code_style' });
    tm.addRule({ content: 'rule 3', category: 'interaction' });

    const groups = tm.toGuidanceData();
    expect(groups).toHaveLength(2);
    expect(groups[0].category).toBe('code_style');
    expect(groups[0].rules).toHaveLength(2);
    expect(groups[1].category).toBe('interaction');
    expect(groups[1].rules).toHaveLength(1);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Persistence
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('persistence', () => {
  it('should create working directory if it does not exist', () => {
    const parentDir = createTempDir();
    const workingDir = join(parentDir, 'subdir', 'nested');
    const tm = new TasteManager({ workingDir });
    tm.addRule({ content: 'test rule' });

    expect(existsSync(join(workingDir, 'taste.json'))).toBe(true);
  });

  it('should use atomic write-then-rename pattern', () => {
    const dir = createTempDir();
    const tm = new TasteManager({ workingDir: dir });
    tm.addRule({ content: 'atomic test' });

    // Final file should exist, tmp file should not
    expect(existsSync(join(dir, 'taste.json'))).toBe(true);
    expect(existsSync(join(dir, 'taste.json.tmp'))).toBe(false);
  });

  it('should round-trip data correctly (write then read)', () => {
    const dir = createTempDir();
    const tm1 = new TasteManager({ workingDir: dir });
    tm1.addRule({ content: '使用 TypeScript', category: 'tech_choice', source: 'auto_detected', count: 5 });

    // Create new instance from same directory
    const tm2 = new TasteManager({ workingDir: dir });
    expect(tm2.getRuleCount()).toBe(1);
    const [rule] = tm2.getRules();
    expect(rule.content).toBe('使用 TypeScript');
    expect(rule.category).toBe('tech_choice');
    expect(rule.source).toBe('auto_detected');
    expect(rule.count).toBe(5);
  });

  it('should persist getPersistPath correctly', () => {
    const dir = createTempDir();
    const tm = new TasteManager({ workingDir: dir });
    expect(tm.getPersistPath()).toBe(join(dir, 'taste.json'));
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Edge Cases
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('edge cases', () => {
  it('should handle undefined content in addRule', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.addRule({ content: undefined as unknown as string });

    expect(result.ok).toBe(false);
  });

  it('should handle getRule for non-existent ID', () => {
    const tm = new TasteManager(createOptions());
    expect(tm.getRule('non-existent')).toBeUndefined();
  });

  it('should respect max rules limit', () => {
    const tm = new TasteManager(createOptions());
    // Add 100 unique rules (the limit)
    for (let i = 0; i < 100; i++) {
      const result = tm.addRule({ content: `rule ${i}` });
      expect(result.ok).toBe(true);
    }

    // 101st should fail
    const result = tm.addRule({ content: 'rule 100' });
    if (result.ok) {throw new Error('expected error');}
    expect(result.error).toContain('最大规则数');
  });
});
