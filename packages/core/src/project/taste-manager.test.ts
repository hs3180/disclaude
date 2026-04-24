/**
 * Unit tests for TasteManager — user taste (preference) persistence and management.
 *
 * Tests cover:
 * - Adding taste rules with input validation
 * - Updating and deleting rules
 * - Listing rules with sorting
 * - Reset (clear) all rules for a project
 * - Taste prompt generation for Agent context injection
 * - Reinforcement (auto-detection) logic
 * - Persistence (atomic write, load, restore, corruption handling)
 * - Edge cases (duplicate content, limits, special characters)
 *
 * @see Issue #2335
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
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

function createOptions(): TasteManagerOptions {
  const workspaceDir = createTempDir();
  return { workspaceDir };
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
// Constructor
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager constructor', () => {
  it('should construct with valid options', () => {
    const tm = new TasteManager(createOptions());
    expect(tm.getTasteDir()).toContain('.disclaude/taste');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// addRule()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager addRule()', () => {
  let tm: TasteManager;
  let opts: TasteManagerOptions;

  beforeEach(() => {
    opts = createOptions();
    tm = new TasteManager(opts);
  });

  it('should add a rule with default source and correctionCount', () => {
    const result = tm.addRule('default', {
      category: 'code_style',
      content: '使用 const/let，禁止 var',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.content).toBe('使用 const/let，禁止 var');
      expect(result.data.category).toBe('code_style');
      expect(result.data.source).toBe('manual');
      expect(result.data.correctionCount).toBe(1);
      expect(result.data.id).toMatch(/^t_/);
      expect(result.data.createdAt).toBeTruthy();
      expect(result.data.lastSeen).toBeTruthy();
    }
  });

  it('should add a rule with explicit source and correctionCount', () => {
    const result = tm.addRule('default', {
      category: 'interaction',
      content: '回复简洁',
      source: 'auto',
      correctionCount: 3,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe('auto');
      expect(result.data.correctionCount).toBe(3);
    }
  });

  it('should trim content whitespace', () => {
    const result = tm.addRule('default', {
      category: 'code_style',
      content: '  使用 TypeScript  ',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.content).toBe('使用 TypeScript');
    }
  });

  it('should persist to disk', () => {
    tm.addRule('default', {
      category: 'code_style',
      content: '使用 const/let',
    });

    const filePath = tm.getTasteFilePath('default');
    expect(existsSync(filePath)).toBe(true);

    const raw = readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    expect(data.rules).toHaveLength(1);
    expect(data.projectName).toBe('default');
  });

  it('should reject empty content', () => {
    const result = tm.addRule('default', {
      category: 'code_style',
      content: '',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不能为空');
    }
  });

  it('should reject whitespace-only content', () => {
    const result = tm.addRule('default', {
      category: 'code_style',
      content: '   ',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不能为空');
    }
  });

  it('should reject content exceeding max length', () => {
    const result = tm.addRule('default', {
      category: 'code_style',
      content: 'x'.repeat(513),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('512');
    }
  });

  it('should reject duplicate content', () => {
    tm.addRule('default', {
      category: 'code_style',
      content: '使用 TypeScript',
    });

    const result = tm.addRule('default', {
      category: 'tech_preference',
      content: '使用 TypeScript',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('已存在');
    }
  });

  it('should reject empty project name', () => {
    const result = tm.addRule('', {
      category: 'code_style',
      content: 'test',
    });

    expect(result.ok).toBe(false);
  });

  it('should reject path traversal in project name', () => {
    const result = tm.addRule('..', {
      category: 'code_style',
      content: 'test',
    });

    expect(result.ok).toBe(false);
  });

  it('should allow adding rules for different projects independently', () => {
    const r1 = tm.addRule('project-a', {
      category: 'code_style',
      content: '规则 A',
    });
    const r2 = tm.addRule('project-b', {
      category: 'code_style',
      content: '规则 B',
    });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const listA = tm.listRules('project-a');
    const listB = tm.listRules('project-b');
    expect(listA.ok && listA.data).toHaveLength(1);
    expect(listB.ok && listB.data).toHaveLength(1);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// updateRule()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager updateRule()', () => {
  let tm: TasteManager;

  beforeEach(() => {
    tm = new TasteManager(createOptions());
  });

  it('should update content of existing rule', () => {
    const added = tm.addRule('default', {
      category: 'code_style',
      content: '旧规则',
    });
    expect(added.ok).toBe(true);

    const ruleId = added.ok ? added.data.id : '';
    const result = tm.updateRule('default', ruleId, {
      content: '新规则',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.content).toBe('新规则');
    }
  });

  it('should update category and correctionCount', () => {
    const added = tm.addRule('default', {
      category: 'code_style',
      content: 'test rule',
    });
    const ruleId = added.ok ? added.data.id : '';

    const result = tm.updateRule('default', ruleId, {
      category: 'tech_preference',
      correctionCount: 5,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.category).toBe('tech_preference');
      expect(result.data.correctionCount).toBe(5);
    }
  });

  it('should update lastSeen timestamp', () => {
    const added = tm.addRule('default', {
      category: 'code_style',
      content: 'test rule',
    });
    const ruleId = added.ok ? added.data.id : '';
    const originalLastSeen = added.ok ? added.data.lastSeen : '';

    const result = tm.updateRule('default', ruleId, { content: 'updated' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Both are ISO strings; lastSeen should be >= original
      expect(result.data.lastSeen >= originalLastSeen).toBe(true);
    }
  });

  it('should reject update for non-existent rule', () => {
    const result = tm.updateRule('default', 'nonexistent', {
      content: 'test',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不存在');
    }
  });

  it('should reject update with empty content', () => {
    const added = tm.addRule('default', {
      category: 'code_style',
      content: 'test',
    });
    const ruleId = added.ok ? added.data.id : '';

    const result = tm.updateRule('default', ruleId, {
      content: '',
    });

    expect(result.ok).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// deleteRule()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager deleteRule()', () => {
  let tm: TasteManager;

  beforeEach(() => {
    tm = new TasteManager(createOptions());
  });

  it('should delete an existing rule', () => {
    const added = tm.addRule('default', {
      category: 'code_style',
      content: 'to delete',
    });
    const ruleId = added.ok ? added.data.id : '';

    const result = tm.deleteRule('default', ruleId);
    expect(result.ok).toBe(true);

    const list = tm.listRules('default');
    expect(list.ok && list.data).toHaveLength(0);
  });

  it('should delete file when last rule is removed', () => {
    const added = tm.addRule('default', {
      category: 'code_style',
      content: 'only rule',
    });
    const ruleId = added.ok ? added.data.id : '';

    tm.deleteRule('default', ruleId);

    const filePath = tm.getTasteFilePath('default');
    expect(existsSync(filePath)).toBe(false);
  });

  it('should reject delete for non-existent rule', () => {
    const result = tm.deleteRule('default', 'nonexistent');
    expect(result.ok).toBe(false);
  });

  it('should not affect other rules when deleting one', () => {
    tm.addRule('default', {
      category: 'code_style',
      content: 'rule 1',
    });
    const added2 = tm.addRule('default', {
      category: 'interaction',
      content: 'rule 2',
    });

    tm.deleteRule('default', added2.ok ? added2.data.id : '');

    const list = tm.listRules('default');
    expect(list.ok && list.data).toHaveLength(1);
    expect(list.ok && list.data[0].content).toBe('rule 1');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// listRules()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager listRules()', () => {
  let tm: TasteManager;

  beforeEach(() => {
    tm = new TasteManager(createOptions());
  });

  it('should return empty array for project with no rules', () => {
    const result = tm.listRules('default');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([]);
    }
  });

  it('should return rules sorted by category then correctionCount', () => {
    tm.addRule('default', {
      category: 'interaction',
      content: '简洁',
      correctionCount: 2,
    });
    tm.addRule('default', {
      category: 'code_style',
      content: 'TypeScript',
      correctionCount: 5,
    });
    tm.addRule('default', {
      category: 'code_style',
      content: 'camelCase',
      correctionCount: 3,
    });

    const result = tm.listRules('default');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(3);
      // code_style before interaction
      expect(result.data[0].category).toBe('code_style');
      expect(result.data[0].content).toBe('TypeScript'); // higher count first
      expect(result.data[1].category).toBe('code_style');
      expect(result.data[1].content).toBe('camelCase');
      expect(result.data[2].category).toBe('interaction');
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// resetTaste()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager resetTaste()', () => {
  it('should clear all rules and return deleted count', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule('default', { category: 'code_style', content: 'rule 1' });
    tm.addRule('default', { category: 'interaction', content: 'rule 2' });

    const result = tm.resetTaste('default');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe(2);
    }

    // File should be deleted
    expect(existsSync(tm.getTasteFilePath('default'))).toBe(false);

    // No rules should remain
    const list = tm.listRules('default');
    expect(list.ok && list.data).toHaveLength(0);
  });

  it('should return 0 for project with no rules', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.resetTaste('default');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe(0);
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// getTastePrompt()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager getTastePrompt()', () => {
  it('should return empty string for project with no rules', () => {
    const tm = new TasteManager(createOptions());
    expect(tm.getTastePrompt('default')).toBe('');
  });

  it('should generate formatted prompt with categories', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule('default', {
      category: 'code_style',
      content: '使用 const/let，禁止 var',
      correctionCount: 3,
    });
    tm.addRule('default', {
      category: 'interaction',
      content: '回复简洁，先结论后分析',
      correctionCount: 2,
    });

    const prompt = tm.getTastePrompt('default');

    expect(prompt).toContain('[Project Taste');
    expect(prompt).toContain('代码风格');
    expect(prompt).toContain('const/let');
    expect(prompt).toContain('交互偏好');
    expect(prompt).toContain('回复简洁');
    expect(prompt).toContain('重要'); // 3+ corrections → "重要"
  });

  it('should show source hint for claude_md rules', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule('default', {
      category: 'code_style',
      content: 'Always use const',
      source: 'claude_md',
    });

    const prompt = tm.getTastePrompt('default');
    expect(prompt).toContain('CLAUDE.md');
  });

  it('should group rules by category', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule('default', { category: 'code_style', content: 'rule 1' });
    tm.addRule('default', { category: 'interaction', content: 'rule 2' });
    tm.addRule('default', { category: 'code_style', content: 'rule 3' });

    const prompt = tm.getTastePrompt('default');
    const codeStyleIdx = prompt.indexOf('代码风格');
    const interactionIdx = prompt.indexOf('交互偏好');
    expect(codeStyleIdx).toBeGreaterThan(-1);
    expect(interactionIdx).toBeGreaterThan(-1);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// reinforceOrAdd()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager reinforceOrAdd()', () => {
  let tm: TasteManager;

  beforeEach(() => {
    tm = new TasteManager(createOptions());
  });

  it('should add new rule when no match exists', () => {
    const result = tm.reinforceOrAdd('default', 'code_style', '使用 TypeScript');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe('auto');
      expect(result.data.correctionCount).toBe(1);
    }
  });

  it('should increment correction count for exact match', () => {
    tm.addRule('default', {
      category: 'code_style',
      content: '使用 TypeScript',
      correctionCount: 2,
    });

    const result = tm.reinforceOrAdd('default', 'code_style', '使用 TypeScript');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.correctionCount).toBe(3);
    }
  });

  it('should match case-insensitive and normalized whitespace', () => {
    tm.addRule('default', {
      category: 'code_style',
      content: '使用 TypeScript',
    });

    const result = tm.reinforceOrAdd('default', 'code_style', '使用  typescript');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.correctionCount).toBe(2);
      expect(result.data.content).toBe('使用 TypeScript'); // Keep original
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Persistence
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager persistence', () => {
  it('should persist and reload data correctly', () => {
    const opts = createOptions();
    const { workspaceDir } = opts;

    // Create TM1, add data
    const tm1 = new TasteManager(opts);
    tm1.addRule('default', {
      category: 'code_style',
      content: '使用 const/let',
    });

    // Create TM2 from same workspace — should load persisted state
    const tm2 = new TasteManager({ workspaceDir });
    const list = tm2.listRules('default');
    expect(list.ok && list.data).toHaveLength(1);
    expect(list.ok && list.data[0].content).toBe('使用 const/let');
  });

  it('should handle corrupted JSON gracefully', () => {
    const opts = createOptions();
    const { workspaceDir } = opts;

    // Write corrupted data
    const tasteDir = join(workspaceDir, '.disclaude', 'taste');
    mkdirSync(tasteDir, { recursive: true });
    writeFileSync(join(tasteDir, 'default.json'), '{ invalid json }', 'utf8');

    const tm = new TasteManager(opts);
    const list = tm.listRules('default');
    expect(list.ok && list.data).toEqual([]);
  });

  it('should handle invalid schema gracefully', () => {
    const opts = createOptions();
    const { workspaceDir } = opts;

    const tasteDir = join(workspaceDir, '.disclaude', 'taste');
    mkdirSync(tasteDir, { recursive: true });
    writeFileSync(join(tasteDir, 'default.json'), JSON.stringify({
      // Missing projectName and rules
      updatedAt: '2026-01-01',
    }), 'utf8');

    const tm = new TasteManager(opts);
    const list = tm.listRules('default');
    expect(list.ok && list.data).toEqual([]);
  });

  it('should handle null file content gracefully', () => {
    const opts = createOptions();
    const { workspaceDir } = opts;

    const tasteDir = join(workspaceDir, '.disclaude', 'taste');
    mkdirSync(tasteDir, { recursive: true });
    writeFileSync(join(tasteDir, 'default.json'), 'null', 'utf8');

    const tm = new TasteManager(opts);
    const list = tm.listRules('default');
    expect(list.ok && list.data).toEqual([]);
  });

  it('should survive full lifecycle: add → persist → reload → mutate → persist → reload', () => {
    const opts = createOptions();
    const { workspaceDir } = opts;

    // Phase 1: Add rules
    const tm1 = new TasteManager(opts);
    tm1.addRule('default', { category: 'code_style', content: 'rule 1' });
    tm1.addRule('default', { category: 'interaction', content: 'rule 2' });

    // Phase 2: Reload and verify
    const tm2 = new TasteManager({ workspaceDir });
    let list = tm2.listRules('default');
    expect(list.ok && list.data).toHaveLength(2);

    // Phase 3: Mutate — delete one rule
    const rules = list.ok ? list.data : [];
    tm2.deleteRule('default', rules[0].id);

    // Phase 4: Reload and verify
    const tm3 = new TasteManager({ workspaceDir });
    list = tm3.listRules('default');
    expect(list.ok && list.data).toHaveLength(1);
  });

  it('should not leave .tmp files after successful persist', () => {
    const opts = createOptions();
    const tm = new TasteManager(opts);
    tm.addRule('default', { category: 'code_style', content: 'test' });

    const tasteDir = join(opts.workspaceDir, '.disclaude', 'taste');
    const tmpFiles = existsSync(tasteDir)
      ? readdirSync(tasteDir).filter(f => f.endsWith('.tmp'))
      : [];
    expect(tmpFiles).toHaveLength(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Query Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager query helpers', () => {
  it('hasTaste() should return false for empty project', () => {
    const tm = new TasteManager(createOptions());
    expect(tm.hasTaste('default')).toBe(false);
  });

  it('hasTaste() should return true for project with rules', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule('default', { category: 'code_style', content: 'test' });
    expect(tm.hasTaste('default')).toBe(true);
  });

  it('getRuleCount() should return correct count', () => {
    const tm = new TasteManager(createOptions());
    expect(tm.getRuleCount('default')).toBe(0);
    tm.addRule('default', { category: 'code_style', content: 'rule 1' });
    expect(tm.getRuleCount('default')).toBe(1);
    tm.addRule('default', { category: 'interaction', content: 'rule 2' });
    expect(tm.getRuleCount('default')).toBe(2);
  });

  it('getRule() should return specific rule by ID', () => {
    const tm = new TasteManager(createOptions());
    const added = tm.addRule('default', { category: 'code_style', content: 'test' });

    const result = tm.getRule('default', added.ok ? added.data.id : '');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.content).toBe('test');
    }
  });

  it('getRule() should reject for non-existent ID', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.getRule('default', 'nonexistent');
    expect(result.ok).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Edge Cases
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager edge cases', () => {
  it('should handle Unicode content in rules', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.addRule('default', {
      category: 'project_norm',
      content: 'コミットメッセージは日本語で書く',
    });
    expect(result.ok).toBe(true);
  });

  it('should handle project names with hyphens and underscores', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.addRule('my-project_v2', {
      category: 'code_style',
      content: 'test',
    });
    expect(result.ok).toBe(true);
  });

  it('should handle content at exactly max length', () => {
    const tm = new TasteManager(createOptions());
    const content = 'a'.repeat(512);
    const result = tm.addRule('default', {
      category: 'code_style',
      content,
    });
    expect(result.ok).toBe(true);
  });

  it('should reject project name with forward slash', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.addRule('foo/bar', {
      category: 'code_style',
      content: 'test',
    });
    expect(result.ok).toBe(false);
  });

  it('should maintain isolation between projects', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule('project-a', { category: 'code_style', content: 'rule A' });
    tm.addRule('project-b', { category: 'code_style', content: 'rule B' });

    tm.resetTaste('project-a');

    expect(tm.hasTaste('project-a')).toBe(false);
    expect(tm.hasTaste('project-b')).toBe(true);
    expect(tm.getRuleCount('project-b')).toBe(1);
  });
});
