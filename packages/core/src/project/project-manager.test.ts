/**
 * Tests for ProjectManager.
 *
 * Issue #1916: Tests for project configuration loading,
 * knowledge base scanning, and chat-project mapping.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ProjectManager } from './project-manager.js';
import type { ProjectsConfig } from '../config/types.js';

describe('ProjectManager', () => {
  let tmpDir: string;
  let pm: ProjectManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should create with empty config', () => {
      pm = new ProjectManager({}, tmpDir);
      expect(pm.listProjects()).toEqual([]);
    });

    it('should create with projects config', () => {
      const config: ProjectsConfig = {
        default: { instructionsPath: './CLAUDE.md' },
        custom: { knowledge: ['./docs/'] },
      };
      pm = new ProjectManager(config, tmpDir);
      expect(pm.listProjects()).toEqual(['default', 'custom']);
    });
  });

  describe('listProjects / hasProject', () => {
    it('should list all project names', () => {
      const config: ProjectsConfig = {
        default: {},
        alpha: {},
        beta: {},
      };
      pm = new ProjectManager(config, tmpDir);
      expect(pm.listProjects()).toEqual(['default', 'alpha', 'beta']);
    });

    it('should check project existence', () => {
      pm = new ProjectManager({ default: {} }, tmpDir);
      expect(pm.hasProject('default')).toBe(true);
      expect(pm.hasProject('nonexistent')).toBe(false);
    });
  });

  describe('chat-project mapping', () => {
    it('should default to "default" project', () => {
      pm = new ProjectManager({ default: {} }, tmpDir);
      expect(pm.getProjectForChat('chat-1')).toBe('default');
    });

    it('should set and get project for chat', () => {
      pm = new ProjectManager({ default: {}, custom: {} }, tmpDir);
      expect(pm.setProjectForChat('chat-1', 'custom')).toBe(true);
      expect(pm.getProjectForChat('chat-1')).toBe('custom');
    });

    it('should return false for non-existent project', () => {
      pm = new ProjectManager({ default: {} }, tmpDir);
      expect(pm.setProjectForChat('chat-1', 'nonexistent')).toBe(false);
    });

    it('should maintain separate mappings per chat', () => {
      pm = new ProjectManager({ default: {}, a: {}, b: {} }, tmpDir);
      pm.setProjectForChat('chat-1', 'a');
      pm.setProjectForChat('chat-2', 'b');
      expect(pm.getProjectForChat('chat-1')).toBe('a');
      expect(pm.getProjectForChat('chat-2')).toBe('b');
    });

    it('should clear project assignment', () => {
      pm = new ProjectManager({ default: {}, custom: {} }, tmpDir);
      pm.setProjectForChat('chat-1', 'custom');
      pm.clearProjectForChat('chat-1');
      expect(pm.getProjectForChat('chat-1')).toBe('default');
    });
  });

  describe('loadProject — instructions', () => {
    it('should load instructions from CLAUDE.md', () => {
      // Create a CLAUDE.md file
      fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), 'Be a helpful assistant.\nAnswer in Chinese.');

      const config: ProjectsConfig = {
        default: { instructionsPath: './CLAUDE.md' },
      };
      pm = new ProjectManager(config, tmpDir);
      const ctx = pm.loadProject('default');

      expect(ctx.name).toBe('default');
      expect(ctx.instructions).toBe('Be a helpful assistant.\nAnswer in Chinese.');
      expect(ctx.totalChars).toBeGreaterThan(0);
    });

    it('should handle missing instructions file gracefully', () => {
      const config: ProjectsConfig = {
        default: { instructionsPath: './nonexistent.md' },
      };
      pm = new ProjectManager(config, tmpDir);
      const ctx = pm.loadProject('default');

      expect(ctx.instructions).toBeUndefined();
      expect(ctx.knowledgeFiles).toEqual([]);
    });

    it('should handle empty instructions file', () => {
      fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '   \n\n   ');
      const config: ProjectsConfig = {
        default: { instructionsPath: './CLAUDE.md' },
      };
      pm = new ProjectManager(config, tmpDir);
      const ctx = pm.loadProject('default');

      expect(ctx.instructions).toBeUndefined();
    });

    it('should resolve absolute instructions path', () => {
      const absolutePath = path.join(tmpDir, 'abs-instructions.md');
      fs.writeFileSync(absolutePath, 'Absolute path instructions.');

      const config: ProjectsConfig = {
        default: { instructionsPath: absolutePath },
      };
      pm = new ProjectManager(config, tmpDir);
      const ctx = pm.loadProject('default');

      expect(ctx.instructions).toBe('Absolute path instructions.');
    });
  });

  describe('loadProject — knowledge base', () => {
    it('should load files from knowledge directories', () => {
      // Create knowledge directory with files
      const docsDir = path.join(tmpDir, 'docs');
      fs.mkdirSync(docsDir);
      fs.writeFileSync(path.join(docsDir, 'guide.md'), '# Guide\n\nSome guide content.');
      fs.writeFileSync(path.join(docsDir, 'notes.txt'), 'Some notes.');

      const config: ProjectsConfig = {
        default: { knowledge: ['./docs/'] },
      };
      pm = new ProjectManager(config, tmpDir);
      const ctx = pm.loadProject('default');

      expect(ctx.knowledgeFiles.length).toBe(2);
      expect(ctx.knowledgeFiles.map(f => f.name).sort()).toEqual(['guide.md', 'notes.txt']);
    });

    it('should skip unsupported file types', () => {
      const docsDir = path.join(tmpDir, 'docs');
      fs.mkdirSync(docsDir);
      fs.writeFileSync(path.join(docsDir, 'readme.md'), 'Markdown content');
      fs.writeFileSync(path.join(docsDir, 'image.png'), 'binary data');
      fs.writeFileSync(path.join(docsDir, 'archive.zip'), 'zip data');

      const config: ProjectsConfig = {
        default: { knowledge: ['./docs/'] },
      };
      pm = new ProjectManager(config, tmpDir);
      const ctx = pm.loadProject('default');

      expect(ctx.knowledgeFiles.length).toBe(1);
      expect(ctx.knowledgeFiles[0].name).toBe('readme.md');
    });

    it('should skip hidden files and directories', () => {
      const docsDir = path.join(tmpDir, 'docs');
      fs.mkdirSync(docsDir);
      fs.mkdirSync(path.join(docsDir, '.hidden'));
      fs.writeFileSync(path.join(docsDir, '.gitignore'), '*.log');
      fs.writeFileSync(path.join(docsDir, 'visible.md'), 'Visible content');

      const config: ProjectsConfig = {
        default: { knowledge: ['./docs/'] },
      };
      pm = new ProjectManager(config, tmpDir);
      const ctx = pm.loadProject('default');

      expect(ctx.knowledgeFiles.length).toBe(1);
      expect(ctx.knowledgeFiles[0].name).toBe('visible.md');
    });

    it('should scan subdirectories', () => {
      const docsDir = path.join(tmpDir, 'docs');
      const subDir = path.join(docsDir, 'sub');
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(docsDir, 'root.md'), 'Root file');
      fs.writeFileSync(path.join(subDir, 'nested.md'), 'Nested file');

      const config: ProjectsConfig = {
        default: { knowledge: ['./docs/'] },
      };
      pm = new ProjectManager(config, tmpDir);
      const ctx = pm.loadProject('default');

      expect(ctx.knowledgeFiles.length).toBe(2);
      expect(ctx.knowledgeFiles.map(f => f.name).sort()).toEqual(['nested.md', 'root.md']);
    });

    it('should handle missing knowledge directory gracefully', () => {
      const config: ProjectsConfig = {
        default: { knowledge: ['./nonexistent-dir/'] },
      };
      pm = new ProjectManager(config, tmpDir);
      const ctx = pm.loadProject('default');

      expect(ctx.knowledgeFiles).toEqual([]);
    });

    it('should calculate totalChars correctly', () => {
      const docsDir = path.join(tmpDir, 'docs');
      fs.mkdirSync(docsDir);
      fs.writeFileSync(path.join(docsDir, 'a.md'), 'AAAA');
      fs.writeFileSync(path.join(docsDir, 'b.txt'), 'BB');

      const config: ProjectsConfig = {
        default: { knowledge: ['./docs/'] },
      };
      pm = new ProjectManager(config, tmpDir);
      const ctx = pm.loadProject('default');

      expect(ctx.totalChars).toBe(6); // "AAAA" + "BB"
    });
  });

  describe('loadProject — combined', () => {
    it('should load both instructions and knowledge', () => {
      fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), 'Project instructions.');
      const docsDir = path.join(tmpDir, 'docs');
      fs.mkdirSync(docsDir);
      fs.writeFileSync(path.join(docsDir, 'doc.md'), 'Doc content.');

      const config: ProjectsConfig = {
        default: {
          instructionsPath: './CLAUDE.md',
          knowledge: ['./docs/'],
        },
      };
      pm = new ProjectManager(config, tmpDir);
      const ctx = pm.loadProject('default');

      expect(ctx.instructions).toBe('Project instructions.');
      expect(ctx.knowledgeFiles.length).toBe(1);
      expect(ctx.totalChars).toBeGreaterThan(0);
    });

    it('should return empty context for unknown project', () => {
      pm = new ProjectManager({}, tmpDir);
      const ctx = pm.loadProject('unknown');

      expect(ctx.name).toBe('unknown');
      expect(ctx.instructions).toBeUndefined();
      expect(ctx.knowledgeFiles).toEqual([]);
      expect(ctx.totalChars).toBe(0);
    });
  });

  describe('loadProjectForChat', () => {
    it('should load the project assigned to a chat', () => {
      fs.writeFileSync(path.join(tmpDir, 'custom-instructions.md'), 'Custom instructions.');
      const config: ProjectsConfig = {
        default: { instructionsPath: './CLAUDE.md' },
        custom: { instructionsPath: './custom-instructions.md' },
      };
      pm = new ProjectManager(config, tmpDir);

      pm.setProjectForChat('chat-1', 'custom');
      const ctx = pm.loadProjectForChat('chat-1');

      expect(ctx.name).toBe('custom');
      expect(ctx.instructions).toBe('Custom instructions.');
    });
  });

  describe('reloadProject', () => {
    it('should invalidate cache and reload', () => {
      const instructionsFile = path.join(tmpDir, 'CLAUDE.md');
      fs.writeFileSync(instructionsFile, 'Version 1');

      const config: ProjectsConfig = {
        default: { instructionsPath: './CLAUDE.md' },
      };
      pm = new ProjectManager(config, tmpDir);

      const ctx1 = pm.loadProject('default');
      expect(ctx1.instructions).toBe('Version 1');

      // Modify file and reload
      fs.writeFileSync(instructionsFile, 'Version 2');
      const ctx2 = pm.reloadProject('default');
      expect(ctx2.instructions).toBe('Version 2');
    });
  });

  describe('getProjectConfig', () => {
    it('should return project config', () => {
      const config: ProjectsConfig = {
        myproject: { instructionsPath: './inst.md', knowledge: ['./docs/'] },
      };
      pm = new ProjectManager(config, tmpDir);

      const pc = pm.getProjectConfig('myproject');
      expect(pc?.instructionsPath).toBe('./inst.md');
      expect(pc?.knowledge).toEqual(['./docs/']);
    });

    it('should return undefined for unknown project', () => {
      pm = new ProjectManager({}, tmpDir);
      expect(pm.getProjectConfig('unknown')).toBeUndefined();
    });
  });
});
