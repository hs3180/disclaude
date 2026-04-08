/**
 * Unit tests for ProjectManager
 *
 * @see Issue #1916 - Feature: 统一 ProjectContext 系统
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ProjectManager } from './project-manager.js';
import type { ProjectTemplatesConfig } from './types.js';
import { createLogger } from '../utils/logger.js';

describe('ProjectManager', () => {
  let workspaceDir: string;
  let packageDir: string;
  let templateDir: string;
  let pm: ProjectManager;
  let logger: ReturnType<typeof createLogger>;

  beforeEach(async () => {
    // Create isolated temp directories for each test
    workspaceDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pm-workspace-'));
    packageDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pm-package-'));

    // Create a template with CLAUDE.md
    templateDir = path.join(packageDir, 'templates', 'research');
    await fs.promises.mkdir(templateDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(templateDir, 'CLAUDE.md'),
      '# Research Mode\n\nYou are in research mode.',
    );

    logger = createLogger('TestProjectManager');
    pm = new ProjectManager({
      workspaceDir,
      packageDir,
      logger,
    });
  });

  afterEach(async () => {
    // Clean up temp directories
    await fs.promises.rm(workspaceDir, { recursive: true, force: true });
    await fs.promises.rm(packageDir, { recursive: true, force: true });
  });

  describe('init', () => {
    it('should initialize without templates config', () => {
      pm.init();
      expect(pm.listTemplates()).toEqual([]);
    });

    it('should load templates from config', () => {
      const config: ProjectTemplatesConfig = {
        research: {
          displayName: '研究模式',
          description: '专注研究的独立空间',
        },
      };
      pm.init(config);
      const templates = pm.listTemplates();
      expect(templates).toHaveLength(1);
      expect(templates[0].name).toBe('research');
      expect(templates[0].displayName).toBe('研究模式');
      expect(templates[0].description).toBe('专注研究的独立空间');
    });

    it('should load multiple templates', () => {
      const config: ProjectTemplatesConfig = {
        research: { displayName: '研究模式' },
        'book-reader': { displayName: '读书助手' },
      };
      pm.init(config);
      expect(pm.listTemplates()).toHaveLength(2);
    });

    it('should load persisted data from projects.json', async () => {
      // Create persisted data
      const disclaudeDir = path.join(workspaceDir, '.disclaude');
      await fs.promises.mkdir(disclaudeDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(disclaudeDir, 'projects.json'),
        JSON.stringify({
          projects: {
            'my-research': {
              templateName: 'research',
              workingDir: path.join(workspaceDir, 'projects', 'my-research'),
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          },
          chatProjectMap: {
            'chat-123': 'my-research',
          },
        }),
      );

      const config: ProjectTemplatesConfig = { research: {} };
      pm.init(config);

      const instances = pm.listInstances();
      expect(instances).toHaveLength(1);
      expect(instances[0].name).toBe('my-research');
      expect(instances[0].chatIds).toEqual(['chat-123']);

      // getActive should return the persisted instance
      const active = pm.getActive('chat-123');
      expect(active.name).toBe('my-research');
    });

    it('should start fresh when no projects.json exists', () => {
      const config: ProjectTemplatesConfig = { research: {} };
      pm.init(config);
      expect(pm.listInstances()).toEqual([]);
    });
  });

  describe('getActive', () => {
    it('should return default config when no binding exists', () => {
      pm.init();
      const config = pm.getActive('chat-123');
      expect(config.name).toBe('default');
      expect(config.workingDir).toBe(workspaceDir);
    });

    it('should return default config for unbound chatId after init', () => {
      pm.init({ research: {} });
      const config = pm.getActive('unknown-chat');
      expect(config.name).toBe('default');
      expect(config.workingDir).toBe(workspaceDir);
    });

    it('should return bound instance when binding exists', () => {
      pm.init({ research: {} });
      const result = pm.create('chat-123', 'research', 'my-research');
      expect(result.ok).toBe(true);

      const config = pm.getActive('chat-123');
      expect(config.name).toBe('my-research');
      expect(config.templateName).toBe('research');
      expect(config.workingDir).toContain('my-research');
    });

    it('should fall back to default when binding references non-existent instance', async () => {
      // Create persisted data with a binding to a non-existent instance
      const disclaudeDir = path.join(workspaceDir, '.disclaude');
      await fs.promises.mkdir(disclaudeDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(disclaudeDir, 'projects.json'),
        JSON.stringify({
          projects: {},
          chatProjectMap: { 'chat-123': 'deleted-instance' },
        }),
      );

      pm.init();
      const config = pm.getActive('chat-123');
      expect(config.name).toBe('default');
    });
  });

  describe('create', () => {
    beforeEach(() => {
      pm.init({ research: {} });
    });

    it('should create an instance from a template', () => {
      const result = pm.create('chat-123', 'research', 'my-research');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.name).toBe('my-research');
        expect(result.data.templateName).toBe('research');
        expect(result.data.workingDir).toContain('my-research');
      }
    });

    it('should create working directory and copy CLAUDE.md', async () => {
      const result = pm.create('chat-123', 'research', 'my-research');
      expect(result.ok).toBe(true);

      // Verify working directory was created
      const workingDir = path.join(workspaceDir, 'projects', 'my-research');
      const stat = await fs.promises.stat(workingDir);
      expect(stat.isDirectory()).toBe(true);

      // Verify CLAUDE.md was copied
      const claudeMd = await fs.promises.readFile(
        path.join(workingDir, 'CLAUDE.md'),
        'utf-8',
      );
      expect(claudeMd).toContain('Research Mode');
    });

    it('should bind chatId to the created instance', () => {
      pm.create('chat-123', 'research', 'my-research');
      const active = pm.getActive('chat-123');
      expect(active.name).toBe('my-research');
    });

    it('should reject non-existent template', () => {
      const result = pm.create('chat-123', 'nonexistent', 'my-research');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('不存在');
      }
    });

    it('should reject "default" as instance name', () => {
      const result = pm.create('chat-123', 'research', 'default');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('保留名');
      }
    });

    it('should reject duplicate instance name', () => {
      pm.create('chat-123', 'research', 'my-research');
      const result = pm.create('chat-456', 'research', 'my-research');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('已存在');
      }
    });

    it('should persist after creation', async () => {
      pm.create('chat-123', 'research', 'my-research');

      // Verify projects.json was created
      const persistPath = path.join(workspaceDir, '.disclaude', 'projects.json');
      const content = await fs.promises.readFile(persistPath, 'utf-8');
      const data = JSON.parse(content);
      expect(data.projects['my-research']).toBeDefined();
      expect(data.chatProjectMap['chat-123']).toBe('my-research');
    });

    it('should rollback working directory on CLAUDE.md copy failure', async () => {
      // Create a ProjectManager without packageDir to cause copy failure
      const pmNoPackage = new ProjectManager({
        workspaceDir,
        logger,
      });
      pmNoPackage.init({ research: {} });

      // Create a template dir that doesn't have CLAUDE.md
      const templateDir2 = path.join(workspaceDir, 'templates', 'research');
      await fs.promises.mkdir(templateDir2, { recursive: true });
      // No CLAUDE.md created

      // Override packageDir to point to workspace (no templates/research/CLAUDE.md)
      const pmWithBadTemplate = new ProjectManager({
        workspaceDir,
        packageDir: workspaceDir, // no templates/research/CLAUDE.md here
        logger,
      });
      pmWithBadTemplate.init({ research: {} });

      const result = pmWithBadTemplate.create('chat-123', 'research', 'my-research');
      expect(result.ok).toBe(false);

      // Working directory should be cleaned up
      const workingDir = path.join(workspaceDir, 'projects', 'my-research');
      let exists = true;
      try {
        await fs.promises.access(workingDir);
      } catch {
        exists = false;
      }
      // After rollback, directory should be removed
      expect(exists).toBe(false);
    });
  });

  describe('use', () => {
    beforeEach(() => {
      pm.init({ research: {} });
    });

    it('should bind chatId to existing instance', () => {
      pm.create('chat-123', 'research', 'my-research');
      const result = pm.use('chat-456', 'my-research');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.name).toBe('my-research');
      }

      // Both chatIds should now point to the same instance
      expect(pm.getActive('chat-123').name).toBe('my-research');
      expect(pm.getActive('chat-456').name).toBe('my-research');
    });

    it('should reject non-existent instance', () => {
      const result = pm.use('chat-123', 'nonexistent');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('不存在');
      }
    });

    it('should reject "default" as instance name', () => {
      const result = pm.use('chat-123', 'default');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('reset');
      }
    });

    it('should persist after use', async () => {
      pm.create('chat-123', 'research', 'my-research');
      pm.use('chat-456', 'my-research');

      const persistPath = path.join(workspaceDir, '.disclaude', 'projects.json');
      const content = await fs.promises.readFile(persistPath, 'utf-8');
      const data = JSON.parse(content);
      expect(data.chatProjectMap['chat-456']).toBe('my-research');
    });
  });

  describe('reset', () => {
    beforeEach(() => {
      pm.init({ research: {} });
    });

    it('should reset chatId to default project', () => {
      pm.create('chat-123', 'research', 'my-research');
      expect(pm.getActive('chat-123').name).toBe('my-research');

      const result = pm.reset('chat-123');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.name).toBe('default');
      }

      expect(pm.getActive('chat-123').name).toBe('default');
    });

    it('should be no-op when already on default', () => {
      const result = pm.reset('chat-123');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.name).toBe('default');
      }
    });

    it('should not affect other chatIds', () => {
      pm.create('chat-123', 'research', 'my-research');
      pm.create('chat-456', 'research', 'other-research');
      pm.reset('chat-123');

      expect(pm.getActive('chat-123').name).toBe('default');
      expect(pm.getActive('chat-456').name).toBe('other-research');
    });

    it('should persist after reset', async () => {
      pm.create('chat-123', 'research', 'my-research');
      pm.reset('chat-123');

      const persistPath = path.join(workspaceDir, '.disclaude', 'projects.json');
      const content = await fs.promises.readFile(persistPath, 'utf-8');
      const data = JSON.parse(content);
      expect(data.chatProjectMap['chat-123']).toBeUndefined();
    });
  });

  describe('listTemplates', () => {
    it('should return empty array when no templates configured', () => {
      pm.init();
      expect(pm.listTemplates()).toEqual([]);
    });

    it('should return configured templates', () => {
      pm.init({
        research: { displayName: '研究模式', description: '专注研究' },
        'book-reader': { displayName: '读书助手' },
      });
      const templates = pm.listTemplates();
      expect(templates).toHaveLength(2);
      expect(templates.map((t) => t.name)).toEqual(['research', 'book-reader']);
    });
  });

  describe('listInstances', () => {
    beforeEach(() => {
      pm.init({ research: {} });
    });

    it('should return empty array when no instances exist', () => {
      expect(pm.listInstances()).toEqual([]);
    });

    it('should return all created instances', () => {
      pm.create('chat-123', 'research', 'research-1');
      pm.create('chat-456', 'research', 'research-2');

      const instances = pm.listInstances();
      expect(instances).toHaveLength(2);
      expect(instances.map((i) => i.name).sort()).toEqual(['research-1', 'research-2']);
    });

    it('should include chatIds bound to each instance', () => {
      pm.create('chat-123', 'research', 'my-research');
      pm.use('chat-456', 'my-research');

      const instances = pm.listInstances();
      expect(instances).toHaveLength(1);
      expect(instances[0].chatIds.sort()).toEqual(['chat-123', 'chat-456']);
    });

    it('should include createdAt timestamp', () => {
      const before = new Date().toISOString();
      pm.create('chat-123', 'research', 'my-research');
      const after = new Date().toISOString();

      const instances = pm.listInstances();
      expect(instances).toHaveLength(1);
      expect(instances[0].createdAt >= before).toBe(true);
      expect(instances[0].createdAt <= after).toBe(true);
    });
  });

  describe('createCwdProvider', () => {
    it('should return undefined for default project', () => {
      pm.init();
      const provider = pm.createCwdProvider();
      expect(provider('chat-123')).toBeUndefined();
    });

    it('should return workingDir for non-default project', () => {
      pm.init({ research: {} });
      pm.create('chat-123', 'research', 'my-research');

      const provider = pm.createCwdProvider();
      const cwd = provider('chat-123');
      expect(cwd).toContain('my-research');
    });

    it('should return undefined after reset', () => {
      pm.init({ research: {} });
      pm.create('chat-123', 'research', 'my-research');
      pm.reset('chat-123');

      const provider = pm.createCwdProvider();
      expect(provider('chat-123')).toBeUndefined();
    });
  });

  describe('persistence', () => {
    it('should persist and restore state across restarts', () => {
      // First session: create an instance
      pm.init({ research: {} });
      pm.create('chat-123', 'research', 'my-research');
      pm.use('chat-456', 'my-research');

      // Simulate restart: create new ProjectManager
      const pm2 = new ProjectManager({
        workspaceDir,
        packageDir,
        logger,
      });
      pm2.init({ research: {} });

      // Verify state was restored
      expect(pm2.getActive('chat-123').name).toBe('my-research');
      expect(pm2.getActive('chat-456').name).toBe('my-research');
      expect(pm2.listInstances()).toHaveLength(1);
    });

    it('should use atomic write (write-then-rename)', async () => {
      pm.init({ research: {} });
      pm.create('chat-123', 'research', 'my-research');

      // No .tmp file should remain
      const tmpPath = path.join(workspaceDir, '.disclaude', 'projects.json.tmp');
      let exists = true;
      try {
        await fs.promises.access(tmpPath);
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle empty chatId', () => {
      pm.init({ research: {} });
      const config = pm.getActive('');
      expect(config.name).toBe('default');
    });

    it('should handle special characters in instance name', () => {
      pm.init({ research: {} });
      const result = pm.create('chat-123', 'research', 'my-research-v2');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.name).toBe('my-research-v2');
      }
    });

    it('should allow rebinding a chatId to a different instance', () => {
      pm.init({ research: {} });
      pm.create('chat-123', 'research', 'research-1');
      pm.create('chat-456', 'research', 'research-2');

      // Bind chat-123 to research-2 (was on research-1)
      const result = pm.use('chat-123', 'research-2');
      expect(result.ok).toBe(true);

      expect(pm.getActive('chat-123').name).toBe('research-2');
    });

    it('should list instances with correct binding count after rebinding', () => {
      pm.init({ research: {} });
      pm.create('chat-123', 'research', 'research-1');
      pm.create('chat-456', 'research', 'research-2');

      // chat-123 moves from research-1 to research-2
      pm.use('chat-123', 'research-2');

      const instances = pm.listInstances();
      const r1 = instances.find((i) => i.name === 'research-1');
      const r2 = instances.find((i) => i.name === 'research-2');

      expect(r1?.chatIds).toEqual([]);
      expect(r2?.chatIds.sort()).toEqual(['chat-123', 'chat-456']);
    });
  });
});
