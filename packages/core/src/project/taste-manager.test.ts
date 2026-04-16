/**
 * Unit tests for TasteManager — per-project user preference tracking.
 *
 * Tests cover:
 * - Adding taste entries (new and duplicate/reinforce)
 * - Removing entries
 * - Listing entries (with category filter, sorted by count)
 * - Reinforcing existing entries
 * - Clearing all entries for a project
 * - Prompt text generation
 * - Persistence (atomic write, load, restore, corruption handling)
 * - Input validation
 * - Edge cases
 *
 * @see Issue #2335 (auto-summarize user taste to avoid repeated corrections)
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
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

function createOptions(): TasteManagerOptions {
  return { workspaceDir: createTempDir() };
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
    const tm = new TasteManager(createOptions());
    expect(tm).toBeDefined();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// addEntry()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager addEntry()', () => {
  let tm: TasteManager;

  // Use beforeEach pattern inside describe for fresh instances
  function freshManager(): TasteManager {
    return new TasteManager(createOptions());
  }

  it('should add a new taste entry', () => {
    tm = freshManager();
    const result = tm.addEntry('my-project', {
      rule: '使用 const/let，禁止 var',
      category: 'code_style',
      source: 'auto',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.rule).toBe('使用 const/let，禁止 var');
      expect(result.data.category).toBe('code_style');
      expect(result.data.source).toBe('auto');
      expect(result.data.count).toBe(1);
      expect(result.data.lastSeen).toBeTruthy();
    }
  });

  it('should reinforce existing entry when adding duplicate rule', () => {
    tm = freshManager();
    tm.addEntry('my-project', {
      rule: '使用 const/let，禁止 var',
      category: 'code_style',
      source: 'auto',
    });

    const result = tm.addEntry('my-project', {
      rule: '使用 const/let，禁止 var',
      category: 'code_style',
      source: 'auto',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.count).toBe(2);
    }

    // Should have only 1 entry
    const entries = tm.listEntries('my-project');
    expect(entries).toHaveLength(1);
  });

  it('should treat duplicate rules case-insensitively', () => {
    tm = freshManager();
    tm.addEntry('my-project', {
      rule: 'Use TypeScript',
      category: 'technical',
      source: 'manual',
    });

    const result = tm.addEntry('my-project', {
      rule: 'use typescript',
      category: 'technical',
      source: 'auto',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.count).toBe(2);
    }

    expect(tm.listEntries('my-project')).toHaveLength(1);
  });

  it('should trim rule whitespace', () => {
    tm = freshManager();
    const result = tm.addEntry('my-project', {
      rule: '  使用 TypeScript  ',
      category: 'technical',
      source: 'manual',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.rule).toBe('使用 TypeScript');
    }
  });

  it('should support different categories', () => {
    tm = freshManager();
    tm.addEntry('my-project', { rule: 'Rule A', category: 'code_style', source: 'auto' });
    tm.addEntry('my-project', { rule: 'Rule B', category: 'interaction', source: 'manual' });
    tm.addEntry('my-project', { rule: 'Rule C', category: 'technical', source: 'claude_md' });
    tm.addEntry('my-project', { rule: 'Rule D', category: 'project_norms', source: 'auto' });

    const entries = tm.listEntries('my-project');
    expect(entries).toHaveLength(4);
  });

  it('should support custom categories', () => {
    tm = freshManager();
    const result = tm.addEntry('my-project', {
      rule: '部署前运行测试',
      category: 'custom',
      source: 'manual',
      customCategory: '部署规范',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.customCategory).toBe('部署规范');
    }
  });

  it('should reject empty project name', () => {
    tm = freshManager();
    const result = tm.addEntry('', {
      rule: 'Some rule',
      category: 'code_style',
      source: 'auto',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('项目名称');
    }
  });

  it('should reject "default" as project name', () => {
    tm = freshManager();
    const result = tm.addEntry('default', {
      rule: 'Some rule',
      category: 'code_style',
      source: 'auto',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('default');
    }
  });

  it('should reject empty rule', () => {
    tm = freshManager();
    const result = tm.addEntry('my-project', {
      rule: '',
      category: 'code_style',
      source: 'auto',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('规则文本');
    }
  });

  it('should reject whitespace-only rule', () => {
    tm = freshManager();
    const result = tm.addEntry('my-project', {
      rule: '   ',
      category: 'code_style',
      source: 'auto',
    });
    expect(result.ok).toBe(false);
  });

  it('should reject invalid category', () => {
    tm = freshManager();
    const result = tm.addEntry('my-project', {
      rule: 'Some rule',
      category: 'invalid_category' as any,
      source: 'auto',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('类别');
    }
  });

  it('should reject invalid source', () => {
    tm = freshManager();
    const result = tm.addEntry('my-project', {
      rule: 'Some rule',
      category: 'code_style',
      source: 'invalid_source' as any,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('来源');
    }
  });

  it('should reject project name with path traversal', () => {
    tm = freshManager();
    const result = tm.addEntry('../etc', {
      rule: 'Some rule',
      category: 'code_style',
      source: 'auto',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('非法字符');
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// removeEntry()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager removeEntry()', () => {
  let tm: TasteManager;
  let opts: TasteManagerOptions;

  beforeEach(() => {
    opts = createOptions();
    tm = new TasteManager(opts);
    tm.addEntry('my-project', { rule: 'Rule A', category: 'code_style', source: 'auto' });
    tm.addEntry('my-project', { rule: 'Rule B', category: 'code_style', source: 'manual' });
    tm.addEntry('my-project', { rule: 'Rule C', category: 'interaction', source: 'auto' });
  });

  it('should remove an entry by index', () => {
    const result = tm.removeEntry('my-project', 'code_style', 0);
    expect(result.ok).toBe(true);

    const entries = tm.listEntries('my-project', 'code_style');
    expect(entries).toHaveLength(1);
  });

  it('should reject invalid index', () => {
    const result = tm.removeEntry('my-project', 'code_style', 99);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('超出范围');
    }
  });

  it('should reject negative index', () => {
    const result = tm.removeEntry('my-project', 'code_style', -1);
    expect(result.ok).toBe(false);
  });

  it('should reject removal from non-existent project', () => {
    const result = tm.removeEntry('nonexistent', 'code_style', 0);
    expect(result.ok).toBe(false);
  });

  it('should clean up empty category after removal', () => {
    // interaction only has 1 entry
    tm.removeEntry('my-project', 'interaction', 0);

    // interaction category should be gone
    const entries = tm.listEntries('my-project', 'interaction');
    expect(entries).toHaveLength(0);
  });

  it('should clean up empty project after all entries removed', () => {
    tm.removeEntry('my-project', 'code_style', 0);
    tm.removeEntry('my-project', 'code_style', 0);
    tm.removeEntry('my-project', 'interaction', 0);

    expect(tm.listEntries('my-project')).toHaveLength(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// listEntries()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager listEntries()', () => {
  it('should return empty array for project with no entries', () => {
    const tm = new TasteManager(createOptions());
    expect(tm.listEntries('unknown-project')).toEqual([]);
  });

  it('should return all entries sorted by count descending', () => {
    const tm = new TasteManager(createOptions());
    tm.addEntry('p', { rule: 'R1', category: 'code_style', source: 'auto' });
    tm.addEntry('p', { rule: 'R1', category: 'code_style', source: 'auto' }); // reinforce to count=2
    tm.addEntry('p', { rule: 'R2', category: 'interaction', source: 'manual' }); // count=1
    tm.addEntry('p', { rule: 'R3', category: 'technical', source: 'auto' });
    tm.addEntry('p', { rule: 'R3', category: 'technical', source: 'auto' });
    tm.addEntry('p', { rule: 'R3', category: 'technical', source: 'auto' }); // count=3

    const entries = tm.listEntries('p');
    expect(entries).toHaveLength(3);
    expect(entries[0].rule).toBe('R3'); // count=3
    expect(entries[1].rule).toBe('R1'); // count=2
    expect(entries[2].rule).toBe('R2'); // count=1
  });

  it('should filter by category', () => {
    const tm = new TasteManager(createOptions());
    tm.addEntry('p', { rule: 'R1', category: 'code_style', source: 'auto' });
    tm.addEntry('p', { rule: 'R2', category: 'interaction', source: 'manual' });

    const codeStyle = tm.listEntries('p', 'code_style');
    expect(codeStyle).toHaveLength(1);
    expect(codeStyle[0].rule).toBe('R1');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// reinforce()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager reinforce()', () => {
  it('should increment count and update lastSeen', () => {
    const tm = new TasteManager(createOptions());
    tm.addEntry('p', { rule: 'R1', category: 'code_style', source: 'auto' });

    const before = tm.listEntries('p')[0].lastSeen;
    const result = tm.reinforce('p', 'code_style', 0);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.count).toBe(2);
      expect(result.data.lastSeen >= before).toBe(true);
    }
  });

  it('should reject invalid index', () => {
    const tm = new TasteManager(createOptions());
    tm.addEntry('p', { rule: 'R1', category: 'code_style', source: 'auto' });

    const result = tm.reinforce('p', 'code_style', 99);
    expect(result.ok).toBe(false);
  });

  it('should reject non-existent project', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.reinforce('nonexistent', 'code_style', 0);
    expect(result.ok).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// clear()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager clear()', () => {
  it('should remove all entries for a project', () => {
    const tm = new TasteManager(createOptions());
    tm.addEntry('p', { rule: 'R1', category: 'code_style', source: 'auto' });
    tm.addEntry('p', { rule: 'R2', category: 'interaction', source: 'manual' });

    const result = tm.clear('p');
    expect(result.ok).toBe(true);
    expect(tm.listEntries('p')).toHaveLength(0);
  });

  it('should be idempotent for project with no entries', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.clear('p');
    expect(result.ok).toBe(true);
  });

  it('should reject default project', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.clear('default');
    expect(result.ok).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// toPromptText()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager toPromptText()', () => {
  it('should return empty string for project with no entries', () => {
    const tm = new TasteManager(createOptions());
    expect(tm.toPromptText('unknown')).toBe('');
  });

  it('should generate formatted prompt text', () => {
    const tm = new TasteManager(createOptions());
    tm.addEntry('p', { rule: '使用 const/let，禁止 var', category: 'code_style', source: 'auto' });
    tm.addEntry('p', { rule: '使用 const/let，禁止 var', category: 'code_style', source: 'auto' }); // reinforce
    tm.addEntry('p', { rule: '回复简洁，先结论后分析', category: 'interaction', source: 'manual' });

    const text = tm.toPromptText('p');
    expect(text).toContain('[Project Taste');
    expect(text).toContain('使用 const/let，禁止 var');
    expect(text).toContain('被纠正 2 次');
    expect(text).toContain('回复简洁，先结论后分析');
    expect(text).toContain('手动添加');
    expect(text).toContain('代码风格');
    expect(text).toContain('交互偏好');
  });

  it('should include source labels correctly', () => {
    const tm = new TasteManager(createOptions());
    tm.addEntry('p', { rule: 'R1', category: 'code_style', source: 'auto' });
    tm.addEntry('p', { rule: 'R2', category: 'interaction', source: 'claude_md' });
    tm.addEntry('p', { rule: 'R3', category: 'technical', source: 'manual' });

    const text = tm.toPromptText('p');
    expect(text).toContain('被纠正 1 次');
    expect(text).toContain('来自 CLAUDE.md');
    expect(text).toContain('手动添加');
  });

  it('should handle custom category labels', () => {
    const tm = new TasteManager(createOptions());
    tm.addEntry('p', {
      rule: '部署前运行测试',
      category: 'custom',
      source: 'manual',
      customCategory: '部署规范',
    });

    const text = tm.toPromptText('p');
    expect(text).toContain('部署规范');
    expect(text).toContain('部署前运行测试');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Persistence
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager persist()', () => {
  it('should create taste.json on persist', () => {
    const opts = createOptions();
    const tm = new TasteManager(opts);
    tm.addEntry('p', { rule: 'R1', category: 'code_style', source: 'auto' });

    const tastePath = tm.getTastePath('p');
    expect(existsSync(tastePath)).toBe(true);

    const data = JSON.parse(readFileSync(tastePath, 'utf8'));
    expect(data.version).toBe(1);
    expect(data.entries.code_style).toBeDefined();
    expect(data.entries.code_style).toHaveLength(1);
    expect(data.entries.code_style[0].rule).toBe('R1');
  });

  it('should delete taste.json when entries are cleared', () => {
    const opts = createOptions();
    const tm = new TasteManager(opts);
    tm.addEntry('p', { rule: 'R1', category: 'code_style', source: 'auto' });

    const tastePath = tm.getTastePath('p');
    expect(existsSync(tastePath)).toBe(true);

    tm.clear('p');
    expect(existsSync(tastePath)).toBe(false);
  });

  it('should auto-persist on addEntry', () => {
    const opts = createOptions();
    const tm = new TasteManager(opts);

    tm.addEntry('p', { rule: 'R1', category: 'code_style', source: 'auto' });

    // File should exist without explicit persist() call
    const tastePath = tm.getTastePath('p');
    expect(existsSync(tastePath)).toBe(true);
  });

  it('should auto-persist on removeEntry', () => {
    const opts = createOptions();
    const tm = new TasteManager(opts);
    tm.addEntry('p', { rule: 'R1', category: 'code_style', source: 'auto' });
    tm.addEntry('p', { rule: 'R2', category: 'code_style', source: 'auto' });

    tm.removeEntry('p', 'code_style', 0);

    const data = JSON.parse(readFileSync(tm.getTastePath('p'), 'utf8'));
    expect(data.entries.code_style).toHaveLength(1);
  });

  it('should not leave .tmp files after successful persist', () => {
    const opts = createOptions();
    const tm = new TasteManager(opts);
    tm.addEntry('p', { rule: 'R1', category: 'code_style', source: 'auto' });

    const tmpPath = `${tm.getTastePath('p')}.tmp`;
    expect(existsSync(tmpPath)).toBe(false);
  });
});

describe('TasteManager load()', () => {
  it('should restore entries from persisted state', () => {
    const opts = createOptions();

    // TM1: add data
    const tm1 = new TasteManager(opts);
    tm1.addEntry('p', { rule: 'R1', category: 'code_style', source: 'auto' });
    tm1.addEntry('p', { rule: 'R1', category: 'code_style', source: 'auto' }); // count=2
    tm1.addEntry('p', { rule: 'R2', category: 'interaction', source: 'manual' });

    // TM2: load from same workspace
    const tm2 = new TasteManager(opts);
    const loadResult = tm2.load('p');
    expect(loadResult.ok).toBe(true);

    const entries = tm2.listEntries('p');
    expect(entries).toHaveLength(2);

    const r1 = entries.find((e) => e.rule === 'R1');
    expect(r1).toBeDefined();
    expect(r1!.count).toBe(2);

    const r2 = entries.find((e) => e.rule === 'R2');
    expect(r2).toBeDefined();
    expect(r2!.category).toBe('interaction');
  });

  it('should handle first run (no taste.json) gracefully', () => {
    const tm = new TasteManager(createOptions());
    const result = tm.load('p');
    expect(result.ok).toBe(true);
    expect(tm.listEntries('p')).toEqual([]);
  });

  it('should handle corrupted JSON gracefully', () => {
    const opts = createOptions();
    const projectDir = join(opts.workspaceDir, 'projects', 'p');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'taste.json'), '{ invalid json }', 'utf8');

    const tm = new TasteManager(opts);
    const result = tm.load('p');
    expect(result.ok).toBe(false);
    expect(tm.listEntries('p')).toEqual([]);
  });

  it('should skip invalid entry entries', () => {
    const opts = createOptions();
    const projectDir = join(opts.workspaceDir, 'projects', 'p');
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(
      join(projectDir, 'taste.json'),
      JSON.stringify({
        version: 1,
        entries: {
          code_style: [
            {
              rule: 'Valid rule',
              category: 'code_style',
              source: 'auto',
              count: 1,
              lastSeen: '2026-04-16T00:00:00.000Z',
            },
            {
              rule: '', // Invalid: empty rule
              category: 'code_style',
              source: 'auto',
              count: 1,
              lastSeen: '2026-04-16T00:00:00.000Z',
            },
            {
              // Invalid: missing fields
              rule: 'Missing fields',
            },
          ],
        },
      }),
      'utf8',
    );

    const tm = new TasteManager(opts);
    tm.load('p');

    const entries = tm.listEntries('p');
    expect(entries).toHaveLength(1);
    expect(entries[0].rule).toBe('Valid rule');
  });

  it('should handle invalid top-level schema', () => {
    const opts = createOptions();
    const projectDir = join(opts.workspaceDir, 'projects', 'p');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'taste.json'), '[]', 'utf8');

    const tm = new TasteManager(opts);
    const result = tm.load('p');
    expect(result.ok).toBe(false);
  });
});

describe('TasteManager persistence round-trip', () => {
  it('should survive full lifecycle: add → persist → load → mutate → persist → load', () => {
    const opts = createOptions();

    // Phase 1: Add entries
    const tm1 = new TasteManager(opts);
    tm1.addEntry('p', { rule: 'R1', category: 'code_style', source: 'auto' });
    tm1.addEntry('p', { rule: 'R2', category: 'interaction', source: 'manual' });

    // Phase 2: Load and verify
    const tm2 = new TasteManager(opts);
    tm2.load('p');
    expect(tm2.listEntries('p')).toHaveLength(2);

    // Phase 3: Mutate
    tm2.reinforce('p', 'code_style', 0);
    tm2.removeEntry('p', 'interaction', 0);

    // Phase 4: Reload and verify
    const tm3 = new TasteManager(opts);
    tm3.load('p');
    const entries = tm3.listEntries('p');
    expect(entries).toHaveLength(1);
    expect(entries[0].count).toBe(2);
    expect(entries[0].rule).toBe('R1');
  });

  it('should persist prompt text correctly after round-trip', () => {
    const opts = createOptions();

    const tm1 = new TasteManager(opts);
    tm1.addEntry('p', { rule: 'Use TypeScript', category: 'technical', source: 'manual' });

    const tm2 = new TasteManager(opts);
    tm2.load('p');

    const text = tm2.toPromptText('p');
    expect(text).toContain('Use TypeScript');
    expect(text).toContain('技术选择');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Multi-project Isolation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager multi-project isolation', () => {
  it('should isolate taste data between projects', () => {
    const tm = new TasteManager(createOptions());
    tm.addEntry('project-a', { rule: 'Rule for A', category: 'code_style', source: 'auto' });
    tm.addEntry('project-b', { rule: 'Rule for B', category: 'interaction', source: 'manual' });

    expect(tm.listEntries('project-a')).toHaveLength(1);
    expect(tm.listEntries('project-b')).toHaveLength(1);
    expect(tm.listEntries('project-a')[0].rule).toBe('Rule for A');
    expect(tm.listEntries('project-b')[0].rule).toBe('Rule for B');
  });

  it('should not affect other projects when clearing one', () => {
    const tm = new TasteManager(createOptions());
    tm.addEntry('project-a', { rule: 'R1', category: 'code_style', source: 'auto' });
    tm.addEntry('project-b', { rule: 'R2', category: 'code_style', source: 'auto' });

    tm.clear('project-a');
    expect(tm.listEntries('project-a')).toHaveLength(0);
    expect(tm.listEntries('project-b')).toHaveLength(1);
  });
});
