/**
 * Integration test: Project Binding end-to-end (RFC #3329).
 *
 * Tests the full pipeline:
 *   ProjectManager.use() → CwdProvider → correct workingDir resolution
 *
 * Verifies that chatId → workingDir bindings persist correctly and
 * that CwdProvider returns the expected values for bound and unbound chatIds.
 *
 * @see Issue #3662
 * @see RFC #3329
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectManager } from '@disclaude/core';
import type { CwdProvider } from '@disclaude/core';

describe('Project Binding end-to-end', () => {
  let workspaceDir: string;
  let projectDir: string;
  let manager: ProjectManager;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'disclaude-test-ws-'));
    projectDir = join(workspaceDir, 'my-project');
    mkdirSync(projectDir, { recursive: true });
    // Create a CLAUDE.md to simulate a real project
    writeFileSync(join(projectDir, 'CLAUDE.md'), '# My Project');
    manager = new ProjectManager({ workspaceDir });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  describe('CwdProvider with bound project', () => {
    it('should return bound workingDir for a bound chatId', () => {
      const result = manager.use('oc_chat_1', 'my-project');
      expect(result.ok).toBe(true);

      const cwdProvider: CwdProvider = manager.createCwdProvider();
      const cwd = cwdProvider('oc_chat_1');

      expect(cwd).toBe(resolve(workspaceDir, 'my-project'));
    });

    it('should return undefined for default (unbound) chatId', () => {
      const cwdProvider: CwdProvider = manager.createCwdProvider();
      const cwd = cwdProvider('oc_unknown_chat');

      expect(cwd).toBeUndefined();
    });

    it('should reflect binding changes through CwdProvider', () => {
      const cwdProvider: CwdProvider = manager.createCwdProvider();

      // Before binding
      expect(cwdProvider('oc_chat_1')).toBeUndefined();

      // After binding
      manager.use('oc_chat_1', 'my-project');
      expect(cwdProvider('oc_chat_1')).toBe(resolve(workspaceDir, 'my-project'));

      // After reset
      manager.reset('oc_chat_1');
      expect(cwdProvider('oc_chat_1')).toBeUndefined();
    });

    it('should support multiple chatIds with different bindings', () => {
      const projectDir2 = join(workspaceDir, 'other-project');
      mkdirSync(projectDir2, { recursive: true });

      manager.use('oc_chat_A', 'my-project');
      manager.use('oc_chat_B', 'other-project');

      const cwdProvider: CwdProvider = manager.createCwdProvider();
      expect(cwdProvider('oc_chat_A')).toBe(resolve(workspaceDir, 'my-project'));
      expect(cwdProvider('oc_chat_B')).toBe(resolve(workspaceDir, 'other-project'));
      expect(cwdProvider('oc_chat_C')).toBeUndefined();
    });
  });

  describe('Project binding persistence across instances', () => {
    it('should restore bindings from disk when ProjectManager is recreated', () => {
      // Bind in first instance
      manager.use('oc_persist_chat', 'my-project');
      expect(manager.getActive('oc_persist_chat').name).toBe('my-project');

      // Create new instance pointing to the same workspace
      const manager2 = new ProjectManager({ workspaceDir });
      const active = manager2.getActive('oc_persist_chat');

      expect(active.name).toBe('my-project');
      expect(active.workingDir).toBe(resolve(workspaceDir, 'my-project'));
    });

    it('should persist reset operations', () => {
      manager.use('oc_reset_chat', 'my-project');

      // Reset in first instance
      manager.reset('oc_reset_chat');

      // New instance should see no binding
      const manager2 = new ProjectManager({ workspaceDir });
      const active = manager2.getActive('oc_reset_chat');

      expect(active.name).toBe('default');
    });
  });

  describe('getActive() returns correct ProjectContextConfig', () => {
    it('should return default context for unbound chatId', () => {
      const active = manager.getActive('oc_new_chat');

      expect(active.name).toBe('default');
      expect(active.workingDir).toBe(workspaceDir);
    });

    it('should return project context for bound chatId', () => {
      manager.use('oc_bound_chat', 'my-project');
      const active = manager.getActive('oc_bound_chat');

      expect(active.name).toBe('my-project');
      expect(active.workingDir).toBe(resolve(workspaceDir, 'my-project'));
    });

    it('should return basename as name for deeply nested paths', () => {
      const nested = join(workspaceDir, 'a', 'b', 'c');
      mkdirSync(nested, { recursive: true });

      manager.use('oc_nested', nested);
      const active = manager.getActive('oc_nested');

      expect(active.name).toBe('c');
    });
  });

  describe('Binding validation', () => {
    it('should reject path traversal attempts', () => {
      const result = manager.use('oc_evil', '../../../etc/passwd');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('..');
      }
    });

    it('should reject empty workingDir', () => {
      const result = manager.use('oc_empty', '');
      expect(result.ok).toBe(false);
    });

    it('should reject empty chatId', () => {
      const result = manager.use('', 'my-project');
      expect(result.ok).toBe(false);
    });
  });
});
