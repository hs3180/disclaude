/**
 * Tests for TasteManager.
 *
 * @see Issue #2335 — feat(project): auto-summarize user taste
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TasteManager } from './taste-manager.js';

describe('TasteManager', () => {
  let tmpDir: string;
  let manager: TasteManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taste-test-'));
    manager = new TasteManager({ workspaceDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('constructor & persistence', () => {
    it('should create .disclaude directory on first persist', () => {
      const m = new TasteManager({ workspaceDir: tmpDir });
      m.addRule('chat1', 'code_style', 'Use const/let only');

      expect(fs.existsSync(path.join(tmpDir, '.disclaude', 'taste.json'))).toBe(true);
    });

    it('should persist and reload data', () => {
      manager.addRule('chat1', 'code_style', 'Use const/let only');
      manager.addRule('chat1', 'interaction', 'Be concise');

      // Create a new manager to test reload
      const m2 = new TasteManager({ workspaceDir: tmpDir });
      const result = m2.listRules('chat1');

      expect(result.ok).toBe(true);
      expect(result.data).toHaveLength(2);
      expect(result.data.map(r => r.rule)).toContain('Use const/let only');
      expect(result.data.map(r => r.rule)).toContain('Be concise');
    });

    it('should handle missing file gracefully', () => {
      const m = new TasteManager({ workspaceDir: tmpDir });
      const result = m.listRules('nonexistent');
      expect(result.ok).toBe(true);
      expect(result.data).toEqual([]);
    });

    it('should handle corrupted file gracefully', () => {
      const dataDir = path.join(tmpDir, '.disclaude');
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'taste.json'), 'not json{}', 'utf8');

      const m = new TasteManager({ workspaceDir: tmpDir });
      const result = m.listRules('chat1');
      expect(result.ok).toBe(true);
      expect(result.data).toEqual([]);
    });
  });

  describe('addRule', () => {
    it('should add a new rule', () => {
      const result = manager.addRule('chat1', 'code_style', 'Use const/let only');

      expect(result.ok).toBe(true);
      expect(result.data?.rule).toBe('Use const/let only');
      expect(result.data?.category).toBe('code_style');
      expect(result.data?.source).toBe('manual');
      expect(result.data?.id).toMatch(/^r-\d+$/);
    });

    it('should add auto-detected rule with correction count', () => {
      const result = manager.addRule('chat1', 'tech_preference', 'Prefer TypeScript', 'auto');

      expect(result.ok).toBe(true);
      expect(result.data?.correctionCount).toBe(1);
    });

    it('should update existing rule instead of creating duplicate', () => {
      manager.addRule('chat1', 'code_style', 'Use const/let only');
      const result = manager.addRule('chat1', 'code_style', 'Use const/let only');

      expect(result.ok).toBe(true);
      expect(result.data?.correctionCount).toBe(1);

      // Should still be only 1 rule
      const list = manager.listRules('chat1');
      expect(list.data).toHaveLength(1);
    });

    it('should reject empty rule', () => {
      const result = manager.addRule('chat1', 'code_style', '');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('不能为空');
    });

    it('should reject empty chatId', () => {
      const result = manager.addRule('', 'code_style', 'some rule');
      expect(result.ok).toBe(false);
    });

    it('should trim whitespace from rule text', () => {
      const result = manager.addRule('chat1', 'code_style', '  Use const/let  ');
      expect(result.ok).toBe(true);
      expect(result.data?.rule).toBe('Use const/let');
    });
  });

  describe('removeRule', () => {
    it('should remove an existing rule', () => {
      const addResult = manager.addRule('chat1', 'code_style', 'Use const/let only');
      const ruleId = addResult.data!.id;

      const result = manager.removeRule('chat1', ruleId);
      expect(result.ok).toBe(true);

      const list = manager.listRules('chat1');
      expect(list.data).toHaveLength(0);
    });

    it('should fail for non-existent rule', () => {
      // First add a rule so the chatId exists
      manager.addRule('chat1', 'code_style', 'Some rule');
      // Then try removing a non-existent rule ID
      const result = manager.removeRule('chat1', 'r-999');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('不存在');
    });

    it('should fail for non-existent chatId', () => {
      const result = manager.removeRule('nonexistent', 'r-1');
      expect(result.ok).toBe(false);
    });
  });

  describe('listRules', () => {
    it('should list rules sorted by correction count desc', () => {
      manager.addRule('chat1', 'code_style', 'Rule A', 'auto');  // count: 1
      manager.addRule('chat1', 'code_style', 'Rule B', 'auto');
      manager.addRule('chat1', 'code_style', 'Rule B', 'auto');  // count: 2
      manager.addRule('chat1', 'code_style', 'Rule C', 'manual'); // count: 0

      const result = manager.listRules('chat1');
      expect(result.ok).toBe(true);
      expect(result.data).toHaveLength(3);
      // Rule B has count 2, should be first
      expect(result.data[0].rule).toBe('Rule B');
    });

    it('should filter by category', () => {
      manager.addRule('chat1', 'code_style', 'Rule A');
      manager.addRule('chat1', 'interaction', 'Rule B');

      const result = manager.listRules('chat1', 'interaction');
      expect(result.ok).toBe(true);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].rule).toBe('Rule B');
    });

    it('should return empty array for unknown chatId', () => {
      const result = manager.listRules('unknown');
      expect(result.ok).toBe(true);
      expect(result.data).toEqual([]);
    });
  });

  describe('resetTaste', () => {
    it('should clear all rules for a chatId', () => {
      manager.addRule('chat1', 'code_style', 'Rule A');
      manager.addRule('chat1', 'interaction', 'Rule B');

      const result = manager.resetTaste('chat1');
      expect(result.ok).toBe(true);
      expect(result.data).toBe(2);

      const list = manager.listRules('chat1');
      expect(list.data).toHaveLength(0);
    });

    it('should not affect other chatIds', () => {
      manager.addRule('chat1', 'code_style', 'Rule A');
      manager.addRule('chat2', 'code_style', 'Rule B');

      manager.resetTaste('chat1');

      expect(manager.listRules('chat1').data).toHaveLength(0);
      expect(manager.listRules('chat2').data).toHaveLength(1);
    });

    it('should return 0 for unknown chatId', () => {
      const result = manager.resetTaste('unknown');
      expect(result.ok).toBe(true);
      expect(result.data).toBe(0);
    });
  });

  describe('getTastePromptSection', () => {
    it('should return null for no rules', () => {
      expect(manager.getTastePromptSection('chat1')).toBeNull();
    });

    it('should return null for only auto rules below threshold', () => {
      // Auto rules need correctionCount >= 2 (AUTO_PROMOTE_THRESHOLD) to show
      manager.addRule('chat1', 'code_style', 'Use const', 'auto'); // count: 1
      expect(manager.getTastePromptSection('chat1')).toBeNull();
    });

    it('should show manual rules immediately', () => {
      manager.addRule('chat1', 'code_style', 'Use const', 'manual');

      const section = manager.getTastePromptSection('chat1');
      expect(section).not.toBeNull();
      expect(section).toContain('Use const');
      expect(section).toContain('User Preferences');
    });

    it('should show auto rules after threshold', () => {
      manager.addRule('chat1', 'code_style', 'Use const', 'auto');
      manager.addRule('chat1', 'code_style', 'Use const', 'auto'); // count: 2

      const section = manager.getTastePromptSection('chat1');
      expect(section).not.toBeNull();
      expect(section).toContain('Use const');
    });

    it('should group rules by category', () => {
      manager.addRule('chat1', 'code_style', 'Rule A', 'manual');
      manager.addRule('chat1', 'interaction', 'Rule B', 'manual');

      const section = manager.getTastePromptSection('chat1');
      expect(section).toContain('代码风格');
      expect(section).toContain('交互偏好');
    });
  });

  describe('persistence edge cases', () => {
    it('should survive concurrent managers', () => {
      const m1 = new TasteManager({ workspaceDir: tmpDir });
      const m2 = new TasteManager({ workspaceDir: tmpDir });

      m1.addRule('chat1', 'code_style', 'From M1');

      // M2 should see M1's data after reload
      m2.loadPersistedData();
      const result = m2.listRules('chat1');
      expect(result.data).toHaveLength(1);
      expect(result.data[0].rule).toBe('From M1');
    });

    it('should handle invalid rules in persisted data gracefully', () => {
      const dataDir = path.join(tmpDir, '.disclaude');
      fs.mkdirSync(dataDir, { recursive: true });

      const data = {
        chats: {
          chat1: {
            rules: [
              { id: 'r-1', category: 'code_style', rule: 'Valid rule', source: 'manual', correctionCount: 0, lastSeen: '2026-01-01', createdAt: '2026-01-01' },
              { id: 'r-2' /* missing fields */ },
              'not a rule',
            ],
          },
        },
      };
      fs.writeFileSync(path.join(dataDir, 'taste.json'), JSON.stringify(data));

      const m = new TasteManager({ workspaceDir: tmpDir });
      const result = m.listRules('chat1');
      expect(result.ok).toBe(true);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].rule).toBe('Valid rule');
    });
  });
});
