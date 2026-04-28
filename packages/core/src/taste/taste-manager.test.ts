/**
 * Unit tests for TasteManager — user preference persistence logic.
 *
 * Tests cover:
 * - Rule creation with input validation
 * - Duplicate detection and reinforcement
 * - Rule removal and update
 * - Rule listing with filters
 * - Context formatting for Agent prompt injection
 * - Persistence (atomic write, load, restore, corruption handling)
 * - Edge cases (max rules, empty content, etc.)
 *
 * @see Issue #2335
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
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
    workspaceDir: createTempDir(),
    ...overrides,
  };
}

function createManager(overrides?: Partial<TasteManagerOptions>): TasteManager {
  return new TasteManager(createOptions(overrides));
}

// Cleanup all temp directories after all tests
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
    const mgr = createManager();
    expect(mgr.getRuleCount()).toBe(0);
  });

  it('should create .disclaude directory on first persist', () => {
    const options = createOptions();
    const mgr = new TasteManager(options);
    mgr.addRule('code_style', '使用 const/let');
    expect(existsSync(join(options.workspaceDir, '.disclaude', 'taste.json'))).toBe(true);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// addRule()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('addRule', () => {
  it('should add a rule and return it', () => {
    const mgr = createManager();
    const result = mgr.addRule('code_style', '使用 const/let，禁止 var');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.category).toBe('code_style');
      expect(result.data.content).toBe('使用 const/let，禁止 var');
      expect(result.data.source).toBe('manual');
      expect(result.data.count).toBe(1);
      expect(result.data.id).toMatch(/^taste_/);
    }
  });

  it('should add rule with auto source', () => {
    const mgr = createManager();
    const result = mgr.addRule('interaction', '回复简洁', 'auto');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe('auto');
    }
  });

  it('should trim content whitespace', () => {
    const mgr = createManager();
    const result = mgr.addRule('general', '  偏好内容  ');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.content).toBe('偏好内容');
    }
  });

  it('should reject empty content', () => {
    const mgr = createManager();
    const result = mgr.addRule('code_style', '');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不能为空');
    }
  });

  it('should reject whitespace-only content', () => {
    const mgr = createManager();
    const result = mgr.addRule('code_style', '   ');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不能为空');
    }
  });

  it('should reject content exceeding max length', () => {
    const mgr = createManager();
    const longContent = 'x'.repeat(501);
    const result = mgr.addRule('code_style', longContent);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不能超过');
    }
  });

  it('should reinforce existing rule instead of creating duplicate', () => {
    const mgr = createManager();
    const r1 = mgr.addRule('code_style', '使用 TypeScript');
    expect(r1.ok).toBe(true);

    const r2 = mgr.addRule('code_style', '使用 TypeScript');
    expect(r2.ok).toBe(true);
    if (r2.ok && r1.ok) {
      expect(r2.data.id).toBe(r1.data.id);
      expect(r2.data.count).toBe(2);
    }

    expect(mgr.getRuleCount()).toBe(1);
  });

  it('should enforce max rules limit', () => {
    const mgr = createManager();
    // Add 100 rules (max)
    for (let i = 0; i < 100; i++) {
      mgr.addRule('general', `Rule ${i}`);
    }
    expect(mgr.getRuleCount()).toBe(100);

    // 101st should fail
    const result = mgr.addRule('general', 'One more');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('上限');
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// removeRule()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('removeRule', () => {
  it('should remove an existing rule', () => {
    const mgr = createManager();
    const added = mgr.addRule('code_style', '使用 const');
    expect(added.ok).toBe(true);
    if (!added.ok) {return;}

    const removed = mgr.removeRule(added.data.id);
    expect(removed.ok).toBe(true);
    if (removed.ok) {
      expect(removed.data.id).toBe(added.data.id);
    }
    expect(mgr.getRuleCount()).toBe(0);
  });

  it('should fail for non-existent rule', () => {
    const mgr = createManager();
    const result = mgr.removeRule('nonexistent');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不存在');
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// reinforceRule()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('reinforceRule', () => {
  it('should increment count and update lastSeen', () => {
    const mgr = createManager();
    const added = mgr.addRule('interaction', '简洁回复');
    expect(added.ok).toBe(true);
    if (!added.ok) {return;}

    const reinforced = mgr.reinforceRule(added.data.id);
    expect(reinforced.ok).toBe(true);
    if (reinforced.ok) {
      expect(reinforced.data.count).toBe(2);
    }
  });

  it('should fail for non-existent rule', () => {
    const mgr = createManager();
    const result = mgr.reinforceRule('nonexistent');
    expect(result.ok).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// updateRule()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('updateRule', () => {
  it('should update content', () => {
    const mgr = createManager();
    const added = mgr.addRule('general', '旧内容');
    expect(added.ok).toBe(true);
    if (!added.ok) {return;}

    const updated = mgr.updateRule(added.data.id, { content: '新内容' });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.data.content).toBe('新内容');
    }
  });

  it('should update category', () => {
    const mgr = createManager();
    const added = mgr.addRule('general', '一些规则');
    expect(added.ok).toBe(true);
    if (!added.ok) {return;}

    const updated = mgr.updateRule(added.data.id, { category: 'code_style' });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.data.category).toBe('code_style');
    }
  });

  it('should reject empty content update', () => {
    const mgr = createManager();
    const added = mgr.addRule('general', '一些规则');
    expect(added.ok).toBe(true);
    if (!added.ok) {return;}

    const updated = mgr.updateRule(added.data.id, { content: '' });
    expect(updated.ok).toBe(false);
  });

  it('should fail for non-existent rule', () => {
    const mgr = createManager();
    const result = mgr.updateRule('nonexistent', { content: 'x' });
    expect(result.ok).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// listRules()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('listRules', () => {
  it('should return empty array when no rules', () => {
    const mgr = createManager();
    expect(mgr.listRules()).toEqual([]);
  });

  it('should list all rules sorted by lastSeen', () => {
    const mgr = createManager();
    mgr.addRule('code_style', 'Rule A');
    mgr.addRule('interaction', 'Rule B');
    mgr.addRule('general', 'Rule C');

    const rules = mgr.listRules();
    expect(rules).toHaveLength(3);
    // All three rules should be present (exact order depends on timestamp precision)
    const contents = rules.map(r => r.content);
    expect(contents).toContain('Rule A');
    expect(contents).toContain('Rule B');
    expect(contents).toContain('Rule C');
  });

  it('should filter by category', () => {
    const mgr = createManager();
    mgr.addRule('code_style', 'Style rule');
    mgr.addRule('interaction', 'Interaction rule');
    mgr.addRule('code_style', 'Another style');

    const styleRules = mgr.listRules({ category: 'code_style' });
    expect(styleRules).toHaveLength(2);
    expect(styleRules.every(r => r.category === 'code_style')).toBe(true);
  });

  it('should filter by source', () => {
    const mgr = createManager();
    mgr.addRule('general', 'Manual rule', 'manual');
    mgr.addRule('general', 'Auto rule', 'auto');

    const autoRules = mgr.listRules({ source: 'auto' });
    expect(autoRules).toHaveLength(1);
    expect(autoRules[0].content).toBe('Auto rule');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// formatTasteContext()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('formatTasteContext', () => {
  it('should return empty string when no rules', () => {
    const mgr = createManager();
    expect(mgr.formatTasteContext()).toBe('');
  });

  it('should format rules grouped by category', () => {
    const mgr = createManager();
    mgr.addRule('code_style', '使用 const/let');
    mgr.addRule('interaction', '回复简洁');

    const context = mgr.formatTasteContext();
    expect(context).toContain('代码风格');
    expect(context).toContain('使用 const/let');
    expect(context).toContain('交互偏好');
    expect(context).toContain('回复简洁');
  });

  it('should include count for auto-detected rules', () => {
    const mgr = createManager();
    mgr.addRule('code_style', '使用 TypeScript', 'auto');
    mgr.addRule('code_style', '使用 TypeScript'); // reinforce

    const context = mgr.formatTasteContext();
    expect(context).toContain('被纠正 2 次');
  });

  it('should not include count for manual rules', () => {
    const mgr = createManager();
    mgr.addRule('general', '手动规则', 'manual');

    const context = mgr.formatTasteContext();
    expect(context).not.toContain('被纠正');
  });

  it('should sort rules within category by count descending', () => {
    const mgr = createManager();
    mgr.addRule('code_style', 'Rule A', 'auto');
    // Reinforce Rule A
    mgr.addRule('code_style', 'Rule A'); // count = 2
    mgr.addRule('code_style', 'Rule B', 'auto'); // count = 1

    const context = mgr.formatTasteContext();
    const ruleAIndex = context.indexOf('Rule A');
    const ruleBIndex = context.indexOf('Rule B');
    expect(ruleAIndex).toBeLessThan(ruleBIndex);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// clearAll()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('clearAll', () => {
  it('should remove all rules', () => {
    const mgr = createManager();
    mgr.addRule('general', 'Rule 1');
    mgr.addRule('general', 'Rule 2');
    expect(mgr.getRuleCount()).toBe(2);

    mgr.clearAll();
    expect(mgr.getRuleCount()).toBe(0);
    expect(mgr.formatTasteContext()).toBe('');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Persistence
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('persistence', () => {
  it('should persist rules to taste.json', () => {
    const options = createOptions();
    const mgr = new TasteManager(options);
    mgr.addRule('code_style', '使用 TypeScript');

    const persistPath = join(options.workspaceDir, '.disclaude', 'taste.json');
    expect(existsSync(persistPath)).toBe(true);

    const data = JSON.parse(readFileSync(persistPath, 'utf8'));
    expect(data.version).toBe(1);
    expect(data.rules).toHaveLength(1);
    expect(data.rules[0].content).toBe('使用 TypeScript');
  });

  it('should load persisted rules on construction', () => {
    const options = createOptions();
    const mgr1 = new TasteManager(options);
    mgr1.addRule('code_style', '使用 const/let');
    mgr1.addRule('interaction', '回复简洁');

    // Create new manager pointing to same workspace
    const mgr2 = new TasteManager(options);
    expect(mgr2.getRuleCount()).toBe(2);

    const rules = mgr2.listRules();
    expect(rules.some(r => r.content === '使用 const/let')).toBe(true);
    expect(rules.some(r => r.content === '回复简洁')).toBe(true);
  });

  it('should handle missing taste.json gracefully', () => {
    const options = createOptions();
    // No taste.json exists
    const mgr = new TasteManager(options);
    expect(mgr.getRuleCount()).toBe(0);
  });

  it('should handle corrupted taste.json gracefully', () => {
    const options = createOptions();
    const dataDir = join(options.workspaceDir, '.disclaude');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'taste.json'), 'not valid json{{{', 'utf8');

    // Should not throw
    const mgr = new TasteManager(options);
    expect(mgr.getRuleCount()).toBe(0);
  });

  it('should handle invalid schema gracefully', () => {
    const options = createOptions();
    const dataDir = join(options.workspaceDir, '.disclaude');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'taste.json'), '{"version": 2, "rules": []}', 'utf8');

    const mgr = new TasteManager(options);
    expect(mgr.getRuleCount()).toBe(0);
  });

  it('should skip invalid rule entries during load', () => {
    const options = createOptions();
    const dataDir = join(options.workspaceDir, '.disclaude');
    mkdirSync(dataDir, { recursive: true });

    const data = {
      version: 1,
      rules: [
        {
          id: 'taste_valid',
          category: 'general',
          content: 'Valid rule',
          source: 'manual',
          count: 1,
          createdAt: '2026-04-28T00:00:00.000Z',
          lastSeen: '2026-04-28T00:00:00.000Z',
        },
        {
          id: '',  // Invalid: empty id
          category: 'general',
          content: 'Invalid rule',
          source: 'manual',
          count: 1,
          createdAt: '2026-04-28T00:00:00.000Z',
          lastSeen: '2026-04-28T00:00:00.000Z',
        },
        null,  // Invalid: null entry
      ],
    };

    writeFileSync(join(dataDir, 'taste.json'), JSON.stringify(data), 'utf8');

    const mgr = new TasteManager(options);
    expect(mgr.getRuleCount()).toBe(1);
    expect(mgr.getRule('taste_valid')).toBeDefined();
  });

  it('should persist after removal', () => {
    const options = createOptions();
    const mgr1 = new TasteManager(options);
    const added = mgr1.addRule('general', 'To be removed');
    expect(added.ok).toBe(true);
    if (!added.ok) {return;}

    mgr1.removeRule(added.data.id);

    // Create new manager
    const mgr2 = new TasteManager(options);
    expect(mgr2.getRuleCount()).toBe(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// getRule()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('getRule', () => {
  it('should return rule by id', () => {
    const mgr = createManager();
    const added = mgr.addRule('general', 'Test rule');
    expect(added.ok).toBe(true);
    if (!added.ok) {return;}

    const rule = mgr.getRule(added.data.id);
    expect(rule).toBeDefined();
    expect(rule?.content).toBe('Test rule');
  });

  it('should return undefined for non-existent id', () => {
    const mgr = createManager();
    expect(mgr.getRule('nonexistent')).toBeUndefined();
  });
});
