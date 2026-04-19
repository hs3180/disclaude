/**
 * Unit tests for TasteManager — per-project user taste management.
 *
 * Tests cover:
 * - Load/save with YAML persistence
 * - Add/remove/list rules
 * - Duplicate detection
 * - Category validation
 * - Context string building for prompt injection
 * - Edge cases (empty data, invalid YAML, limits)
 *
 * @see Issue #2335 (auto-summarize user taste to avoid repeated corrections)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
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
  const storageDir = createTempDir();
  return {
    storageDir,
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('TasteManager', () => {
  describe('load()', () => {
    it('should start with empty data when no file exists', () => {
      const mgr = new TasteManager(createOptions());
      const result = mgr.load();
      expect(result.ok).toBe(true);
      expect(mgr.list()).toHaveLength(0);
    });

    it('should load existing taste data from YAML', () => {
      const opts = createOptions();
      const yaml = `
taste:
  code_style:
    - rule: "使用 const/let"
      category: code_style
      source: manual
      addedAt: "2026-04-19T00:00:00.000Z"
`;
      writeFileSync(join(opts.storageDir, 'taste.yaml'), yaml, 'utf8');

      const mgr = new TasteManager(opts);
      const result = mgr.load();
      expect(result.ok).toBe(true);
      expect(mgr.list()).toHaveLength(1);
      expect(mgr.list()[0].rule).toBe('使用 const/let');
    });

    it('should handle invalid YAML gracefully', () => {
      const opts = createOptions();
      writeFileSync(join(opts.storageDir, 'taste.yaml'), '{{invalid yaml:::', 'utf8');

      const mgr = new TasteManager(opts);
      const result = mgr.load();
      expect(result.ok).toBe(false);
      expect(mgr.list()).toHaveLength(0);
    });
  });

  describe('add()', () => {
    it('should add a rule successfully', () => {
      const mgr = new TasteManager(createOptions());
      mgr.load();

      const result = mgr.add('使用 const/let，禁止 var', 'code_style');
      expect(result.ok).toBe(true);
      expect(result.data!.rule).toBe('使用 const/let，禁止 var');
      expect(result.data!.category).toBe('code_style');
      expect(result.data!.source).toBe('manual');
    });

    it('should persist the rule to YAML', () => {
      const opts = createOptions();
      const mgr = new TasteManager(opts);
      mgr.load();
      mgr.add('优先 TypeScript', 'technical');

      // Verify file exists and contains the rule
      const tastePath = join(opts.storageDir, 'taste.yaml');
      expect(existsSync(tastePath)).toBe(true);
      const content = readFileSync(tastePath, 'utf8');
      expect(content).toContain('优先 TypeScript');
    });

    it('should reject empty rule', () => {
      const mgr = new TasteManager(createOptions());
      mgr.load();
      const result = mgr.add('', 'code_style');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('不能为空');
    });

    it('should reject whitespace-only rule', () => {
      const mgr = new TasteManager(createOptions());
      mgr.load();
      const result = mgr.add('   ', 'code_style');
      expect(result.ok).toBe(false);
    });

    it('should reject invalid category', () => {
      const mgr = new TasteManager(createOptions());
      mgr.load();
      const result = mgr.add('some rule', 'invalid_category' as any);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('无效类别');
    });

    it('should reject duplicates', () => {
      const mgr = new TasteManager(createOptions());
      mgr.load();
      mgr.add('test rule', 'code_style');
      const result = mgr.add('test rule', 'code_style');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('已存在');
    });

    it('should allow same rule in different categories', () => {
      const mgr = new TasteManager(createOptions());
      mgr.load();
      const r1 = mgr.add('test rule', 'code_style');
      const r2 = mgr.add('test rule', 'custom');
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
    });

    it('should trim rule text', () => {
      const mgr = new TasteManager(createOptions());
      mgr.load();
      const result = mgr.add('  trimmed rule  ', 'interaction');
      expect(result.ok).toBe(true);
      expect(result.data!.rule).toBe('trimmed rule');
    });
  });

  describe('remove()', () => {
    it('should remove an existing rule', () => {
      const mgr = new TasteManager(createOptions());
      mgr.load();
      mgr.add('rule to remove', 'code_style');
      expect(mgr.list()).toHaveLength(1);

      const result = mgr.remove('rule to remove', 'code_style');
      expect(result.ok).toBe(true);
      expect(mgr.list()).toHaveLength(0);
    });

    it('should fail for non-existent rule', () => {
      const mgr = new TasteManager(createOptions());
      mgr.load();
      mgr.add('existing rule', 'code_style');
      const result = mgr.remove('non-existent', 'code_style');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('未找到');
    });

    it('should fail for empty category', () => {
      const mgr = new TasteManager(createOptions());
      mgr.load();
      const result = mgr.remove('some rule', 'interaction');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('没有规则');
    });
  });

  describe('list()', () => {
    it('should return all rules across categories', () => {
      const mgr = new TasteManager(createOptions());
      mgr.load();
      mgr.add('rule 1', 'code_style');
      mgr.add('rule 2', 'interaction');
      mgr.add('rule 3', 'technical');

      const all = mgr.list();
      expect(all).toHaveLength(3);
    });

    it('should filter by category', () => {
      const mgr = new TasteManager(createOptions());
      mgr.load();
      mgr.add('rule 1', 'code_style');
      mgr.add('rule 2', 'interaction');
      mgr.add('rule 3', 'code_style');

      const codeRules = mgr.list('code_style');
      expect(codeRules).toHaveLength(2);
    });

    it('should return empty array for category with no rules', () => {
      const mgr = new TasteManager(createOptions());
      mgr.load();
      expect(mgr.list('custom')).toHaveLength(0);
    });
  });

  describe('clear()', () => {
    it('should clear all rules', () => {
      const mgr = new TasteManager(createOptions());
      mgr.load();
      mgr.add('rule 1', 'code_style');
      mgr.add('rule 2', 'interaction');

      const result = mgr.clear();
      expect(result.ok).toBe(true);
      expect(mgr.list()).toHaveLength(0);
    });

    it('should clear a specific category', () => {
      const mgr = new TasteManager(createOptions());
      mgr.load();
      mgr.add('rule 1', 'code_style');
      mgr.add('rule 2', 'interaction');

      const result = mgr.clear('code_style');
      expect(result.ok).toBe(true);
      expect(mgr.list('code_style')).toHaveLength(0);
      expect(mgr.list('interaction')).toHaveLength(1);
    });

    it('should fail for already-empty category', () => {
      const mgr = new TasteManager(createOptions());
      mgr.load();
      const result = mgr.clear('custom');
      expect(result.ok).toBe(false);
    });
  });

  describe('buildContextString()', () => {
    it('should return empty string when no rules exist', () => {
      const mgr = new TasteManager(createOptions());
      mgr.load();
      expect(mgr.buildContextString()).toBe('');
    });

    it('should format rules with category labels', () => {
      const mgr = new TasteManager(createOptions());
      mgr.load();
      mgr.add('使用 const/let', 'code_style');
      mgr.add('回复要简洁', 'interaction');

      const ctx = mgr.buildContextString();
      expect(ctx).toContain('[Project Taste');
      expect(ctx).toContain('代码风格');
      expect(ctx).toContain('交互偏好');
      expect(ctx).toContain('使用 const/let');
      expect(ctx).toContain('回复要简洁');
    });

    it('should include auto-detection tags', () => {
      const mgr = new TasteManager(createOptions());
      mgr.load();
      mgr.add('test rule', 'code_style', 'auto');

      const ctx = mgr.buildContextString();
      expect(ctx).toContain('自动检测');
    });
  });

  describe('persistence roundtrip', () => {
    it('should persist and reload data correctly', () => {
      const opts = createOptions();

      // First instance: add rules
      const mgr1 = new TasteManager(opts);
      mgr1.load();
      mgr1.add('rule one', 'code_style');
      mgr1.add('rule two', 'interaction');

      // Second instance: load and verify
      const mgr2 = new TasteManager(opts);
      mgr2.load();
      const all = mgr2.list();
      expect(all).toHaveLength(2);
      expect(all.some(r => r.rule === 'rule one')).toBe(true);
      expect(all.some(r => r.rule === 'rule two')).toBe(true);
    });
  });
});
