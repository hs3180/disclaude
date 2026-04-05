/**
 * Tests for Project Manager.
 * Issue #1916: Project Knowledge Base feature.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ProjectManager } from './project-manager.js';
import type { ProjectsConfig } from '../config/types.js';

describe('ProjectManager', () => {
  let tempDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-manager-test-'));
    workspaceDir = path.join(tempDir, 'workspace');
    await fs.mkdir(workspaceDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('construction', () => {
    it('should initialize with projects config', () => {
      const config: ProjectsConfig = {
        default: { knowledge: ['./docs/'] },
      };

      const manager = new ProjectManager(config, workspaceDir);

      expect(manager.listProjects()).toEqual(['default']);
    });

    it('should handle empty projects config', () => {
      const manager = new ProjectManager({}, workspaceDir);

      expect(manager.listProjects()).toEqual([]);
      expect(manager.getDefaultProjectName()).toBeNull();
    });
  });

  describe('listProjects', () => {
    it('should return all project names', () => {
      const config: ProjectsConfig = {
        default: {},
        custom: {},
        another: {},
      };

      const manager = new ProjectManager(config, workspaceDir);

      expect(manager.listProjects()).toEqual(['default', 'custom', 'another']);
    });
  });

  describe('hasProject', () => {
    it('should return true for existing project', () => {
      const config: ProjectsConfig = { default: {} };
      const manager = new ProjectManager(config, workspaceDir);

      expect(manager.hasProject('default')).toBe(true);
    });

    it('should return false for non-existent project', () => {
      const config: ProjectsConfig = { default: {} };
      const manager = new ProjectManager(config, workspaceDir);

      expect(manager.hasProject('nonexistent')).toBe(false);
    });
  });

  describe('getDefaultProjectName', () => {
    it('should return the configured default project', () => {
      const config: ProjectsConfig = {
        default: {},
        custom: {},
      };

      const manager = new ProjectManager(config, workspaceDir, 'custom');

      expect(manager.getDefaultProjectName()).toBe('custom');
    });

    it('should fall back to first project if default not found', () => {
      const config: ProjectsConfig = {
        first: {},
        second: {},
      };

      const manager = new ProjectManager(config, workspaceDir, 'nonexistent');

      expect(manager.getDefaultProjectName()).toBe('first');
    });

    it('should return null if no projects configured', () => {
      const manager = new ProjectManager({}, workspaceDir);

      expect(manager.getDefaultProjectName()).toBeNull();
    });
  });

  describe('switchProject', () => {
    it('should switch active project for a chat', () => {
      const config: ProjectsConfig = { default: {}, custom: {} };
      const manager = new ProjectManager(config, workspaceDir);

      expect(manager.switchProject('chat-1', 'custom')).toBe(true);
      expect(manager.getActiveProjectName('chat-1')).toBe('custom');
    });

    it('should fail for non-existent project', () => {
      const config: ProjectsConfig = { default: {} };
      const manager = new ProjectManager(config, workspaceDir);

      expect(manager.switchProject('chat-1', 'nonexistent')).toBe(false);
    });

    it('should not affect other chats', () => {
      const config: ProjectsConfig = { default: {}, custom: {} };
      const manager = new ProjectManager(config, workspaceDir);

      manager.switchProject('chat-1', 'custom');
      expect(manager.getActiveProjectName('chat-2')).toBe('default');
    });
  });

  describe('clearProject', () => {
    it('should revert to default project', () => {
      const config: ProjectsConfig = { default: {}, custom: {} };
      const manager = new ProjectManager(config, workspaceDir);

      manager.switchProject('chat-1', 'custom');
      manager.clearProject('chat-1');
      expect(manager.getActiveProjectName('chat-1')).toBe('default');
    });
  });

  describe('getOrLoadProject', () => {
    it('should load project from filesystem', async () => {
      // Create test files
      const docsDir = path.join(workspaceDir, 'docs');
      await fs.mkdir(docsDir);
      await fs.writeFile(path.join(docsDir, 'guide.md'), '# Guide\n\nSome info');

      const config: ProjectsConfig = {
        default: {
          knowledge: ['./docs/'],
        },
      };

      const manager = new ProjectManager(config, workspaceDir);
      const project = await manager.getOrLoadProject('default');

      expect(project).not.toBeNull();
      expect(project!.name).toBe('default');
      expect(project!.knowledge).toHaveLength(1);
      expect(project!.knowledge[0].relativePath).toBe('guide.md');
    });

    it('should cache loaded projects', async () => {
      const config: ProjectsConfig = { default: {} };
      const manager = new ProjectManager(config, workspaceDir);

      const project1 = await manager.getOrLoadProject('default');
      const project2 = await manager.getOrLoadProject('default');

      // Should be the same cached object
      expect(project1).toBe(project2);
    });

    it('should return null for non-existent project', async () => {
      const config: ProjectsConfig = { default: {} };
      const manager = new ProjectManager(config, workspaceDir);

      const project = await manager.getOrLoadProject('nonexistent');

      expect(project).toBeNull();
    });

    it('should load instructions from instructions_path', async () => {
      const instructionsPath = path.join(workspaceDir, 'CLAUDE.md');
      await fs.writeFile(instructionsPath, '# Instructions\n\nBe helpful.');

      const config: ProjectsConfig = {
        default: {
          instructions_path: './CLAUDE.md',
        },
      };

      const manager = new ProjectManager(config, workspaceDir);
      const project = await manager.getOrLoadProject('default');

      expect(project).not.toBeNull();
      expect(project!.instructions).toBe('# Instructions\n\nBe helpful.');
    });
  });

  describe('invalidateCache', () => {
    it('should invalidate specific project cache', async () => {
      const config: ProjectsConfig = { default: {} };
      const manager = new ProjectManager(config, workspaceDir);

      const project1 = await manager.getOrLoadProject('default');
      manager.invalidateCache('default');
      const project2 = await manager.getOrLoadProject('default');

      // Should be different objects after cache invalidation
      expect(project1).not.toBe(project2);
    });

    it('should invalidate all caches when no project specified', async () => {
      const config: ProjectsConfig = { a: {}, b: {} };
      const manager = new ProjectManager(config, workspaceDir);

      await manager.getOrLoadProject('a');
      await manager.getOrLoadProject('b');
      manager.invalidateCache();

      // Both should be reloaded (not cached)
      const a = await manager.getOrLoadProject('a');
      const b = await manager.getOrLoadProject('b');
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
    });
  });

  describe('getProjectPromptSection', () => {
    it('should return formatted prompt section for active project', async () => {
      const instructionsPath = path.join(workspaceDir, 'CLAUDE.md');
      await fs.writeFile(instructionsPath, '# Rules\n\nBe concise.');

      const config: ProjectsConfig = {
        default: {
          instructions_path: './CLAUDE.md',
        },
      };

      const manager = new ProjectManager(config, workspaceDir);
      const section = await manager.getProjectPromptSection('chat-1');

      expect(section).toContain('Project Context');
      expect(section).toContain('# Rules');
    });

    it('should return empty string when no project is active', async () => {
      const manager = new ProjectManager({}, workspaceDir);
      const section = await manager.getProjectPromptSection('chat-1');

      expect(section).toBe('');
    });
  });
});
