/**
 * Tests for TasteStore — file-based persistence for user taste preferences.
 *
 * @see Issue #2335
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TasteStore } from './taste-store.js';

describe('TasteStore', () => {
  let tmpDir: string;
  let store: TasteStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taste-test-'));
    store = new TasteStore({ workspaceDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Load Tests
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('load', () => {
    it('should return empty profile when no taste.yaml exists', () => {
      const result = store.load();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.version).toBe(1);
        expect(result.data.rules).toEqual([]);
      }
    });

    it('should load a valid taste.yaml file', () => {
      const yaml = `
version: 1
rules:
  - category: code_style
    content: "Use const/let, never var"
    source: manual
  - category: interaction
    content: "Reply concisely"
    source: auto
    correctionCount: 3
    lastSeen: "2026-04-14"
`;
      fs.writeFileSync(path.join(tmpDir, 'taste.yaml'), yaml);

      const result = store.load(true);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.rules).toHaveLength(2);
        expect(result.data.rules[0].category).toBe('code_style');
        expect(result.data.rules[0].content).toBe('Use const/let, never var');
        expect(result.data.rules[0].source).toBe('manual');
        expect(result.data.rules[1].correctionCount).toBe(3);
      }
    });

    it('should skip invalid rules and keep valid ones', () => {
      const yaml = `
version: 1
rules:
  - category: code_style
    content: "Valid rule"
    source: manual
  - category: invalid_category
    content: "Invalid category"
    source: manual
  - category: code_style
    content: ""
    source: manual
`;
      fs.writeFileSync(path.join(tmpDir, 'taste.yaml'), yaml);

      const result = store.load(true);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.rules).toHaveLength(1);
        expect(result.data.rules[0].content).toBe('Valid rule');
      }
    });

    it('should return error for invalid version', () => {
      const yaml = `
version: 2
rules: []
`;
      fs.writeFileSync(path.join(tmpDir, 'taste.yaml'), yaml);

      const result = store.load(true);
      expect(result.ok).toBe(false);
    });

    it('should cache loaded profile', () => {
      const result1 = store.load();
      const result2 = store.load();

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      // Both should return same object reference (cached)
      if (result1.ok && result2.ok) {
        expect(result1.data).toBe(result2.data);
      }
    });

    it('should force reload when requested', () => {
      const result1 = store.load();

      // Write a new file
      const yaml = `
version: 1
rules:
  - category: code_style
    content: "New rule"
    source: manual
`;
      fs.writeFileSync(path.join(tmpDir, 'taste.yaml'), yaml);

      const result2 = store.load(true);

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      if (result1.ok && result2.ok) {
        expect(result1.data.rules).toHaveLength(0);
        expect(result2.data.rules).toHaveLength(1);
      }
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // AddRule Tests
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('addRule', () => {
    it('should add a new rule and persist to disk', () => {
      const result = store.addRule({
        category: 'code_style',
        content: 'Use const/let, never var',
        source: 'manual',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.category).toBe('code_style');
        expect(result.data.content).toBe('Use const/let, never var');
        expect(result.data.createdAt).toBeDefined();
      }

      // Verify persisted
      const loaded = store.load(true);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.data.rules).toHaveLength(1);
      }
    });

    it('should update existing rule instead of creating duplicate', () => {
      store.addRule({
        category: 'code_style',
        content: 'Use const/let',
        source: 'auto',
      });

      const result = store.addRule({
        category: 'code_style',
        content: 'Use const/let',
        source: 'auto',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.correctionCount).toBe(2);
      }

      // Should still have only 1 rule
      const loaded = store.load(true);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.data.rules).toHaveLength(1);
      }
    });

    it('should detect duplicates case-insensitively', () => {
      store.addRule({
        category: 'code_style',
        content: 'Use CONST/let',
        source: 'auto',
      });

      const result = store.addRule({
        category: 'code_style',
        content: 'use const/LET',
        source: 'auto',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.correctionCount).toBe(2);
      }

      const loaded = store.load(true);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.data.rules).toHaveLength(1);
      }
    });

    it('should allow same content in different categories', () => {
      store.addRule({
        category: 'code_style',
        content: 'Use TypeScript',
        source: 'manual',
      });

      const result = store.addRule({
        category: 'technical',
        content: 'Use TypeScript',
        source: 'manual',
      });

      expect(result.ok).toBe(true);

      const loaded = store.load(true);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.data.rules).toHaveLength(2);
      }
    });

    it('should set correctionCount to 1 for auto source', () => {
      const result = store.addRule({
        category: 'code_style',
        content: 'Some rule',
        source: 'auto',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.correctionCount).toBe(1);
      }
    });

    it('should not set correctionCount for manual source', () => {
      const result = store.addRule({
        category: 'code_style',
        content: 'Some rule',
        source: 'manual',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.correctionCount).toBeUndefined();
      }
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // RemoveRule Tests
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('removeRule', () => {
    it('should remove a rule by content', () => {
      store.addRule({
        category: 'code_style',
        content: 'Rule to remove',
        source: 'manual',
      });
      store.addRule({
        category: 'code_style',
        content: 'Rule to keep',
        source: 'manual',
      });

      const result = store.removeRule('Rule to remove');
      expect(result.ok).toBe(true);

      const loaded = store.load(true);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.data.rules).toHaveLength(1);
        expect(loaded.data.rules[0].content).toBe('Rule to keep');
      }
    });

    it('should return error when rule not found', () => {
      const result = store.removeRule('Nonexistent rule');
      expect(result.ok).toBe(false);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Clear Tests
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('clear', () => {
    it('should remove all rules', () => {
      store.addRule({ category: 'code_style', content: 'Rule 1', source: 'manual' });
      store.addRule({ category: 'interaction', content: 'Rule 2', source: 'manual' });

      const result = store.clear();
      expect(result.ok).toBe(true);

      const loaded = store.load(true);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.data.rules).toHaveLength(0);
      }
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GetRules Tests
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('getRules', () => {
    it('should return empty array when no rules', () => {
      expect(store.getRules()).toEqual([]);
    });

    it('should return rules from loaded profile', () => {
      store.addRule({ category: 'code_style', content: 'Rule 1', source: 'manual' });
      store.addRule({ category: 'interaction', content: 'Rule 2', source: 'auto' });

      const rules = store.getRules();
      expect(rules).toHaveLength(2);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Save Tests
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('save', () => {
    it('should write valid YAML to disk', () => {
      store.addRule({ category: 'code_style', content: 'Rule 1', source: 'manual' });

      const content = fs.readFileSync(path.join(tmpDir, 'taste.yaml'), 'utf-8');
      expect(content).toContain('version: 1');
      expect(content).toContain('Rule 1');
      expect(content).toContain('code_style');
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Custom Filename Tests
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('custom filename', () => {
    it('should use custom filename when provided', () => {
      const customStore = new TasteStore({
        workspaceDir: tmpDir,
        filename: 'my-taste.yaml',
      });

      customStore.addRule({
        category: 'code_style',
        content: 'Custom file rule',
        source: 'manual',
      });

      expect(fs.existsSync(path.join(tmpDir, 'my-taste.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'taste.yaml'))).toBe(false);
    });
  });
});
