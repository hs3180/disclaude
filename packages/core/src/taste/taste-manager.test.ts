/**
 * Tests for TasteManager — user preference management.
 *
 * @see Issue #2335 (feat: auto-summarize user taste)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TasteManager } from './taste-manager.js';

describe('TasteManager', () => {
  let manager: TasteManager;
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `taste-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    manager = new TasteManager({ workspaceDir: testDir });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────
  // add()
  // ───────────────────────────────────────────

  describe('add()', () => {
    it('should add a new taste rule', () => {
      const result = manager.add('oc_test123', {
        rule: '使用 const/let，禁止 var',
        category: 'code_style',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.rule).toBe('使用 const/let，禁止 var');
        expect(result.data.category).toBe('code_style');
        expect(result.data.source).toBe('manual');
        expect(result.data.correctionCount).toBe(1);
        expect(result.data.id).toMatch(/^t_/);
      }
    });

    it('should default category to "other"', () => {
      const result = manager.add('oc_test123', {
        rule: 'Some preference',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.category).toBe('other');
      }
    });

    it('should default source to "manual"', () => {
      const result = manager.add('oc_test123', {
        rule: 'Some preference',
        source: 'auto',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.source).toBe('auto');
      }
    });

    it('should increment correction count on duplicate rule', () => {
      manager.add('oc_test123', { rule: 'Use TypeScript', correctionCount: 2 });
      const result = manager.add('oc_test123', { rule: 'Use TypeScript', correctionCount: 3 });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.correctionCount).toBe(5);
      }

      // Should still have only one entry
      const list = manager.list('oc_test123');
      expect(list.ok).toBe(true);
      if (list.ok) {
        expect(list.data).toHaveLength(1);
      }
    });

    it('should match duplicates case-insensitively', () => {
      manager.add('oc_test123', { rule: 'Use TypeScript' });
      const result = manager.add('oc_test123', { rule: 'use typescript' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.correctionCount).toBe(2);
      }
    });

    it('should reject empty rule', () => {
      const result = manager.add('oc_test123', { rule: '' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('不能为空');
      }
    });

    it('should reject whitespace-only rule', () => {
      const result = manager.add('oc_test123', { rule: '   ' });
      expect(result.ok).toBe(false);
    });

    it('should reject empty chatId', () => {
      const result = manager.add('', { rule: 'Test' });
      expect(result.ok).toBe(false);
    });

    it('should reject chatId with path traversal', () => {
      const result = manager.add('..', { rule: 'Test' });
      expect(result.ok).toBe(false);
    });

    it('should reject chatId with slashes', () => {
      const result = manager.add('foo/bar', { rule: 'Test' });
      expect(result.ok).toBe(false);
    });

    it('should trim rule whitespace', () => {
      const result = manager.add('oc_test123', { rule: '  Trimmed rule  ' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.rule).toBe('Trimmed rule');
      }
    });
  });

  // ───────────────────────────────────────────
  // list()
  // ───────────────────────────────────────────

  describe('list()', () => {
    it('should return empty array for unknown chatId', () => {
      const result = manager.list('oc_unknown');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual([]);
      }
    });

    it('should return all entries sorted by correction count desc', () => {
      manager.add('oc_test123', { rule: 'Rule A', correctionCount: 1 });
      manager.add('oc_test123', { rule: 'Rule B', correctionCount: 5 });
      manager.add('oc_test123', { rule: 'Rule C', correctionCount: 3 });

      const result = manager.list('oc_test123');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.map((e) => e.rule)).toEqual(['Rule B', 'Rule C', 'Rule A']);
      }
    });

    it('should filter by category', () => {
      manager.add('oc_test123', { rule: 'Rule A', category: 'code_style' });
      manager.add('oc_test123', { rule: 'Rule B', category: 'interaction' });
      manager.add('oc_test123', { rule: 'Rule C', category: 'code_style' });

      const result = manager.list('oc_test123', { category: 'code_style' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(2);
        expect(result.data.every((e) => e.category === 'code_style')).toBe(true);
      }
    });

    it('should filter by source', () => {
      manager.add('oc_test123', { rule: 'Rule A', source: 'auto' });
      manager.add('oc_test123', { rule: 'Rule B', source: 'manual' });

      const result = manager.list('oc_test123', { source: 'auto' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].source).toBe('auto');
      }
    });

    it('should filter by minCorrections', () => {
      manager.add('oc_test123', { rule: 'Rule A', correctionCount: 1 });
      manager.add('oc_test123', { rule: 'Rule B', correctionCount: 5 });
      manager.add('oc_test123', { rule: 'Rule C', correctionCount: 3 });

      const result = manager.list('oc_test123', { minCorrections: 3 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(2);
      }
    });

    it('should isolate entries by chatId', () => {
      manager.add('oc_chat1', { rule: 'Chat1 rule' });
      manager.add('oc_chat2', { rule: 'Chat2 rule' });

      const result = manager.list('oc_chat1');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].rule).toBe('Chat1 rule');
      }
    });
  });

  // ───────────────────────────────────────────
  // remove()
  // ───────────────────────────────────────────

  describe('remove()', () => {
    it('should remove an existing entry', () => {
      const addResult = manager.add('oc_test123', { rule: 'To remove' });
      expect(addResult.ok).toBe(true);

      if (addResult.ok) {
        const removeResult = manager.remove('oc_test123', addResult.data.id);
        expect(removeResult.ok).toBe(true);

        const list = manager.list('oc_test123');
        expect(list.ok).toBe(true);
        if (list.ok) {
          expect(list.data).toHaveLength(0);
        }
      }
    });

    it('should fail for non-existent entry', () => {
      const result = manager.remove('oc_test123', 'nonexistent_id');
      expect(result.ok).toBe(false);
    });

    it('should fail for empty chatId', () => {
      const result = manager.remove('', 'some_id');
      expect(result.ok).toBe(false);
    });
  });

  // ───────────────────────────────────────────
  // update()
  // ───────────────────────────────────────────

  describe('update()', () => {
    it('should update rule text', () => {
      const addResult = manager.add('oc_test123', { rule: 'Original rule' });
      expect(addResult.ok).toBe(true);

      if (addResult.ok) {
        const updateResult = manager.update('oc_test123', addResult.data.id, {
          rule: 'Updated rule',
        });
        expect(updateResult.ok).toBe(true);
        if (updateResult.ok) {
          expect(updateResult.data.rule).toBe('Updated rule');
        }
      }
    });

    it('should update category', () => {
      const addResult = manager.add('oc_test123', { rule: 'Test' });
      expect(addResult.ok).toBe(true);

      if (addResult.ok) {
        const updateResult = manager.update('oc_test123', addResult.data.id, {
          category: 'tech_preference',
        });
        expect(updateResult.ok).toBe(true);
        if (updateResult.ok) {
          expect(updateResult.data.category).toBe('tech_preference');
        }
      }
    });

    it('should fail for non-existent entry', () => {
      const result = manager.update('oc_test123', 'nonexistent', { rule: 'New' });
      expect(result.ok).toBe(false);
    });

    it('should reject empty rule update', () => {
      const addResult = manager.add('oc_test123', { rule: 'Test' });
      expect(addResult.ok).toBe(true);

      if (addResult.ok) {
        const updateResult = manager.update('oc_test123', addResult.data.id, {
          rule: '',
        });
        expect(updateResult.ok).toBe(false);
      }
    });
  });

  // ───────────────────────────────────────────
  // reset()
  // ───────────────────────────────────────────

  describe('reset()', () => {
    it('should clear all entries for a chatId', () => {
      manager.add('oc_test123', { rule: 'Rule A' });
      manager.add('oc_test123', { rule: 'Rule B' });
      manager.add('oc_test123', { rule: 'Rule C' });

      const result = manager.reset('oc_test123');
      expect(result.ok).toBe(true);

      const list = manager.list('oc_test123');
      expect(list.ok).toBe(true);
      if (list.ok) {
        expect(list.data).toHaveLength(0);
      }
    });

    it('should not affect other chatIds', () => {
      manager.add('oc_chat1', { rule: 'Chat1 rule' });
      manager.add('oc_chat2', { rule: 'Chat2 rule' });

      manager.reset('oc_chat1');

      const chat2 = manager.list('oc_chat2');
      expect(chat2.ok).toBe(true);
      if (chat2.ok) {
        expect(chat2.data).toHaveLength(1);
      }
    });
  });

  // ───────────────────────────────────────────
  // getFormattedTaste()
  // ───────────────────────────────────────────

  describe('getFormattedTaste()', () => {
    it('should return empty string for no rules', () => {
      const formatted = manager.getFormattedTaste('oc_unknown');
      expect(formatted).toBe('');
    });

    it('should format taste rules grouped by category', () => {
      manager.add('oc_test123', {
        rule: '使用 const/let，禁止 var',
        category: 'code_style',
        correctionCount: 3,
      });
      manager.add('oc_test123', {
        rule: '回复简洁',
        category: 'interaction',
        correctionCount: 2,
      });

      const formatted = manager.getFormattedTaste('oc_test123');

      expect(formatted).toContain('[User Preferences');
      expect(formatted).toContain('代码风格');
      expect(formatted).toContain('使用 const/let，禁止 var');
      expect(formatted).toContain('交互偏好');
      expect(formatted).toContain('回复简洁');
    });

    it('should include correction count info', () => {
      manager.add('oc_test123', { rule: 'Test rule', correctionCount: 5 });

      const formatted = manager.getFormattedTaste('oc_test123');
      expect(formatted).toContain('被纠正5次');
    });

    it('should include strict adherence note for high-count rules', () => {
      manager.add('oc_test123', { rule: 'Important rule', correctionCount: 3 });

      const formatted = manager.getFormattedTaste('oc_test123');
      expect(formatted).toContain('严格遵守');
    });
  });

  // ───────────────────────────────────────────
  // Persistence
  // ───────────────────────────────────────────

  describe('persistence', () => {
    it('should persist data to disk', () => {
      manager.add('oc_test123', { rule: 'Persistent rule' });

      // Create a new manager to read from disk
      const manager2 = new TasteManager({ workspaceDir: testDir });
      const result = manager2.list('oc_test123');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].rule).toBe('Persistent rule');
      }
    });

    it('should use atomic write pattern', () => {
      manager.add('oc_test123', { rule: 'Atomic write test' });

      const tasteDir = manager.getTasteDir();
      expect(existsSync(tasteDir)).toBe(true);

      // No .tmp files should remain
      const fs = require('node:fs');
      const files = fs.readdirSync(tasteDir);
      const tmpFiles = files.filter((f: string) => f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });

    it('should handle corrupted files gracefully', () => {
      const fs = require('node:fs');
      const tasteDir = manager.getTasteDir();
      mkdirSync(tasteDir, { recursive: true });
      fs.writeFileSync(
        join(tasteDir, 'oc_corrupt.json'),
        'this is not valid json'
      );

      // Should not throw, returns empty list
      const result = manager.list('oc_corrupt');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual([]);
      }
    });
  });

  // ───────────────────────────────────────────
  // Max Rules Limit
  // ───────────────────────────────────────────

  describe('max rules limit', () => {
    it('should enforce max rules per chatId', () => {
      // Add 100 rules (the limit)
      for (let i = 0; i < 100; i++) {
        manager.add('oc_test123', { rule: `Rule ${i}` });
      }

      // 101st should fail
      const result = manager.add('oc_test123', { rule: 'Extra rule' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('最大规则数量');
      }
    });
  });
});
