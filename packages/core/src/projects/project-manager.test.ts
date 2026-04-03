/**
 * Tests for ProjectManager.
 *
 * Issue #1916: Tests project state management, knowledge caching,
 * and project switching.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ProjectManager } from './project-manager.js';
import type { ProjectsConfig } from './types.js';

describe('ProjectManager', () => {
  let tempDir: string;
  let config: ProjectsConfig;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pm-test-'));

    // Create knowledge directories with files
    await fs.promises.mkdir(path.join(tempDir, 'docs'));
    await fs.promises.writeFile(
      path.join(tempDir, 'docs', 'guide.md'),
      '# Guide\n\nProject documentation.'
    );

    await fs.promises.mkdir(path.join(tempDir, 'books'));
    await fs.promises.writeFile(
      path.join(tempDir, 'books', 'summary.md'),
      '# Summary\n\nBook summary.'
    );

    config = {
      default: {
        instructionsPath: './CLAUDE.md',
        knowledge: [path.join(tempDir, 'docs')],
      },
      reader: {
        knowledge: [path.join(tempDir, 'books')],
      },
    };
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should initialize with project names', () => {
      const pm = new ProjectManager(config, tempDir);
      expect(pm.hasProjects()).toBe(true);
      expect(pm.listProjects()).toHaveLength(2);
    });

    it('should handle empty config', () => {
      const pm = new ProjectManager({}, tempDir);
      expect(pm.hasProjects()).toBe(false);
      expect(pm.listProjects()).toHaveLength(0);
    });
  });

  describe('getCurrentProject', () => {
    it('should return default project when none is set', () => {
      const pm = new ProjectManager(config, tempDir);
      expect(pm.getCurrentProject('chat-1')).toBe('default');
    });

    it('should return first project when no default exists', () => {
      const pm = new ProjectManager({
        custom: { knowledge: [] },
      }, tempDir);
      expect(pm.getCurrentProject('chat-1')).toBe('custom');
    });

    it('should return undefined when no projects configured', () => {
      const pm = new ProjectManager({}, tempDir);
      expect(pm.getCurrentProject('chat-1')).toBeUndefined();
    });

    it('should return switched project', () => {
      const pm = new ProjectManager(config, tempDir);
      pm.switchProject('chat-1', 'reader');
      expect(pm.getCurrentProject('chat-1')).toBe('reader');
    });

    it('should maintain separate projects per chatId', () => {
      const pm = new ProjectManager(config, tempDir);
      pm.switchProject('chat-1', 'reader');
      expect(pm.getCurrentProject('chat-1')).toBe('reader');
      expect(pm.getCurrentProject('chat-2')).toBe('default');
    });
  });

  describe('switchProject', () => {
    it('should switch to a valid project', () => {
      const pm = new ProjectManager(config, tempDir);
      expect(pm.switchProject('chat-1', 'reader')).toBe(true);
      expect(pm.getCurrentProject('chat-1')).toBe('reader');
    });

    it('should return false for unknown project', () => {
      const pm = new ProjectManager(config, tempDir);
      expect(pm.switchProject('chat-1', 'nonexistent')).toBe(false);
    });
  });

  describe('getProjectKnowledge', () => {
    it('should load knowledge for default project', async () => {
      const pm = new ProjectManager(config, tempDir);
      const result = await pm.getProjectKnowledge('chat-1');

      expect(result.fileCount).toBe(1);
      expect(result.content).toContain('guide.md');
      expect(result.content).toContain('Project documentation');
    });

    it('should load knowledge for switched project', async () => {
      const pm = new ProjectManager(config, tempDir);
      pm.switchProject('chat-1', 'reader');
      const result = await pm.getProjectKnowledge('chat-1');

      expect(result.fileCount).toBe(1);
      expect(result.content).toContain('summary.md');
    });

    it('should return empty result when no projects configured', async () => {
      const pm = new ProjectManager({}, tempDir);
      const result = await pm.getProjectKnowledge('chat-1');

      expect(result.content).toBe('');
      expect(result.fileCount).toBe(0);
    });

    it('should cache knowledge base content', async () => {
      const pm = new ProjectManager(config, tempDir);

      // First load
      const result1 = await pm.getProjectKnowledge('chat-1');
      // Second load (should be cached)
      const result2 = await pm.getProjectKnowledge('chat-1');

      expect(result1).toEqual(result2);
    });

    it('should return empty result for project without knowledge dirs', async () => {
      const pm = new ProjectManager({
        empty: {},
      }, tempDir);
      const result = await pm.getProjectKnowledge('chat-1');

      expect(result.content).toBe('');
      expect(result.fileCount).toBe(0);
    });
  });

  describe('listProjects', () => {
    it('should list all configured projects with metadata', () => {
      const pm = new ProjectManager(config, tempDir);
      const projects = pm.listProjects();

      expect(projects).toHaveLength(2);

      const defaultProject = projects.find(p => p.name === 'default')!;
      expect(defaultProject.isDefault).toBe(true);
      expect(defaultProject.hasInstructions).toBe(true);
      expect(defaultProject.knowledgeDirCount).toBe(1);

      const readerProject = projects.find(p => p.name === 'reader')!;
      expect(readerProject.isDefault).toBe(false);
      expect(readerProject.hasInstructions).toBe(false);
      expect(readerProject.knowledgeDirCount).toBe(1);
    });
  });

  describe('clearCache', () => {
    it('should clear cache for specific project', async () => {
      const pm = new ProjectManager(config, tempDir);

      // Load and cache
      await pm.getProjectKnowledge('chat-1');

      // Clear cache
      expect(pm.clearCache('default')).toBe(true);
      expect(pm.clearCache('nonexistent')).toBe(false);
    });

    it('should clear all caches', async () => {
      const pm = new ProjectManager(config, tempDir);

      await pm.getProjectKnowledge('chat-1');
      pm.switchProject('chat-1', 'reader');
      await pm.getProjectKnowledge('chat-1');

      expect(pm.clearCache()).toBe(true);
    });
  });

  describe('getProjectConfig', () => {
    it('should return config for existing project', () => {
      const pm = new ProjectManager(config, tempDir);
      const projectConfig = pm.getProjectConfig('default');

      expect(projectConfig).toBeDefined();
      expect(projectConfig!.instructionsPath).toBe('./CLAUDE.md');
      expect(projectConfig!.knowledge).toHaveLength(1);
    });

    it('should return undefined for non-existent project', () => {
      const pm = new ProjectManager(config, tempDir);
      expect(pm.getProjectConfig('nonexistent')).toBeUndefined();
    });
  });
});
