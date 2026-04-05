/**
 * Tests for ResearchModeManager (packages/core/src/modes/research-mode-manager.ts)
 *
 * Verifies:
 * - Project activation creates directory and default CLAUDE.md
 * - Deactivation returns to normal workspace
 * - Project listing scans directory
 * - State management is correct
 * - Edge cases (empty name, path traversal, etc.)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ResearchModeManager } from '../research-mode-manager.js';
import type { ResearchConfig } from '../types.js';

/** Create a temporary directory for test isolation */
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'research-mode-test-'));
}

/** Remove directory recursively */
function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('ResearchModeManager', () => {
  let tempDir: string;
  let workspaceDir: string;
  let manager: ResearchModeManager;

  beforeEach(() => {
    tempDir = createTempDir();
    workspaceDir = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    manager = new ResearchModeManager(workspaceDir);
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  describe('initial state', () => {
    it('should start in normal mode', () => {
      const state = manager.getState();
      expect(state.mode).toBe('normal');
      expect(state.project).toBeNull();
    });

    it('should return base workspace as effective cwd when not active', () => {
      expect(manager.getEffectiveCwd()).toBe(workspaceDir);
    });

    it('should report not active', () => {
      expect(manager.isActive()).toBe(false);
    });

    it('should report no current project', () => {
      expect(manager.getCurrentProject()).toBeNull();
    });

    it('should use default workspace suffix "research"', () => {
      const result = manager.activateResearch('test-project');
      expect(result.cwd).toContain(path.join('workspace', 'research', 'test-project'));
    });

    it('should use custom workspace suffix from config', () => {
      const customManager = new ResearchModeManager(workspaceDir, {
        workspaceSuffix: 'studies',
      });
      const result = customManager.activateResearch('my-study');
      expect(result.cwd).toContain(path.join('workspace', 'studies', 'my-study'));
    });
  });

  describe('activateResearch', () => {
    it('should create project directory and return correct cwd', () => {
      const result = manager.activateResearch('my-project');

      expect(result.cwd).toBe(path.join(workspaceDir, 'research', 'my-project'));
      expect(result.created).toBe(true);
      expect(fs.existsSync(result.cwd)).toBe(true);
    });

    it('should write default CLAUDE.md when directory is new', () => {
      const result = manager.activateResearch('new-project');

      expect(result.claudeMdWritten).toBe(true);
      const claudeMdPath = path.join(result.cwd, 'CLAUDE.md');
      expect(fs.existsSync(claudeMdPath)).toBe(true);
      const content = fs.readFileSync(claudeMdPath, 'utf-8');
      expect(content).toContain('Research Project');
    });

    it('should not overwrite existing CLAUDE.md', () => {
      const projectDir = path.join(workspaceDir, 'research', 'existing-project');
      fs.mkdirSync(projectDir, { recursive: true });
      const customContent = '# Custom Instructions\nThis is my custom CLAUDE.md.';
      fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), customContent, 'utf-8');

      const result = manager.activateResearch('existing-project');

      expect(result.created).toBe(false);
      expect(result.claudeMdWritten).toBe(false);
      const content = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
      expect(content).toBe(customContent);
    });

    it('should report created=false for existing project directory', () => {
      manager.activateResearch('first-activation');
      const result = manager.activateResearch('first-activation');

      expect(result.created).toBe(false);
      expect(result.claudeMdWritten).toBe(false);
    });

    it('should update state to research mode with project name', () => {
      manager.activateResearch('test-proj');

      const state = manager.getState();
      expect(state.mode).toBe('research');
      expect(state.project).toBe('test-proj');
    });

    it('should report active after activation', () => {
      manager.activateResearch('active-test');
      expect(manager.isActive()).toBe(true);
      expect(manager.getCurrentProject()).toBe('active-test');
    });

    it('should return research workspace as effective cwd', () => {
      manager.activateResearch('cwd-test');
      expect(manager.getEffectiveCwd()).toContain(path.join('research', 'cwd-test'));
    });

    it('should trim whitespace from project name', () => {
      const result = manager.activateResearch('  spaced-project  ');
      expect(result.cwd).toContain(path.join('research', 'spaced-project'));
      expect(manager.getCurrentProject()).toBe('spaced-project');
    });

    it('should throw error for empty project name', () => {
      expect(() => manager.activateResearch('')).toThrow('Project name is required');
    });

    it('should throw error for whitespace-only project name', () => {
      expect(() => manager.activateResearch('   ')).toThrow('Project name is required');
    });

    it('should throw error for undefined-like empty string', () => {
      expect(() => manager.activateResearch('' as string)).toThrow('Project name is required');
    });

    it('should reject path traversal in project name', () => {
      expect(() => manager.activateResearch('../escape')).toThrow('Invalid project name');
    });

    it('should reject forward slash in project name', () => {
      expect(() => manager.activateResearch('foo/bar')).toThrow('Invalid project name');
    });

    it('should reject backslash in project name', () => {
      expect(() => manager.activateResearch('foo\\bar')).toThrow('Invalid project name');
    });

    it('should reject dot-dot in project name', () => {
      expect(() => manager.activateResearch('..')).toThrow('Invalid project name');
    });

    it('should allow hyphenated project names', () => {
      const result = manager.activateResearch('my-research-project');
      expect(result.cwd).toContain('my-research-project');
    });

    it('should allow underscored project names', () => {
      const result = manager.activateResearch('my_research_project');
      expect(result.cwd).toContain('my_research_project');
    });

    it('should allow numeric project names', () => {
      const result = manager.activateResearch('123');
      expect(result.cwd).toContain('123');
    });

    it('should switch between projects', () => {
      manager.activateResearch('project-a');
      expect(manager.getCurrentProject()).toBe('project-a');

      manager.activateResearch('project-b');
      expect(manager.getCurrentProject()).toBe('project-b');
      expect(manager.getEffectiveCwd()).toContain('project-b');
    });
  });

  describe('deactivateResearch', () => {
    it('should return to normal mode', () => {
      manager.activateResearch('to-deactivate');
      const result = manager.deactivateResearch();

      expect(result).toBe('to-deactivate');
      expect(manager.isActive()).toBe(false);
      expect(manager.getCurrentProject()).toBeNull();
      expect(manager.getEffectiveCwd()).toBe(workspaceDir);
    });

    it('should return null when not in research mode', () => {
      const result = manager.deactivateResearch();
      expect(result).toBeNull();
    });

    it('should not delete project directory on deactivation', () => {
      manager.activateResearch('persistent-project');
      const projectDir = manager.getEffectiveCwd();

      manager.deactivateResearch();

      expect(fs.existsSync(projectDir)).toBe(true);
    });
  });

  describe('listResearchProjects', () => {
    it('should return empty array when no projects exist', () => {
      expect(manager.listResearchProjects()).toEqual([]);
    });

    it('should list created projects', () => {
      manager.activateResearch('alpha');
      manager.deactivateResearch();
      manager.activateResearch('beta');
      manager.deactivateResearch();

      const projects = manager.listResearchProjects();
      expect(projects).toContain('alpha');
      expect(projects).toContain('beta');
      expect(projects).toHaveLength(2);
    });

    it('should only list directories (not files)', () => {
      const researchDir = path.join(workspaceDir, 'research');
      fs.mkdirSync(researchDir, { recursive: true });
      fs.mkdirSync(path.join(researchDir, 'real-project'));
      fs.writeFileSync(path.join(researchDir, 'not-a-project.txt'), 'data');

      const projects = manager.listResearchProjects();
      expect(projects).toEqual(['real-project']);
    });
  });

  describe('getState', () => {
    it('should return a copy (not reference)', () => {
      const state1 = manager.getState();
      manager.activateResearch('state-test');
      const state2 = manager.getState();

      // Original state should not be affected
      expect(state1.mode).toBe('normal');
      expect(state1.project).toBeNull();
      expect(state2.mode).toBe('research');
      expect(state2.project).toBe('state-test');
    });
  });

  describe('multiple instances', () => {
    it('should maintain independent state per instance', () => {
      const manager1 = new ResearchModeManager(workspaceDir);
      const manager2 = new ResearchModeManager(workspaceDir);

      manager1.activateResearch('instance-test');

      expect(manager1.isActive()).toBe(true);
      expect(manager1.getCurrentProject()).toBe('instance-test');
      expect(manager2.isActive()).toBe(false);
    });
  });
});
