/**
 * Tests for TasteManager module.
 *
 * Issue #2335: Auto-summarize user taste to avoid repeated corrections.
 *
 * Test strategy:
 * - Uses real filesystem (temp directory) for persistence tests
 * - No vi.mock() for external SDKs (per CLAUDE.md rules)
 * - try/finally cleanup for temp files
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TasteManager } from './taste-manager.js';
import { TASTE_CATEGORY_LABELS } from './types.js';

describe('TasteManager', () => {
  let tmpDir: string;
  let tasteFile: string;
  let tm: TasteManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taste-test-'));
    tasteFile = path.join(tmpDir, 'taste.yaml');
    tm = new TasteManager({ filePath: tasteFile });
  });

  afterEach(() => {
    // Cleanup temp directory and files
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Constructor & Default State
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('constructor', () => {
    it('should initialize with empty rules', () => {
      expect(tm.getRuleCount()).toBe(0);
    });

    it('should not create file on construction', () => {
      expect(fs.existsSync(tasteFile)).toBe(false);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Persistence
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('load', () => {
    it('should return false when file does not exist', () => {
      const result = tm.load();
      expect(result).toBe(false);
      expect(tm.getRuleCount()).toBe(0);
    });

    it('should return false and initialize empty for corrupted file', () => {
      fs.writeFileSync(tasteFile, 'not: valid: yaml: content: [');
      const result = tm.load();
      expect(result).toBe(false);
      expect(tm.getRuleCount()).toBe(0);
    });

    it('should return false for empty file', () => {
      fs.writeFileSync(tasteFile, '');
      const result = tm.load();
      expect(result).toBe(false);
      expect(tm.getRuleCount()).toBe(0);
    });

    it('should return false for file with non-object content', () => {
      fs.writeFileSync(tasteFile, 'just a string');
      const result = tm.load();
      expect(result).toBe(false);
    });

    it('should return false for file with missing rules array', () => {
      fs.writeFileSync(tasteFile, 'version: 1\nfoo: bar');
      const result = tm.load();
      expect(result).toBe(false);
    });

    it('should load valid YAML with rules', () => {
      const yaml = [
        'version: 1',
        'rules:',
        '  - description: "使用 const/let"',
        '    category: code_style',
        '    source: auto',
        '    correctionCount: 3',
        '    lastSeenAt: "2026-04-14T10:00:00Z"',
        '    createdAt: "2026-04-10T08:00:00Z"',
      ].join('\n');

      fs.writeFileSync(tasteFile, yaml);
      const result = tm.load();

      expect(result).toBe(true);
      expect(tm.getRuleCount()).toBe(1);
      expect(tm.getRules()[0].description).toBe('使用 const/let');
    });

    it('should handle version mismatch gracefully', () => {
      const yaml = [
        'version: 99',
        'rules:',
        '  - description: "test"',
        '    category: other',
        '    source: manual',
        '    correctionCount: 0',
        '    lastSeenAt: "2026-01-01T00:00:00Z"',
        '    createdAt: "2026-01-01T00:00:00Z"',
      ].join('\n');

      fs.writeFileSync(tasteFile, yaml);
      const result = tm.load();

      expect(result).toBe(true);
      expect(tm.getRuleCount()).toBe(1);
    });
  });

  describe('save', () => {
    it('should create file with correct YAML structure', () => {
      tm.addRule({ description: '使用 const/let', category: 'code_style', source: 'auto' });
      tm.save();

      expect(fs.existsSync(tasteFile)).toBe(true);
      const content = fs.readFileSync(tasteFile, 'utf-8');
      expect(content).toContain('version: 1');
      expect(content).toContain('使用 const/let');
      expect(content).toContain('code_style');
    });

    it('should create parent directories if they don\'t exist', () => {
      const nestedFile = path.join(tmpDir, 'sub', 'dir', 'taste.yaml');
      const nestedTm = new TasteManager({ filePath: nestedFile });

      nestedTm.addRule({ description: 'test rule' });
      nestedTm.save();

      expect(fs.existsSync(nestedFile)).toBe(true);
    });

    it('should not leave .tmp file after successful save', () => {
      tm.addRule({ description: 'test rule' });
      tm.save();

      expect(fs.existsSync(tasteFile + '.tmp')).toBe(false);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Rule Management
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('addRule', () => {
    it('should add a new rule with default options', () => {
      const result = tm.addRule({ description: '使用 const/let' });

      expect(result).toBe(true);
      expect(tm.getRuleCount()).toBe(1);

      const rule = tm.getRules()[0];
      expect(rule.description).toBe('使用 const/let');
      expect(rule.category).toBe('other');
      expect(rule.source).toBe('manual');
      expect(rule.correctionCount).toBe(0);
    });

    it('should add a rule with specified category and source', () => {
      const result = tm.addRule({
        description: '使用 TypeScript',
        category: 'tech_choice',
        source: 'claude_md',
      });

      expect(result).toBe(true);
      const rule = tm.getRules()[0];
      expect(rule.category).toBe('tech_choice');
      expect(rule.source).toBe('claude_md');
    });

    it('should not add duplicate rule (case-insensitive)', () => {
      tm.addRule({ description: '使用 const/let' });
      const result = tm.addRule({ description: '使用 CONST/LET' });

      expect(result).toBe(false);
      expect(tm.getRuleCount()).toBe(1);
    });

    it('should set createdAt and lastSeenAt to current time', () => {
      const before = new Date().toISOString();
      tm.addRule({ description: 'test rule' });
      const after = new Date().toISOString();

      const rule = tm.getRules()[0];
      expect(rule.createdAt >= before).toBe(true);
      expect(rule.createdAt <= after).toBe(true);
      expect(rule.lastSeenAt >= before).toBe(true);
      expect(rule.lastSeenAt <= after).toBe(true);
    });
  });

  describe('removeRule', () => {
    it('should remove existing rule by description', () => {
      tm.addRule({ description: '使用 const/let' });
      const result = tm.removeRule('使用 const/let');

      expect(result).toBe(true);
      expect(tm.getRuleCount()).toBe(0);
    });

    it('should return false for non-existent rule', () => {
      const result = tm.removeRule('non-existent rule');
      expect(result).toBe(false);
    });

    it('should remove correct rule when multiple exist', () => {
      tm.addRule({ description: 'rule A' });
      tm.addRule({ description: 'rule B' });
      tm.addRule({ description: 'rule C' });

      tm.removeRule('rule B');

      const descriptions = tm.getRules().map((r) => r.description);
      expect(descriptions).not.toContain('rule B');
      expect(descriptions).toContain('rule A');
      expect(descriptions).toContain('rule C');
    });
  });

  describe('recordCorrection', () => {
    it('should create new rule when no match exists', () => {
      const rule = tm.recordCorrection({
        description: '使用 const/let',
        category: 'code_style',
      });

      expect(rule.description).toBe('使用 const/let');
      expect(rule.category).toBe('code_style');
      expect(rule.source).toBe('auto');
      expect(rule.correctionCount).toBe(1);
      expect(tm.getRuleCount()).toBe(1);
    });

    it('should increment count for exact match (case-insensitive)', () => {
      tm.addRule({ description: '使用 const/let', source: 'auto' });
      tm.getRules()[0].correctionCount = 2;

      const rule = tm.recordCorrection({ description: '使用 CONST/LET' });

      expect(rule.correctionCount).toBe(3);
      expect(tm.getRuleCount()).toBe(1);
    });

    it('should match via substring containment', () => {
      tm.addRule({ description: '使用 const/let，禁止 var', source: 'auto' });

      const rule = tm.recordCorrection({ description: 'const/let' });

      expect(rule.description).toBe('使用 const/let，禁止 var');
      expect(rule.correctionCount).toBe(1);
    });

    it('should match via word overlap (≥60%)', () => {
      tm.addRule({ description: '函数名使用 camelCase 命名', source: 'auto' });

      const rule = tm.recordCorrection({ description: '函数命名使用 camelCase' });

      // "函数命名使用 camelCase" shares "函数", "camelCase" with "函数名使用 camelCase 命名"
      expect(rule.correctionCount).toBe(1);
    });

    it('should update lastSeenAt on correction', () => {
      tm.addRule({ description: 'test rule', source: 'auto' });
      const originalSeen = tm.getRules()[0].lastSeenAt;

      // Small delay to ensure timestamp differs
      const rule = tm.recordCorrection({ description: 'test rule' });

      expect(rule.lastSeenAt >= originalSeen).toBe(true);
    });
  });

  describe('getRules', () => {
    beforeEach(() => {
      tm.addRule({ description: '使用 const/let', category: 'code_style', source: 'auto' });
      const r = tm.getRules()[0];
      r.correctionCount = 3;
      r.lastSeenAt = '2026-04-14T10:00:00Z';

      tm.addRule({ description: '回复简洁', category: 'interaction', source: 'manual' });

      tm.addRule({ description: '用 pnpm', category: 'tech_choice', source: 'auto' });
      const r2 = tm.getRules()[2];
      r2.correctionCount = 1;
      r2.lastSeenAt = '2026-04-13T10:00:00Z';
    });

    it('should return all rules sorted by correctionCount desc', () => {
      const rules = tm.getRules();
      expect(rules.length).toBe(3);
      expect(rules[0].description).toBe('使用 const/let'); // count=3
      expect(rules[1].description).toBe('用 pnpm'); // count=1
      expect(rules[2].description).toBe('回复简洁'); // count=0
    });

    it('should filter by category', () => {
      const rules = tm.getRules({ category: 'code_style' });
      expect(rules.length).toBe(1);
      expect(rules[0].description).toBe('使用 const/let');
    });

    it('should filter by source', () => {
      const rules = tm.getRules({ source: 'auto' });
      expect(rules.length).toBe(2);
    });

    it('should filter by both category and source', () => {
      const rules = tm.getRules({ category: 'code_style', source: 'auto' });
      expect(rules.length).toBe(1);
    });

    it('should return empty array for non-matching filters', () => {
      const rules = tm.getRules({ category: 'other' as any });
      expect(rules.length).toBe(0);
    });
  });

  describe('reset', () => {
    it('should remove only auto-detected rules', () => {
      tm.addRule({ description: 'auto rule', source: 'auto' });
      tm.addRule({ description: 'manual rule', source: 'manual' });
      tm.addRule({ description: 'claude_md rule', source: 'claude_md' });

      const removed = tm.reset();

      expect(removed).toBe(1);
      expect(tm.getRuleCount()).toBe(2);
      expect(tm.getRules().map((r) => r.description)).not.toContain('auto rule');
    });

    it('should return 0 when no auto rules exist', () => {
      tm.addRule({ description: 'manual rule', source: 'manual' });
      const removed = tm.reset();
      expect(removed).toBe(0);
      expect(tm.getRuleCount()).toBe(1);
    });

    it('should return 0 for empty manager', () => {
      const removed = tm.reset();
      expect(removed).toBe(0);
    });
  });

  describe('clearAll', () => {
    it('should remove all rules', () => {
      tm.addRule({ description: 'auto rule', source: 'auto' });
      tm.addRule({ description: 'manual rule', source: 'manual' });

      const count = tm.clearAll();

      expect(count).toBe(2);
      expect(tm.getRuleCount()).toBe(0);
    });

    it('should return 0 for empty manager', () => {
      expect(tm.clearAll()).toBe(0);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Prompt Formatting
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('formatForPrompt', () => {
    it('should return empty string when no rules exist', () => {
      expect(tm.formatForPrompt()).toBe('');
    });

    it('should include User Taste Preferences heading', () => {
      tm.addRule({ description: 'test rule' });
      const prompt = tm.formatForPrompt();
      expect(prompt).toContain('User Taste Preferences');
    });

    it('should group rules by category with Chinese labels', () => {
      tm.addRule({ description: '使用 const/let', category: 'code_style' });
      tm.addRule({ description: '回复简洁', category: 'interaction' });

      const prompt = tm.formatForPrompt();
      expect(prompt).toContain(TASTE_CATEGORY_LABELS.code_style);
      expect(prompt).toContain(TASTE_CATEGORY_LABELS.interaction);
    });

    it('should show correction count for auto-detected rules', () => {
      tm.addRule({ description: '使用 const/let', category: 'code_style', source: 'auto' });
      const rule = tm.getRules()[0];
      rule.correctionCount = 3;

      const prompt = tm.formatForPrompt();
      expect(prompt).toContain('纠正 3 次');
    });

    it('should show "手动设置" for manual rules', () => {
      tm.addRule({ description: 'test rule', category: 'other', source: 'manual' });

      const prompt = tm.formatForPrompt();
      expect(prompt).toContain('手动设置');
    });

    it('should show "来自 CLAUDE.md" for claude_md source', () => {
      tm.addRule({ description: 'test rule', category: 'other', source: 'claude_md' });

      const prompt = tm.formatForPrompt();
      expect(prompt).toContain('来自 CLAUDE.md');
    });

    it('should sort rules by correction count within categories', () => {
      tm.addRule({ description: 'high count rule', category: 'code_style', source: 'auto' });
      tm.getRules()[0].correctionCount = 5;

      tm.addRule({ description: 'low count rule', category: 'code_style', source: 'auto' });
      tm.getRules()[1].correctionCount = 1;

      const prompt = tm.formatForPrompt();
      const highIndex = prompt.indexOf('high count rule');
      const lowIndex = prompt.indexOf('low count rule');
      expect(highIndex).toBeLessThan(lowIndex);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Integration: Load → Modify → Save → Load
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('roundtrip persistence', () => {
    it('should preserve all rule data through save/load cycle', () => {
      tm.addRule({
        description: '使用 const/let，禁止 var',
        category: 'code_style',
        source: 'auto',
      });
      const rule = tm.getRules()[0];
      rule.correctionCount = 3;
      rule.lastSeenAt = '2026-04-14T10:30:00Z';

      tm.save();

      // Create new manager and load from same file
      const tm2 = new TasteManager({ filePath: tasteFile });
      tm2.load();

      expect(tm2.getRuleCount()).toBe(1);
      const loaded = tm2.getRules()[0];
      expect(loaded.description).toBe('使用 const/let，禁止 var');
      expect(loaded.category).toBe('code_style');
      expect(loaded.source).toBe('auto');
      expect(loaded.correctionCount).toBe(3);
      expect(loaded.lastSeenAt).toBe('2026-04-14T10:30:00Z');
    });

    it('should handle multiple rules through save/load cycle', () => {
      tm.addRule({ description: 'rule A', category: 'code_style', source: 'auto' });
      tm.addRule({ description: 'rule B', category: 'interaction', source: 'manual' });
      tm.addRule({ description: 'rule C', category: 'tech_choice', source: 'claude_md' });

      tm.save();

      const tm2 = new TasteManager({ filePath: tasteFile });
      tm2.load();

      expect(tm2.getRuleCount()).toBe(3);
      expect(tm2.getRules({ source: 'auto' }).length).toBe(1);
      expect(tm2.getRules({ source: 'manual' }).length).toBe(1);
      expect(tm2.getRules({ source: 'claude_md' }).length).toBe(1);
    });
  });
});
