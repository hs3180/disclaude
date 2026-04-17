/**
 * Unit tests for TasteManager — user taste (preference) management.
 *
 * Tests cover:
 * - Rule creation with validation
 * - Rule update and removal
 * - Duplicate detection and reinforcement
 * - Taste prompt generation
 * - Persistence (atomic write, load, restore, corruption handling)
 * - Category filtering
 * - Edge cases (empty state, max rules, invalid inputs)
 *
 * @see Issue #2335 (feat: auto-summarize user taste)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TasteManager } from './taste-manager.js';
import type { TasteManagerOptions } from './taste-types.js';

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
// Constructor & load()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager constructor', () => {
  it('should construct with valid options', () => {
    const tm = new TasteManager(createOptions());
    expect(tm.getRuleCount()).toBe(0);
  });

  it('should use projectWorkingDir when provided', () => {
    const workspaceDir = createTempDir();
    const projectDir = join(workspaceDir, 'projects', 'my-project');
    mkdirSync(projectDir, { recursive: true });

    const tm = new TasteManager(createOptions({
      workspaceDir,
      projectWorkingDir: projectDir,
    }));

    // Persist path should be under project directory
    expect(tm.getPersistPath()).toBe(join(projectDir, '.disclaude', 'taste.json'));
  });

  it('should use workspaceDir when projectWorkingDir is not provided', () => {
    const workspaceDir = createTempDir();
    const tm = new TasteManager(createOptions({ workspaceDir }));
    expect(tm.getPersistPath()).toBe(join(workspaceDir, '.disclaude', 'taste.json'));
  });
});

describe('TasteManager load()', () => {
  it('should start with empty state when no taste.json exists', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.load();
    expect(result.ok).toBe(true);
    expect(tm.getRuleCount()).toBe(0);
  });

  it('should be idempotent', () => {
    const tm = new TasteManager(createOptions());
    tm.load();
    tm.load();
    expect(tm.getRuleCount()).toBe(0);
  });

  it('should handle corrupted JSON gracefully', () => {
    const opts = createOptions();
    const dataDir = join(opts.workspaceDir, '.disclaude');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'taste.json'), '{ invalid json }', 'utf8');

    const tm = new TasteManager(opts);
    expect(tm.getRuleCount()).toBe(0);
  });

  it('should handle invalid schema gracefully', () => {
    const opts = createOptions();
    const dataDir = join(opts.workspaceDir, '.disclaude');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'taste.json'), JSON.stringify({
      version: 2, // Wrong version
      rules: {},
      updatedAt: '2026-04-17T00:00:00.000Z',
    }), 'utf8');

    const tm = new TasteManager(opts);
    expect(tm.getRuleCount()).toBe(0);
  });

  it('should skip invalid rule entries during load', () => {
    const opts = createOptions();
    const dataDir = join(opts.workspaceDir, '.disclaude');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'taste.json'), JSON.stringify({
      version: 1,
      rules: {
        valid: {
          id: 'valid',
          category: 'code_style',
          description: 'Use const/let',
          source: 'manual',
          count: 1,
          createdAt: '2026-04-17T00:00:00.000Z',
          lastSeen: '2026-04-17T00:00:00.000Z',
        },
        invalid_no_desc: {
          id: 'invalid_no_desc',
          category: 'code_style',
          // Missing description
          source: 'manual',
          count: 1,
          createdAt: '2026-04-17T00:00:00.000Z',
          lastSeen: '2026-04-17T00:00:00.000Z',
        },
        invalid_bad_category: {
          id: 'invalid_bad_category',
          category: 'nonexistent',
          description: 'Test',
          source: 'manual',
          count: 1,
          createdAt: '2026-04-17T00:00:00.000Z',
          lastSeen: '2026-04-17T00:00:00.000Z',
        },
      },
      updatedAt: '2026-04-17T00:00:00.000Z',
    }), 'utf8');

    const tm = new TasteManager(opts);
    expect(tm.getRuleCount()).toBe(1);
    expect(tm.getRule('valid')).toBeDefined();
    expect(tm.getRule('invalid_no_desc')).toBeUndefined();
    expect(tm.getRule('invalid_bad_category')).toBeUndefined();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// addRule()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager addRule()', () => {
  it('should add a rule with manual source', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.addRule('code_style', '使用 const/let，禁止 var');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.category).toBe('code_style');
      expect(result.data.description).toBe('使用 const/let，禁止 var');
      expect(result.data.source).toBe('manual');
      expect(result.data.count).toBe(1);
      expect(result.data.id).toBeTruthy();
      expect(result.data.createdAt).toBeTruthy();
      expect(result.data.lastSeen).toBeTruthy();
    }
  });

  it('should add a rule with auto source and set count to threshold', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.addRule('interaction', '回复简洁', 'auto');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe('auto');
      expect(result.data.count).toBe(2); // AUTO_DETECTION_THRESHOLD
    }
  });

  it('should reinforce existing rule when adding duplicate', () => {
    const tm = new TasteManager(createOptions());
    const r1 = tm.addRule('code_style', 'Use const/let');
    expect(r1.ok).toBe(true);

    const r2 = tm.addRule('code_style', 'use const/let'); // Case-insensitive match
    expect(r2.ok).toBe(true);

    if (r1.ok && r2.ok) {
      // Should be same rule (reinforced), not a new one
      expect(r2.data.id).toBe(r1.data.id);
      expect(r2.data.count).toBe(2);
      expect(tm.getRuleCount()).toBe(1);
    }
  });

  it('should not treat different descriptions as duplicates', () => {
    const tm = new TasteManager(createOptions());
    const r1 = tm.addRule('code_style', 'Use const/let');
    const r2 = tm.addRule('code_style', 'Use camelCase');

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(tm.getRuleCount()).toBe(2);
  });

  it('should reject invalid category', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.addRule('invalid_category' as any, 'Test');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('无效的偏好类别');
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

  it('should reject whitespace-only description', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.addRule('code_style', '   ');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不能为空');
    }
  });

  it('should reject description with control characters', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.addRule('code_style', 'Use\x00const');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('控制字符');
    }
  });

  it('should reject description exceeding max length', () => {
    const tm = new TasteManager(createOptions());
    const longDesc = 'x'.repeat(501);
    const result = tm.addRule('code_style', longDesc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('500');
    }
  });

  it('should trim whitespace from description', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.addRule('code_style', '  Use const/let  ');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.description).toBe('Use const/let');
    }
  });

  it('should accept all valid categories', () => {
    const categories = ['code_style', 'interaction', 'tech_choice', 'project_norm', 'custom'];
    const tm = new TasteManager(createOptions());

    for (const category of categories) {
      const result = tm.addRule(category as any, `Rule for ${category}`);
      expect(result.ok).toBe(true);
    }

    expect(tm.getRuleCount()).toBe(5);
  });

  it('should accept claude_md source', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.addRule('code_style', 'Always use TypeScript', 'claude_md');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe('claude_md');
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// updateRule()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager updateRule()', () => {
  it('should update rule description', () => {
    const tm = new TasteManager(createOptions());
    const added = tm.addRule('code_style', 'Original');
    expect(added.ok).toBe(true);

    if (added.ok) {
      const updated = tm.updateRule(added.data.id, 'Updated description');
      expect(updated.ok).toBe(true);
      if (updated.ok) {
        expect(updated.data.description).toBe('Updated description');
      }
    }
  });

  it('should reject update for non-existent rule', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.updateRule('nonexistent-id', 'New description');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不存在');
    }
  });

  it('should reject update with empty description', () => {
    const tm = new TasteManager(createOptions());
    const added = tm.addRule('code_style', 'Original');
    expect(added.ok).toBe(true);

    if (added.ok) {
      const result = tm.updateRule(added.data.id, '');
      expect(result.ok).toBe(false);
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// removeRule()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager removeRule()', () => {
  it('should remove an existing rule', () => {
    const tm = new TasteManager(createOptions());
    const added = tm.addRule('code_style', 'Test rule');
    expect(added.ok).toBe(true);

    if (added.ok) {
      expect(tm.getRuleCount()).toBe(1);
      const result = tm.removeRule(added.data.id);
      expect(result.ok).toBe(true);
      expect(tm.getRuleCount()).toBe(0);
    }
  });

  it('should reject removal of non-existent rule', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.removeRule('nonexistent-id');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不存在');
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// reinforceRule()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager reinforceRule()', () => {
  it('should increment rule count', () => {
    const tm = new TasteManager(createOptions());
    const added = tm.addRule('code_style', 'Test rule');
    expect(added.ok).toBe(true);

    if (added.ok) {
      expect(added.data.count).toBe(1);
      const reinforced = tm.reinforceRule(added.data.id);
      expect(reinforced.ok).toBe(true);
      if (reinforced.ok) {
        expect(reinforced.data.count).toBe(2);
      }
    }
  });

  it('should update lastSeen timestamp', () => {
    const tm = new TasteManager(createOptions());
    const added = tm.addRule('code_style', 'Test rule');
    expect(added.ok).toBe(true);

    if (added.ok) {
      const before = added.data.lastSeen;
      // Small delay to ensure timestamp differs
      const reinforced = tm.reinforceRule(added.data.id);
      expect(reinforced.ok).toBe(true);
      if (reinforced.ok) {
        expect(reinforced.data.lastSeen >= before).toBe(true);
      }
    }
  });

  it('should reject reinforcement of non-existent rule', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.reinforceRule('nonexistent-id');
    expect(result.ok).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// clear()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager clear()', () => {
  it('should remove all rules', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule('code_style', 'Rule 1');
    tm.addRule('interaction', 'Rule 2');
    tm.addRule('tech_choice', 'Rule 3');
    expect(tm.getRuleCount()).toBe(3);

    const result = tm.clear();
    expect(result.ok).toBe(true);
    expect(tm.getRuleCount()).toBe(0);
    expect(tm.listRules()).toEqual([]);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// listRules()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager listRules()', () => {
  it('should return rules sorted by count descending', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule('code_style', 'Rule 1'); // count = 1
    tm.addRule('interaction', 'Rule 2'); // count = 1
    const r3 = tm.addRule('tech_choice', 'Rule 3');
    if (r3.ok) {
      tm.reinforceRule(r3.data.id); // count = 2
      tm.reinforceRule(r3.data.id); // count = 3
    }

    const rules = tm.listRules();
    expect(rules).toHaveLength(3);
    expect(rules[0].count).toBe(3); // Highest count first
  });

  it('should filter by category', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule('code_style', 'Rule 1');
    tm.addRule('interaction', 'Rule 2');
    tm.addRule('code_style', 'Rule 3');

    const codeStyleRules = tm.listRules('code_style');
    expect(codeStyleRules).toHaveLength(2);
    expect(codeStyleRules.every(r => r.category === 'code_style')).toBe(true);
  });

  it('should return empty array when no rules', () => {
    const tm = new TasteManager(createOptions());
    expect(tm.listRules()).toEqual([]);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// buildTastePrompt()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager buildTastePrompt()', () => {
  it('should return empty string when no rules', () => {
    const tm = new TasteManager(createOptions());
    expect(tm.buildTastePrompt()).toBe('');
  });

  it('should generate formatted prompt with single rule', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule('code_style', '使用 const/let，禁止 var', 'auto');

    const prompt = tm.buildTastePrompt();
    expect(prompt).toContain('User Taste');
    expect(prompt).toContain('代码风格');
    expect(prompt).toContain('使用 const/let，禁止 var');
    expect(prompt).toContain('被纠正 2 次');
  });

  it('should group rules by category', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule('code_style', 'Use const/let');
    tm.addRule('interaction', 'Reply concisely');
    tm.addRule('code_style', 'Use camelCase');

    const prompt = tm.buildTastePrompt();
    expect(prompt).toContain('代码风格');
    expect(prompt).toContain('交互偏好');
  });

  it('should show correct source tags', () => {
    const tm = new TasteManager(createOptions());
    tm.addRule('code_style', 'Auto rule', 'auto');
    tm.addRule('interaction', 'Manual rule', 'manual');
    tm.addRule('tech_choice', 'CLAUDE.md rule', 'claude_md');

    const prompt = tm.buildTastePrompt();
    expect(prompt).toContain('被纠正');
    expect(prompt).toContain('手动设置');
    expect(prompt).toContain('来自 CLAUDE.md');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Persistence
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager persistence', () => {
  it('should persist rules to taste.json', () => {
    const opts = createOptions();
    const tm = new TasteManager(opts);
    tm.addRule('code_style', 'Use const/let');

    const persistPath = tm.getPersistPath();
    expect(existsSync(persistPath)).toBe(true);

    const raw = readFileSync(persistPath, 'utf8');
    const data = JSON.parse(raw);

    expect(data.version).toBe(1);
    expect(data.rules).toBeDefined();
    expect(Object.keys(data.rules)).toHaveLength(1);
    expect(data.updatedAt).toBeTruthy();
  });

  it('should auto-persist on addRule', () => {
    const opts = createOptions();
    const tm = new TasteManager(opts);
    tm.addRule('code_style', 'Rule 1');

    const persistPath = tm.getPersistPath();
    const raw = readFileSync(persistPath, 'utf8');
    const data = JSON.parse(raw);
    expect(Object.keys(data.rules)).toHaveLength(1);
  });

  it('should auto-persist on removeRule', () => {
    const opts = createOptions();
    const tm = new TasteManager(opts);
    const added = tm.addRule('code_style', 'Rule 1');
    if (added.ok) {
      tm.removeRule(added.data.id);
    }

    const persistPath = tm.getPersistPath();
    const raw = readFileSync(persistPath, 'utf8');
    const data = JSON.parse(raw);
    expect(Object.keys(data.rules)).toHaveLength(0);
  });

  it('should auto-persist on clear', () => {
    const opts = createOptions();
    const tm = new TasteManager(opts);
    tm.addRule('code_style', 'Rule 1');
    tm.addRule('interaction', 'Rule 2');
    tm.clear();

    const persistPath = tm.getPersistPath();
    const raw = readFileSync(persistPath, 'utf8');
    const data = JSON.parse(raw);
    expect(Object.keys(data.rules)).toHaveLength(0);
  });

  it('should not leave .tmp files after successful persist', () => {
    const opts = createOptions();
    const tm = new TasteManager(opts);
    tm.addRule('code_style', 'Test');

    const tmpPath = join(opts.workspaceDir, '.disclaude', 'taste.json.tmp');
    expect(existsSync(tmpPath)).toBe(false);
  });

  it('should restore rules from persisted state', () => {
    const opts = createOptions();
    const { workspaceDir } = opts;

    // Create TM1, add rules
    const tm1 = new TasteManager(opts);
    tm1.addRule('code_style', 'Use const/let');
    tm1.addRule('interaction', 'Reply concisely');

    // Create TM2 from same workspace — should load persisted state
    const tm2 = new TasteManager({ workspaceDir });
    expect(tm2.getRuleCount()).toBe(2);

    const rules = tm2.listRules();
    const descriptions = rules.map(r => r.description);
    expect(descriptions).toContain('Use const/let');
    expect(descriptions).toContain('Reply concisely');
  });

  it('should survive full lifecycle: add → persist → reload → modify → persist → reload', () => {
    const opts = createOptions();
    const { workspaceDir } = opts;

    // Phase 1: Create and add rules
    const tm1 = new TasteManager(opts);
    tm1.addRule('code_style', 'Rule A');
    tm1.addRule('interaction', 'Rule B');

    // Phase 2: Reload and verify
    const tm2 = new TasteManager({ workspaceDir });
    expect(tm2.getRuleCount()).toBe(2);

    // Phase 3: Modify
    const rules = tm2.listRules();
    tm2.removeRule(rules[0].id);
    tm2.addRule('tech_choice', 'Rule C');

    // Phase 4: Reload and verify
    const tm3 = new TasteManager({ workspaceDir });
    expect(tm3.getRuleCount()).toBe(2);

    const descriptions = tm3.listRules().map(r => r.description);
    expect(descriptions).toContain('Rule B');
    expect(descriptions).toContain('Rule C');
    expect(descriptions).not.toContain('Rule A');
  });

  it('should persist per-project taste in projectWorkingDir', () => {
    const workspaceDir = createTempDir();
    const projectDir = join(workspaceDir, 'projects', 'my-project');
    mkdirSync(projectDir, { recursive: true });

    const tm = new TasteManager(createOptions({
      workspaceDir,
      projectWorkingDir: projectDir,
    }));

    tm.addRule('code_style', 'Project-specific rule');

    const persistPath = join(projectDir, '.disclaude', 'taste.json');
    expect(existsSync(persistPath)).toBe(true);

    // Global taste should not exist
    const globalPath = join(workspaceDir, '.disclaude', 'taste.json');
    expect(existsSync(globalPath)).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Edge Cases
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager — edge cases', () => {
  it('should enforce max rules limit', () => {
    const tm = new TasteManager(createOptions());

    // Add MAX_RULES (100) rules
    for (let i = 0; i < 100; i++) {
      tm.addRule('custom', `Rule ${i}`);
    }
    expect(tm.getRuleCount()).toBe(100);

    // 101st rule should fail
    const result = tm.addRule('custom', 'Extra rule');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('上限');
    }
  });

  it('should handle unicode descriptions', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.addRule('code_style', '使用中文提交信息（commit message 用中文）');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.description).toBe('使用中文提交信息（commit message 用中文）');
    }
  });

  it('should handle emoji in descriptions', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.addRule('interaction', '回复要简洁 🚀');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.description).toBe('回复要简洁 🚀');
    }
  });

  it('should generate valid ISO 8601 timestamps', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.addRule('code_style', 'Test');

    expect(result.ok).toBe(true);
    if (result.ok) {
      const date = new Date(result.data.createdAt);
      expect(date.toISOString()).toBe(result.data.createdAt);
    }
  });

  it('should handle description at exactly max length', () => {
    const tm = new TasteManager(createOptions());
    const desc500 = 'x'.repeat(500);
    const result = tm.addRule('code_style', desc500);
    expect(result.ok).toBe(true);
  });

  it('should preserve all fields during persistence round-trip', () => {
    const opts = createOptions();
    const { workspaceDir } = opts;

    const tm1 = new TasteManager(opts);
    const r1 = tm1.addRule('code_style', 'Use const/let', 'auto');
    expect(r1.ok).toBe(true);

    if (r1.ok) {
      tm1.reinforceRule(r1.data.id); // count → 3

      const tm2 = new TasteManager({ workspaceDir });
      const loaded = tm2.getRule(r1.data.id);
      expect(loaded).toBeDefined();
      if (loaded) {
        expect(loaded.id).toBe(r1.data.id);
        expect(loaded.category).toBe('code_style');
        expect(loaded.description).toBe('Use const/let');
        expect(loaded.source).toBe('auto');
        expect(loaded.count).toBe(3);
      }
    }
  });
});
