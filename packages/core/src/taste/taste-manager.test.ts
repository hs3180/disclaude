/**
 * Tests for TasteManager — core taste (preference) management.
 *
 * @see Issue #2335 (parent — auto-summarize user taste)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TasteManager } from './taste-manager.js';
import type { CorrectionSignal } from './types.js';

describe('TasteManager', () => {
  let tempDir: string;
  let dataDir: string;
  let manager: TasteManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'taste-test-'));
    dataDir = join(tempDir, '.disclaude');
    manager = new TasteManager({ dataDir });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ───────────────────────────────────────────
  // Initialization & Loading
  // ───────────────────────────────────────────

  describe('load()', () => {
    it('should start with empty state when no file exists', () => {
      const result = manager.load();
      expect(result.ok).toBe(true);
      expect(manager.list()).toEqual([]);
    });

    it('should load persisted workspace tastes', () => {
      // Add some tastes, then create a new manager to test loading
      manager.add('Use const/let, never var', 'code_style', 'manual');
      manager.add('Reply concisely', 'interaction', 'manual');

      const manager2 = new TasteManager({ dataDir });
      const result = manager2.load();
      expect(result.ok).toBe(true);
      expect(manager2.list()).toHaveLength(2);
      expect(manager2.list()[0].rule).toBe('Use const/let, never var');
    });

    it('should load persisted project tastes', () => {
      manager.add('Project-specific rule', 'project_convention', 'manual', 'my-project');

      const manager2 = new TasteManager({ dataDir });
      manager2.load();
      expect(manager2.list('my-project')).toHaveLength(1);
    });

    it('should handle corrupted JSON gracefully', () => {
      const { writeFileSync, mkdirSync } = require('node:fs');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, 'taste.json'), 'invalid json{{{', 'utf8');

      const result = manager.load();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('失败');
    });

    it('should handle invalid schema gracefully', () => {
      const { writeFileSync, mkdirSync } = require('node:fs');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, 'taste.json'), '"not an object"', 'utf8');

      const result = manager.load();
      expect(result.ok).toBe(false);
    });
  });

  // ───────────────────────────────────────────
  // Add Operations
  // ───────────────────────────────────────────

  describe('add()', () => {
    it('should add a workspace-level taste rule', () => {
      const result = manager.add('Use const/let', 'code_style', 'manual');
      expect(result.ok).toBe(true);
      expect(result.data!.rule).toBe('Use const/let');
      expect(result.data!.category).toBe('code_style');
      expect(result.data!.source).toBe('manual');
      expect(result.data!.correctionCount).toBe(0);
    });

    it('should add a project-scoped taste rule', () => {
      const result = manager.add('Use camelCase', 'code_style', 'manual', 'my-project');
      expect(result.ok).toBe(true);

      // Should not appear in workspace list
      expect(manager.list()).toHaveLength(0);
      // Should appear in project list
      expect(manager.list('my-project')).toHaveLength(1);
    });

    it('should reject empty rules', () => {
      const result = manager.add('', 'code_style', 'manual');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('不能为空');
    });

    it('should reject whitespace-only rules', () => {
      const result = manager.add('   ', 'code_style', 'manual');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('不能为空');
    });

    it('should reject duplicate rules (case-insensitive)', () => {
      manager.add('Use TypeScript', 'technical', 'manual');
      const result = manager.add('use typescript', 'technical', 'manual');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('已存在');
    });

    it('should allow same rule text in different scopes', () => {
      manager.add('Use TypeScript', 'technical', 'manual');
      const result = manager.add('Use TypeScript', 'technical', 'manual', 'project-a');
      expect(result.ok).toBe(true);
    });

    it('should trim whitespace from rules', () => {
      const result = manager.add('  Use pnpm  ', 'technical', 'manual');
      expect(result.ok).toBe(true);
      expect(result.data!.rule).toBe('Use pnpm');
    });

    it('should set auto source correctionCount to threshold', () => {
      const result = manager.add('Auto-detected rule', 'code_style', 'auto');
      expect(result.ok).toBe(true);
      expect(result.data!.correctionCount).toBeGreaterThanOrEqual(2);
    });

    it('should reject rules exceeding max length', () => {
      const longRule = 'a'.repeat(201);
      const result = manager.add(longRule, 'code_style', 'manual');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('200');
    });
  });

  // ───────────────────────────────────────────
  // Remove Operations
  // ───────────────────────────────────────────

  describe('remove()', () => {
    it('should remove a workspace taste by index', () => {
      manager.add('Rule 1', 'code_style', 'manual');
      manager.add('Rule 2', 'interaction', 'manual');

      const result = manager.remove(0);
      expect(result.ok).toBe(true);
      expect(manager.list()).toHaveLength(1);
      expect(manager.list()[0].rule).toBe('Rule 2');
    });

    it('should remove a project taste by index', () => {
      manager.add('Project rule', 'code_style', 'manual', 'my-project');

      const result = manager.remove(0, 'my-project');
      expect(result.ok).toBe(true);
      expect(manager.list('my-project')).toHaveLength(0);
    });

    it('should reject out-of-bounds index', () => {
      const result = manager.remove(0);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('越界');
    });

    it('should reject negative index', () => {
      const result = manager.remove(-1);
      expect(result.ok).toBe(false);
    });
  });

  // ───────────────────────────────────────────
  // Update Operations
  // ───────────────────────────────────────────

  describe('update()', () => {
    it('should update rule text', () => {
      manager.add('Old rule', 'code_style', 'manual');

      const result = manager.update(0, { rule: 'New rule' });
      expect(result.ok).toBe(true);
      expect(result.data!.rule).toBe('New rule');
      expect(manager.list()[0].rule).toBe('New rule');
    });

    it('should update category', () => {
      manager.add('A rule', 'code_style', 'manual');

      const result = manager.update(0, { category: 'interaction' });
      expect(result.ok).toBe(true);
      expect(result.data!.category).toBe('interaction');
    });

    it('should reject invalid rule text on update', () => {
      manager.add('Valid rule', 'code_style', 'manual');

      const result = manager.update(0, { rule: '' });
      expect(result.ok).toBe(false);
    });
  });

  // ───────────────────────────────────────────
  // Auto-detection
  // ───────────────────────────────────────────

  describe('recordCorrection()', () => {
    const makeSignal = (rule: string, category = 'code_style' as const): CorrectionSignal => ({
      category,
      rule,
      timestamp: new Date().toISOString(),
      originalMessage: `Please fix: ${rule}`,
    });

    it('should accumulate correction signals without promoting below threshold', () => {
      const result = manager.recordCorrection(makeSignal('Use const/let'));
      expect(result.ok).toBe(true);
      expect(result.data).toBe(false); // Not promoted yet
      expect(manager.list()).toHaveLength(0);
    });

    it('should auto-promote after reaching threshold', () => {
      manager.recordCorrection(makeSignal('Use const/let'));
      const result = manager.recordCorrection(makeSignal('Use const/let'));
      expect(result.ok).toBe(true);
      expect(result.data).toBe(true); // Promoted!
      expect(manager.list()).toHaveLength(1);
      expect(manager.list()[0].source).toBe('auto');
      expect(manager.list()[0].correctionCount).toBe(2);
    });

    it('should update existing rule correction count on repeated corrections', () => {
      manager.recordCorrection(makeSignal('Use const/let'));
      manager.recordCorrection(makeSignal('Use const/let')); // Promotes (count=2)

      // Continue recording corrections — accumulate another batch
      manager.recordCorrection(makeSignal('Use const/let'));
      manager.recordCorrection(makeSignal('Use const/let')); // Second batch (count += 2 → total = 4)

      expect(manager.list()[0].correctionCount).toBe(4);
    });

    it('should handle corrections for project scope', () => {
      manager.recordCorrection(makeSignal('Project rule'), undefined);
      manager.recordCorrection(makeSignal('Project rule'), 'my-project');
      manager.recordCorrection(makeSignal('Project rule'), 'my-project'); // Promotes in project

      expect(manager.list()).toHaveLength(0); // Not promoted at workspace level
      expect(manager.list('my-project')).toHaveLength(1);
    });

    it('should handle different categories independently', () => {
      manager.recordCorrection(makeSignal('Use const/let', 'code_style'));
      manager.recordCorrection(makeSignal('Reply concisely', 'interaction'));
      manager.recordCorrection(makeSignal('Use const/let', 'code_style')); // Promotes

      expect(manager.list()).toHaveLength(1); // Only code_style promoted
    });
  });

  // ───────────────────────────────────────────
  // Effective Taste (Merge)
  // ───────────────────────────────────────────

  describe('getEffectiveTaste()', () => {
    it('should return workspace tastes sorted by correction count', () => {
      manager.add('Low priority', 'code_style', 'manual');
      // Simulate higher correction count
      manager.add('High priority', 'code_style', 'auto'); // auto = threshold count

      const effective = manager.getEffectiveTaste();
      expect(effective.length).toBe(2);
      expect(effective[0].correctionCount).toBeGreaterThanOrEqual(effective[1].correctionCount);
    });

    it('should merge workspace and project tastes', () => {
      manager.add('Workspace rule', 'code_style', 'manual');
      manager.add('Project rule', 'interaction', 'manual', 'my-project');

      const effective = manager.getEffectiveTaste('my-project');
      expect(effective.length).toBe(2);
    });

    it('should return only workspace tastes when no project specified', () => {
      manager.add('Workspace rule', 'code_style', 'manual');
      manager.add('Project rule', 'code_style', 'manual', 'my-project');

      const effective = manager.getEffectiveTaste();
      expect(effective.length).toBe(1);
      expect(effective[0].rule).toBe('Workspace rule');
    });
  });

  // ───────────────────────────────────────────
  // Reset
  // ───────────────────────────────────────────

  describe('reset()', () => {
    it('should clear workspace tastes', () => {
      manager.add('Rule 1', 'code_style', 'manual');
      manager.add('Rule 2', 'interaction', 'manual');

      manager.reset();
      expect(manager.list()).toHaveLength(0);
    });

    it('should clear project tastes', () => {
      manager.add('Workspace rule', 'code_style', 'manual');
      manager.add('Project rule', 'code_style', 'manual', 'my-project');

      manager.reset('my-project');
      expect(manager.list('my-project')).toHaveLength(0);
      expect(manager.list()).toHaveLength(1); // Workspace preserved
    });

    it('should clear all when resetting workspace', () => {
      manager.add('Workspace rule', 'code_style', 'manual');
      manager.add('Project rule', 'code_style', 'manual', 'my-project');

      manager.reset();
      expect(manager.list()).toHaveLength(0);
      expect(manager.list('my-project')).toHaveLength(0);
    });
  });

  // ───────────────────────────────────────────
  // Persistence
  // ───────────────────────────────────────────

  describe('persistence', () => {
    it('should persist to taste.json', () => {
      manager.add('Persisted rule', 'code_style', 'manual');

      const persistPath = join(dataDir, 'taste.json');
      expect(existsSync(persistPath)).toBe(true);

      const data = JSON.parse(readFileSync(persistPath, 'utf8'));
      expect(data.workspace).toHaveLength(1);
      expect(data.workspace[0].rule).toBe('Persisted rule');
    });

    it('should persist project tastes', () => {
      manager.add('Project rule', 'code_style', 'manual', 'test-project');

      const data = JSON.parse(readFileSync(join(dataDir, 'taste.json'), 'utf8'));
      expect(data.projects['test-project']).toHaveLength(1);
    });

    it('should survive reload', () => {
      manager.add('Survives reload', 'code_style', 'manual');
      manager.add('Project survives', 'code_style', 'manual', 'proj');

      const manager2 = new TasteManager({ dataDir });
      manager2.load();

      expect(manager2.list()).toHaveLength(1);
      expect(manager2.list()[0].rule).toBe('Survives reload');
      expect(manager2.list('proj')).toHaveLength(1);
    });
  });

  // ───────────────────────────────────────────
  // listProjects()
  // ───────────────────────────────────────────

  describe('listProjects()', () => {
    it('should return empty array when no project tastes', () => {
      expect(manager.listProjects()).toEqual([]);
    });

    it('should return all projects with taste overrides', () => {
      manager.add('Rule A', 'code_style', 'manual', 'project-a');
      manager.add('Rule B', 'code_style', 'manual', 'project-b');

      const projects = manager.listProjects();
      expect(projects).toContain('project-a');
      expect(projects).toContain('project-b');
    });
  });

  // ───────────────────────────────────────────
  // getPersistPath()
  // ───────────────────────────────────────────

  describe('getPersistPath()', () => {
    it('should return the correct path', () => {
      expect(manager.getPersistPath()).toBe(join(dataDir, 'taste.json'));
    });
  });
});
