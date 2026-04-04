/**
 * Tests for ProjectContext module.
 *
 * Issue #1916: Tests for loading project-scoped instructions
 * and knowledge base files for prompt injection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ProjectContext } from './project-context.js';
import type { ProjectsConfig } from '../config/types.js';

describe('ProjectContext', () => {
  let tempDir: string;
  let projectContext: ProjectContext;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-context-test-'));
    projectContext = new ProjectContext(undefined, tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should accept undefined config', () => {
      const ctx = new ProjectContext(undefined, '/workspace');
      expect(ctx.getProjectNames()).toEqual([]);
    });

    it('should accept empty config', () => {
      const ctx = new ProjectContext({}, '/workspace');
      expect(ctx.getProjectNames()).toEqual([]);
    });
  });

  describe('loadActiveProject', () => {
    it('should return null when no config is set', async () => {
      const result = await projectContext.loadActiveProject();
      expect(result).toBeNull();
    });

    it('should load the default project when no active is set', async () => {
      const instructionsPath = path.join(tempDir, 'CLAUDE.md');
      await fs.writeFile(instructionsPath, '# My Instructions\n\nFollow these rules.');

      const config: ProjectsConfig = {
        default: { instructionsPath },
      };
      const ctx = new ProjectContext(config, tempDir);

      const result = await ctx.loadActiveProject();
      expect(result).not.toBeNull();
      expect(result!.name).toBe('default');
      expect(result!.hasInstructions).toBe(true);
      expect(result!.context).toContain('My Instructions');
    });

    it('should load the active project when set', async () => {
      const defaultPath = path.join(tempDir, 'default-CLAUDE.md');
      await fs.writeFile(defaultPath, '# Default Project');

      const activePath = path.join(tempDir, 'active-CLAUDE.md');
      await fs.writeFile(activePath, '# Active Project');

      const config: ProjectsConfig = {
        active: 'my-project',
        default: { instructionsPath: 'default-CLAUDE.md' },
        'my-project': { instructionsPath: 'active-CLAUDE.md' },
      };
      const ctx = new ProjectContext(config, tempDir);

      const result = await ctx.loadActiveProject();
      expect(result).not.toBeNull();
      expect(result!.name).toBe('my-project');
      expect(result!.context).toContain('Active Project');
    });
  });

  describe('loadProject', () => {
    it('should return null for non-existent project', async () => {
      const config: ProjectsConfig = {};
      const ctx = new ProjectContext(config, tempDir);

      const result = await ctx.loadProject('nonexistent');
      expect(result).toBeNull();
    });

    it('should cache results for repeated calls', async () => {
      const instructionsPath = path.join(tempDir, 'CLAUDE.md');
      await fs.writeFile(instructionsPath, '# Instructions');

      const config: ProjectsConfig = {
        default: { instructionsPath },
      };
      const ctx = new ProjectContext(config, tempDir);

      const result1 = await ctx.loadProject('default');
      const result2 = await ctx.loadProject('default');

      // Should return the exact same object (cached)
      expect(result1).toBe(result2);
    });

    it('should support string-format project config (instructions path only)', async () => {
      const instructionsPath = path.join(tempDir, 'CLAUDE.md');
      await fs.writeFile(instructionsPath, '# String Config Instructions');

      const config: ProjectsConfig = {
        default: instructionsPath,
      };
      const ctx = new ProjectContext(config, tempDir);

      const result = await ctx.loadProject('default');
      expect(result).not.toBeNull();
      expect(result!.hasInstructions).toBe(true);
      expect(result!.context).toContain('String Config Instructions');
    });
  });

  describe('loadInstructions', () => {
    it('should load instructions from CLAUDE.md', async () => {
      const instructionsPath = path.join(tempDir, 'CLAUDE.md');
      await fs.writeFile(instructionsPath, '# Project Rules\n\n1. Be concise\n2. Use markdown');

      const config: ProjectsConfig = {
        default: { instructionsPath },
      };
      const ctx = new ProjectContext(config, tempDir);

      const result = await ctx.loadProject('default');
      expect(result!.hasInstructions).toBe(true);
      expect(result!.context).toContain('Project Rules');
      expect(result!.context).toContain('Be concise');
      expect(result!.instructionsPath).toBe(instructionsPath);
    });

    it('should handle missing instructions file gracefully', async () => {
      const config: ProjectsConfig = {
        default: { instructionsPath: 'nonexistent.md' },
      };
      const ctx = new ProjectContext(config, tempDir);

      const result = await ctx.loadProject('default');
      expect(result).not.toBeNull();
      expect(result!.hasInstructions).toBe(false);
      expect(result!.context).toBe('');
    });

    it('should handle empty instructions file', async () => {
      const instructionsPath = path.join(tempDir, 'CLAUDE.md');
      await fs.writeFile(instructionsPath, '   \n\n   ');

      const config: ProjectsConfig = {
        default: { instructionsPath },
      };
      const ctx = new ProjectContext(config, tempDir);

      const result = await ctx.loadProject('default');
      expect(result!.hasInstructions).toBe(false);
    });
  });

  describe('loadKnowledge', () => {
    it('should load knowledge files from directory', async () => {
      const knowledgeDir = path.join(tempDir, 'knowledge');
      await fs.mkdir(knowledgeDir, { recursive: true });
      await fs.writeFile(path.join(knowledgeDir, 'guide.md'), '# Guide\n\nSome guide content.');
      await fs.writeFile(path.join(knowledgeDir, 'faq.txt'), 'FAQ content here.');

      const config: ProjectsConfig = {
        default: { knowledge: [{ dir: 'knowledge' }] },
      };
      const ctx = new ProjectContext(config, tempDir);

      const result = await ctx.loadProject('default');
      expect(result!.knowledgeFileCount).toBe(2);
      expect(result!.context).toContain('Guide');
      expect(result!.context).toContain('FAQ content');
    });

    it('should filter files by extension', async () => {
      const knowledgeDir = path.join(tempDir, 'knowledge');
      await fs.mkdir(knowledgeDir, { recursive: true });
      await fs.writeFile(path.join(knowledgeDir, 'readme.md'), '# Readme');
      await fs.writeFile(path.join(knowledgeDir, 'data.json'), '{"key": "value"}');
      await fs.writeFile(path.join(knowledgeDir, 'image.png'), 'binary data');
      await fs.writeFile(path.join(knowledgeDir, 'script.sh'), '#!/bin/bash');

      const config: ProjectsConfig = {
        default: {
          knowledge: [{ dir: 'knowledge', extensions: ['.md', '.json'] }],
        },
      };
      const ctx = new ProjectContext(config, tempDir);

      const result = await ctx.loadProject('default');
      expect(result!.knowledgeFileCount).toBe(2);
      expect(result!.context).toContain('Readme');
      expect(result!.context).toContain('{"key": "value"}');
      expect(result!.context).not.toContain('binary data');
    });

    it('should handle missing knowledge directory gracefully', async () => {
      const config: ProjectsConfig = {
        default: { knowledge: [{ dir: 'nonexistent-dir' }] },
      };
      const ctx = new ProjectContext(config, tempDir);

      const result = await ctx.loadProject('default');
      expect(result!.knowledgeFileCount).toBe(0);
    });

    it('should skip hidden files and node_modules', async () => {
      const knowledgeDir = path.join(tempDir, 'knowledge');
      await fs.mkdir(path.join(knowledgeDir, '.hidden'), { recursive: true });
      await fs.mkdir(path.join(knowledgeDir, 'node_modules', 'pkg'), { recursive: true });
      await fs.writeFile(path.join(knowledgeDir, '.hidden', 'secret.md'), '# Secret');
      await fs.writeFile(path.join(knowledgeDir, 'node_modules', 'pkg', 'index.js'), 'module');
      await fs.writeFile(path.join(knowledgeDir, 'visible.md'), '# Visible');

      const config: ProjectsConfig = {
        default: { knowledge: [{ dir: 'knowledge' }] },
      };
      const ctx = new ProjectContext(config, tempDir);

      const result = await ctx.loadProject('default');
      expect(result!.knowledgeFileCount).toBe(1);
      expect(result!.context).toContain('Visible');
      expect(result!.context).not.toContain('Secret');
    });

    it('should respect maxChars limit', async () => {
      const knowledgeDir = path.join(tempDir, 'knowledge');
      await fs.mkdir(knowledgeDir, { recursive: true });
      await fs.writeFile(path.join(knowledgeDir, 'a.md'), 'A'.repeat(500));
      await fs.writeFile(path.join(knowledgeDir, 'b.md'), 'B'.repeat(500));
      await fs.writeFile(path.join(knowledgeDir, 'c.md'), 'C'.repeat(500));

      const config: ProjectsConfig = {
        default: {
          knowledge: [{ dir: 'knowledge', maxChars: 800 }],
        },
      };
      const ctx = new ProjectContext(config, tempDir);

      const result = await ctx.loadProject('default');
      // Should include at least one file but not all three (limited by maxChars)
      expect(result!.knowledgeFileCount).toBeGreaterThanOrEqual(1);
      expect(result!.knowledgeFileCount).toBeLessThanOrEqual(2);
      expect(result!.knowledgeChars).toBeLessThanOrEqual(800);
    });

    it('should sort files alphabetically', async () => {
      const knowledgeDir = path.join(tempDir, 'knowledge');
      await fs.mkdir(knowledgeDir, { recursive: true });
      await fs.writeFile(path.join(knowledgeDir, 'zebra.md'), '# Zebra');
      await fs.writeFile(path.join(knowledgeDir, 'apple.md'), '# Apple');

      const config: ProjectsConfig = {
        default: { knowledge: [{ dir: 'knowledge' }] },
      };
      const ctx = new ProjectContext(config, tempDir);

      const result = await ctx.loadProject('default');
      const appleIdx = result!.context.indexOf('Apple');
      const zebraIdx = result!.context.indexOf('Zebra');
      expect(appleIdx).toBeLessThan(zebraIdx);
    });

    it('should scan subdirectories recursively', async () => {
      const knowledgeDir = path.join(tempDir, 'knowledge');
      await fs.mkdir(path.join(knowledgeDir, 'sub', 'deep'), { recursive: true });
      await fs.writeFile(path.join(knowledgeDir, 'root.md'), '# Root');
      await fs.writeFile(path.join(knowledgeDir, 'sub', 'level.md'), '# Level');
      await fs.writeFile(path.join(knowledgeDir, 'sub', 'deep', 'deep.md'), '# Deep');

      const config: ProjectsConfig = {
        default: { knowledge: [{ dir: 'knowledge' }] },
      };
      const ctx = new ProjectContext(config, tempDir);

      const result = await ctx.loadProject('default');
      expect(result!.knowledgeFileCount).toBe(3);
      expect(result!.context).toContain('Root');
      expect(result!.context).toContain('Level');
      expect(result!.context).toContain('Deep');
    });
  });

  describe('getProjectNames', () => {
    it('should return all configured project names', () => {
      const config: ProjectsConfig = {
        default: { instructionsPath: 'a.md' },
        'project-a': { instructionsPath: 'b.md' },
        'project-b': { instructionsPath: 'c.md' },
      };
      const ctx = new ProjectContext(config, tempDir);

      const names = ctx.getProjectNames();
      expect(names).toContain('default');
      expect(names).toContain('project-a');
      expect(names).toContain('project-b');
      expect(names).toHaveLength(3);
    });

    it('should exclude active key from project names', () => {
      const config: ProjectsConfig = {
        active: 'default',
        default: { instructionsPath: 'a.md' },
      };
      const ctx = new ProjectContext(config, tempDir);

      const names = ctx.getProjectNames();
      expect(names).toEqual(['default']);
    });

    it('should exclude entries with non-object/non-string values', () => {
      const config: ProjectsConfig = {
        active: 'default',
      } as ProjectsConfig;
      const ctx = new ProjectContext(config, tempDir);

      expect(ctx.getProjectNames()).toEqual([]);
    });
  });

  describe('getActiveProjectName', () => {
    it('should return active project name', () => {
      const config: ProjectsConfig = { active: 'my-project' };
      const ctx = new ProjectContext(config, tempDir);

      expect(ctx.getActiveProjectName()).toBe('my-project');
    });

    it('should return default when no active is set', () => {
      const config: ProjectsConfig = {};
      const ctx = new ProjectContext(config, tempDir);

      expect(ctx.getActiveProjectName()).toBe('default');
    });

    it('should return undefined when no config', () => {
      const ctx = new ProjectContext(undefined, tempDir);
      expect(ctx.getActiveProjectName()).toBeUndefined();
    });
  });

  describe('clearCache', () => {
    it('should clear cached results', async () => {
      const instructionsPath = path.join(tempDir, 'CLAUDE.md');
      await fs.writeFile(instructionsPath, '# Original');

      const config: ProjectsConfig = {
        default: { instructionsPath },
      };
      const ctx = new ProjectContext(config, tempDir);

      const result1 = await ctx.loadProject('default');
      expect(result1!.context).toContain('Original');

      // Update the file
      await fs.writeFile(instructionsPath, '# Updated');
      ctx.clearCache();

      const result2 = await ctx.loadProject('default');
      expect(result2!.context).toContain('Updated');
    });
  });

  describe('combined instructions + knowledge', () => {
    it('should include both instructions and knowledge in context', async () => {
      const instructionsPath = path.join(tempDir, 'CLAUDE.md');
      await fs.writeFile(instructionsPath, '# Project Rules\n\nBe helpful.');

      const knowledgeDir = path.join(tempDir, 'knowledge');
      await fs.mkdir(knowledgeDir, { recursive: true });
      await fs.writeFile(path.join(knowledgeDir, 'data.md'), '# Data\n\nImportant data.');

      const config: ProjectsConfig = {
        default: {
          instructionsPath,
          knowledge: [{ dir: 'knowledge' }],
        },
      };
      const ctx = new ProjectContext(config, tempDir);

      const result = await ctx.loadProject('default');
      expect(result!.hasInstructions).toBe(true);
      expect(result!.knowledgeFileCount).toBe(1);
      expect(result!.context).toContain('Project Rules');
      expect(result!.context).toContain('Important data');
      expect(result!.context).toContain('Project Instructions');
      expect(result!.context).toContain('Project Knowledge Base');
    });
  });
});
