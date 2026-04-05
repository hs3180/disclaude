/**
 * Tests for project manager.
 * @module knowledge/project-manager.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ProjectManager, createProjectManager } from './project-manager.js';
import type { ProjectsConfig } from './types.js';

describe('ProjectManager', () => {
  let tempDir: string;
  let projectsConfig: ProjectsConfig;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-test-'));

    // Create knowledge directories and files
    const docsDir = path.join(tempDir, 'docs');
    const dataDir = path.join(tempDir, 'data');
    await fs.mkdir(docsDir);
    await fs.mkdir(dataDir);

    await fs.writeFile(path.join(tempDir, 'CLAUDE.md'), '# Default Instructions');
    await fs.writeFile(path.join(docsDir, 'guide.md'), '# Guide');
    await fs.writeFile(path.join(dataDir, 'info.txt'), 'Info');

    // Create second project
    const bookDir = path.join(tempDir, 'book-reader');
    await fs.mkdir(bookDir, { recursive: true });
    await fs.writeFile(path.join(bookDir, 'CLAUDE.md'), '# Book Reader Instructions');

    projectsConfig = {
      default: {
        instructions_path: './CLAUDE.md',
        knowledge: ['./docs/', './data/'],
      },
      'book-reader': {
        instructions_path: './book-reader/CLAUDE.md',
        knowledge: [],
      },
    };
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('createProjectManager', () => {
    it('should return null for undefined config', () => {
      expect(createProjectManager(undefined, tempDir)).toBeNull();
    });

    it('should return null for empty config', () => {
      expect(createProjectManager({}, tempDir)).toBeNull();
    });

    it('should create manager for valid config', () => {
      const manager = createProjectManager(projectsConfig, tempDir);
      expect(manager).not.toBeNull();
    });
  });

  describe('getCurrentProject', () => {
    it('should return default project initially', () => {
      const manager = new ProjectManager(projectsConfig, tempDir);
      expect(manager.getCurrentProject('chat1')).toBe('default');
    });
  });

  describe('switchProject', () => {
    it('should switch to a valid project', () => {
      const manager = new ProjectManager(projectsConfig, tempDir);
      const result = manager.switchProject('chat1', 'book-reader');
      expect(result).toBe(true);
      expect(manager.getCurrentProject('chat1')).toBe('book-reader');
    });

    it('should reject switching to nonexistent project', () => {
      const manager = new ProjectManager(projectsConfig, tempDir);
      const result = manager.switchProject('chat1', 'nonexistent');
      expect(result).toBe(false);
      expect(manager.getCurrentProject('chat1')).toBe('default');
    });

    it('should maintain separate state per chat', () => {
      const manager = new ProjectManager(projectsConfig, tempDir);
      manager.switchProject('chat1', 'book-reader');
      expect(manager.getCurrentProject('chat1')).toBe('book-reader');
      expect(manager.getCurrentProject('chat2')).toBe('default');
    });
  });

  describe('listProjects', () => {
    it('should list all configured projects', () => {
      const manager = new ProjectManager(projectsConfig, tempDir);
      const projects = manager.listProjects();

      expect(projects).toHaveLength(2);
      expect(projects[0].name).toBe('default');
      expect(projects[0].isDefault).toBe(true);
      expect(projects[0].hasInstructions).toBe(true);
      expect(projects[0].knowledgeDirCount).toBe(2);

      expect(projects[1].name).toBe('book-reader');
      expect(projects[1].isDefault).toBe(false);
      expect(projects[1].hasInstructions).toBe(true);
      expect(projects[1].knowledgeDirCount).toBe(0);
    });
  });

  describe('loadKnowledge', () => {
    it('should load knowledge for default project', async () => {
      const manager = new ProjectManager(projectsConfig, tempDir);
      const result = await manager.loadKnowledge('chat1');

      expect(result.projectName).toBe('default');
      expect(result.instructions).toContain('# Default Instructions');
      expect(result.files.length).toBeGreaterThan(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should cache knowledge results', async () => {
      const manager = new ProjectManager(projectsConfig, tempDir, { cacheTtlMs: 60000 });
      const result1 = await manager.loadKnowledge('chat1');
      const result2 = await manager.loadKnowledge('chat1');

      expect(result1).toBe(result2);
    });

    it('should load different knowledge for different projects', async () => {
      const manager = new ProjectManager(projectsConfig, tempDir);
      manager.switchProject('chat1', 'book-reader');

      const result = await manager.loadKnowledge('chat1');
      expect(result.projectName).toBe('book-reader');
      expect(result.instructions).toContain('# Book Reader Instructions');
    });
  });

  describe('getKnowledgeSection', () => {
    it('should return formatted section with content', async () => {
      const manager = new ProjectManager(projectsConfig, tempDir);
      const section = await manager.getKnowledgeSection('chat1');

      expect(section).toContain('Project Knowledge: default');
      expect(section).toContain('# Default Instructions');
    });
  });

  describe('invalidateCache', () => {
    it('should invalidate cache for a specific chat', async () => {
      const manager = new ProjectManager(projectsConfig, tempDir, { cacheTtlMs: 60000 });
      await manager.loadKnowledge('chat1');
      manager.invalidateCache('chat1');

      // Should reload fresh
      const result = await manager.loadKnowledge('chat1');
      expect(result.projectName).toBe('default');
    });
  });

  describe('hasProjects', () => {
    it('should return true when projects are configured', () => {
      const manager = new ProjectManager(projectsConfig, tempDir);
      expect(manager.hasProjects()).toBe(true);
    });
  });

  describe('clearChatState', () => {
    it('should clear chat state and related caches', () => {
      const manager = new ProjectManager(projectsConfig, tempDir);
      manager.switchProject('chat1', 'book-reader');
      manager.clearChatState('chat1');

      expect(manager.getCurrentProject('chat1')).toBe('default');
    });
  });
});
