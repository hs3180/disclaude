/**
 * Tests for TasteReader — user preference persistence and formatting.
 *
 * @see Issue #2335
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TasteReader } from './taste-reader.js';
import type { TasteRule } from './types.js';

describe('TasteReader', () => {
  let tempDir: string;
  let reader: TasteReader;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'taste-test-'));
    reader = new TasteReader({ workspaceDir: tempDir });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ───────────────────────────────────────────
  // Read Operations
  // ───────────────────────────────────────────

  describe('read', () => {
    it('should return empty rules when file does not exist', () => {
      const result = reader.read();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.version).toBe(1);
        expect(result.data.rules).toEqual([]);
      }
    });

    it('should read valid taste file', () => {
      const rule: TasteRule = {
        rule: '使用 const/let，禁止 var',
        category: 'code_style',
        source: 'auto',
        count: 3,
        lastSeen: '2026-04-14T00:00:00.000Z',
      };

      const writeResult = reader.write([rule]);
      expect(writeResult.ok).toBe(true);

      const readResult = reader.read();
      expect(readResult.ok).toBe(true);
      if (readResult.ok) {
        expect(readResult.data.rules).toHaveLength(1);
        expect(readResult.data.rules[0].rule).toBe('使用 const/let，禁止 var');
        expect(readResult.data.rules[0].category).toBe('code_style');
      }
    });

    it('should return empty rules for invalid JSON', () => {
      const { mkdirSync, writeFileSync } = require('node:fs');
      mkdirSync(join(tempDir, '.disclaude'), { recursive: true });
      writeFileSync(reader.getPersistPath(), 'not valid json{{{', 'utf8');

      // Should gracefully return empty rules instead of crashing
      const result = reader.read();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.rules).toEqual([]);
      }
    });

    it('should return empty rules for invalid schema', () => {
      const { mkdirSync, writeFileSync } = require('node:fs');
      mkdirSync(join(tempDir, '.disclaude'), { recursive: true });
      writeFileSync(reader.getPersistPath(), JSON.stringify({ version: 2, rules: [] }), 'utf8');

      const result = reader.read();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.rules).toEqual([]);
      }
    });
  });

  // ───────────────────────────────────────────
  // Write Operations
  // ───────────────────────────────────────────

  describe('write', () => {
    it('should write rules to file', () => {
      const rules: TasteRule[] = [
        {
          rule: '回复简洁，先结论后分析',
          category: 'interaction',
          source: 'auto',
          count: 2,
          lastSeen: '2026-04-15T00:00:00.000Z',
        },
      ];

      const result = reader.write(rules);
      expect(result.ok).toBe(true);

      // Verify file exists
      expect(existsSync(reader.getPersistPath())).toBe(true);

      // Verify content
      const content = JSON.parse(readFileSync(reader.getPersistPath(), 'utf8'));
      expect(content.version).toBe(1);
      expect(content.rules).toHaveLength(1);
      expect(content.updatedAt).toBeDefined();
    });

    it('should create .disclaude directory if it does not exist', () => {
      expect(existsSync(join(tempDir, '.disclaude'))).toBe(false);

      const result = reader.write([]);
      expect(result.ok).toBe(true);
      expect(existsSync(join(tempDir, '.disclaude'))).toBe(true);
    });

    it('should truncate to 50 rules max', () => {
      const rules: TasteRule[] = Array.from({ length: 60 }, (_, i) => ({
        rule: `Rule ${i}`,
        category: 'general' as const,
        source: 'auto' as const,
        count: 1,
        lastSeen: `2026-04-${String(20 - (i < 20 ? 19 - i : 0)).padStart(2, '0')}T00:00:00.000Z`,
      }));

      const result = reader.write(rules);
      expect(result.ok).toBe(true);

      const readResult = reader.read();
      expect(readResult.ok).toBe(true);
      if (readResult.ok) {
        expect(readResult.data.rules.length).toBeLessThanOrEqual(50);
      }
    });
  });

  // ───────────────────────────────────────────
  // Clear
  // ───────────────────────────────────────────

  describe('clear', () => {
    it('should remove all rules', () => {
      reader.write([{
        rule: 'test rule',
        category: 'general',
        source: 'manual',
        count: 1,
        lastSeen: '2026-04-14T00:00:00.000Z',
      }]);

      const clearResult = reader.clear();
      expect(clearResult.ok).toBe(true);

      const readResult = reader.read();
      expect(readResult.ok).toBe(true);
      if (readResult.ok) {
        expect(readResult.data.rules).toEqual([]);
      }
    });
  });

  // ───────────────────────────────────────────
  // Prompt Formatting
  // ───────────────────────────────────────────

  describe('formatTasteForPrompt', () => {
    it('should return empty string when no rules exist', () => {
      expect(reader.formatTasteForPrompt()).toBe('');
    });

    it('should format rules grouped by category', () => {
      const rules: TasteRule[] = [
        {
          rule: '使用 const/let，禁止 var',
          category: 'code_style',
          source: 'auto',
          count: 3,
          lastSeen: '2026-04-14T00:00:00.000Z',
        },
        {
          rule: '回复简洁，先结论后分析',
          category: 'interaction',
          source: 'auto',
          count: 2,
          lastSeen: '2026-04-15T00:00:00.000Z',
        },
        {
          rule: '优先 TypeScript',
          category: 'code_style',
          source: 'claude_md',
          count: 0,
          lastSeen: '2026-04-14T00:00:00.000Z',
        },
      ];

      reader.write(rules);
      const prompt = reader.formatTasteForPrompt();

      expect(prompt).toContain('User Taste — Auto-learned Preferences');
      expect(prompt).toContain('代码风格');
      expect(prompt).toContain('交互偏好');
      expect(prompt).toContain('使用 const/let，禁止 var');
      expect(prompt).toContain('被纠正 3 次');
      expect(prompt).toContain('来自 CLAUDE.md');
      expect(prompt).toContain('回复简洁，先结论后分析');
    });

    it('should not show count for manual rules', () => {
      reader.write([{
        rule: '手动设置的规则',
        category: 'general',
        source: 'manual',
        count: 0,
        lastSeen: '2026-04-14T00:00:00.000Z',
      }]);

      const prompt = reader.formatTasteForPrompt();
      expect(prompt).toContain('手动设置的规则');
      expect(prompt).not.toContain('被纠正');
      expect(prompt).not.toContain('来自 CLAUDE.md');
    });
  });

  // ───────────────────────────────────────────
  // getPersistPath
  // ───────────────────────────────────────────

  describe('getPersistPath', () => {
    it('should return path under .disclaude directory', () => {
      expect(reader.getPersistPath()).toBe(join(tempDir, '.disclaude', 'taste.json'));
    });
  });
});
