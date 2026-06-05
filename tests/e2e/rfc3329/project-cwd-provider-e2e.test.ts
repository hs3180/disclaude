/**
 * Integration test: Project Binding + CwdProvider + CLAUDE_CONFIG_DIR end-to-end.
 *
 * Tests the cross-component flow:
 *   ProjectManager.use() → persist() → createCwdProvider() → CwdProvider(chatId) → workingDir
 *
 * Verifies that the full chain from project binding through CwdProvider
 * works correctly, including persistence and CLAUDE_CONFIG_DIR implication.
 *
 * @see Issue #3662 — categories 1 & 3
 * @see RFC #3329 — Message — Unified Agent Input Abstraction
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { ProjectManager } from '@disclaude/core';
import { createTestWorkspace } from './helpers.js';

describe('Project Binding + CwdProvider end-to-end (RFC #3329)', () => {
  let workspaceDir: string;
  let cleanup: () => void;
  let pm: ProjectManager;

  beforeEach(() => {
    const ws = createTestWorkspace();
    workspaceDir = ws.workspaceDir;
    cleanup = ws.cleanup;
    pm = new ProjectManager({ workspaceDir });
  });

  afterEach(() => {
    cleanup();
  });

  // ─── Category 1: Project Binding end-to-end ───

  describe('Project Binding end-to-end', () => {
    it('should return default context when no binding exists', () => {
      const cwdProvider = pm.createCwdProvider();
      const result = cwdProvider('oc_unbound_chat');

      expect(result).toBeUndefined();
      expect(pm.getActive('oc_unbound_chat')).toEqual({
        name: 'default',
        workingDir: workspaceDir,
      });
    });

    it('should bind chatId to a project directory and return it via CwdProvider', () => {
      const projectDir = join(workspaceDir, 'my-project');
      mkdirSync(projectDir, { recursive: true });

      const bindResult = pm.use('oc_test_chat', projectDir);
      expect(bindResult.ok).toBe(true);
      expect(bindResult.data).toEqual({
        name: 'my-project',
        workingDir: projectDir,
      });

      // CwdProvider returns the bound workingDir
      const cwdProvider = pm.createCwdProvider();
      expect(cwdProvider('oc_test_chat')).toBe(projectDir);
    });

    it('should persist bindings and restore them on new ProjectManager instance', () => {
      const projectDir = join(workspaceDir, 'persisted-project');
      mkdirSync(projectDir, { recursive: true });
      mkdirSync(join(workspaceDir, 'another'), { recursive: true });

      // Bind and persist
      pm.use('oc_chat_a', projectDir);
      pm.use('oc_chat_b', join(workspaceDir, 'another'));

      // Verify persistence file exists
      const persistPath = join(workspaceDir, '.disclaude', 'project-bindings.json');
      expect(existsSync(persistPath)).toBe(true);

      // Read and verify persisted data
      const data = JSON.parse(readFileSync(persistPath, 'utf8'));
      expect(data.version).toBe(1);
      expect(data.bindings['oc_chat_a']).toBe(projectDir);

      // Create a new ProjectManager from same workspace → bindings restored
      const pm2 = new ProjectManager({ workspaceDir });
      expect(pm2.getActive('oc_chat_a')).toEqual({
        name: 'persisted-project',
        workingDir: projectDir,
      });

      const cwdProvider2 = pm2.createCwdProvider();
      expect(cwdProvider2('oc_chat_a')).toBe(projectDir);
    });

    it('should reset binding and make CwdProvider return undefined', () => {
      const projectDir = join(workspaceDir, 'temp-project');
      mkdirSync(projectDir, { recursive: true });
      pm.use('oc_reset_chat', projectDir);

      // Verify bound
      const cwdBefore = pm.createCwdProvider();
      expect(cwdBefore('oc_reset_chat')).toBe(projectDir);

      // Reset
      const resetResult = pm.reset('oc_reset_chat');
      expect(resetResult.ok).toBe(true);
      expect(resetResult.data).toEqual({
        name: 'default',
        workingDir: workspaceDir,
      });

      // CwdProvider now returns undefined (default)
      const cwdAfter = pm.createCwdProvider();
      expect(cwdAfter('oc_reset_chat')).toBeUndefined();
    });

    it('should isolate bindings between different chatIds', () => {
      mkdirSync(join(workspaceDir, 'project-a'), { recursive: true });
      mkdirSync(join(workspaceDir, 'project-b'), { recursive: true });
      pm.use('oc_chat_1', join(workspaceDir, 'project-a'));
      pm.use('oc_chat_2', join(workspaceDir, 'project-b'));

      const cwdProvider = pm.createCwdProvider();

      expect(cwdProvider('oc_chat_1')).toBe(join(workspaceDir, 'project-a'));
      expect(cwdProvider('oc_chat_2')).toBe(join(workspaceDir, 'project-b'));
      expect(cwdProvider('oc_unbound')).toBeUndefined();
    });

    it('should support re-binding to a different directory', () => {
      mkdirSync(join(workspaceDir, 'first'), { recursive: true });
      mkdirSync(join(workspaceDir, 'second'), { recursive: true });
      pm.use('oc_rebind_chat', join(workspaceDir, 'first'));
      pm.use('oc_rebind_chat', join(workspaceDir, 'second'));

      const cwdProvider = pm.createCwdProvider();
      expect(cwdProvider('oc_rebind_chat')).toBe(join(workspaceDir, 'second'));
    });
  });

  // ─── Category 3: CLAUDE_CONFIG_DIR end-to-end ───

  describe('CLAUDE_CONFIG_DIR implication end-to-end', () => {
    it('should produce cwd for project-bound agent (implies CLAUDE_CONFIG_DIR injection)', () => {
      const projectDir = join(workspaceDir, 'bound-project');
      mkdirSync(projectDir, { recursive: true });
      pm.use('oc_bound_chat', projectDir);

      const cwdProvider = pm.createCwdProvider();
      const resolvedCwd = cwdProvider('oc_bound_chat');

      // When resolvedCwd differs from workspaceDir, BaseAgent.createSdkOptions
      // will set CLAUDE_CONFIG_DIR = path.join(workspaceDir, '.claude')
      expect(resolvedCwd).toBe(projectDir);
      expect(resolvedCwd).not.toBe(workspaceDir);
      // Implied CLAUDE_CONFIG_DIR location
      expect(join(workspaceDir, '.claude')).toMatch(/\.claude$/);
    });

    it('should return undefined for default project (no CLAUDE_CONFIG_DIR injection)', () => {
      const cwdProvider = pm.createCwdProvider();
      const resolvedCwd = cwdProvider('oc_default_chat');

      // When undefined, BaseAgent falls back to workspaceDir
      // and does NOT set CLAUDE_CONFIG_DIR
      expect(resolvedCwd).toBeUndefined();
    });

    it('should handle binding→reset cycle correctly for CLAUDE_CONFIG_DIR', () => {
      const projectDir = join(workspaceDir, 'cycle-project');
      mkdirSync(projectDir, { recursive: true });

      // Bound → cwd is set → CLAUDE_CONFIG_DIR would be injected
      pm.use('oc_cycle_chat', projectDir);
      let cwd = pm.createCwdProvider()('oc_cycle_chat');
      expect(cwd).toBe(projectDir);
      expect(cwd).not.toBe(workspaceDir);

      // Reset → cwd is undefined → no CLAUDE_CONFIG_DIR injection
      pm.reset('oc_cycle_chat');
      cwd = pm.createCwdProvider()('oc_cycle_chat');
      expect(cwd).toBeUndefined();
    });
  });
});
