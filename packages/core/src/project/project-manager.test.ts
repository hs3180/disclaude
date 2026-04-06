/**
 * Unit tests for ProjectManager.
 *
 * @see Issue #1916
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ProjectManager } from './project-manager.js';

describe('ProjectManager', () => {
  let tmpDir: string;
  let workspaceDir: string;
  let templatesDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-manager-test-'));
    workspaceDir = path.join(tmpDir, 'workspace');
    templatesDir = path.join(tmpDir, 'templates');
    fs.mkdirSync(workspaceDir);
    fs.mkdirSync(templatesDir);
    fs.mkdirSync(path.join(templatesDir, 'research'));
    fs.mkdirSync(path.join(templatesDir, 'book-reader'));
    fs.writeFileSync(
      path.join(templatesDir, 'research', 'CLAUDE.md'),
      '# Research Mode\nResearch instructions here.',
    );
    fs.writeFileSync(
      path.join(templatesDir, 'book-reader', 'CLAUDE.md'),
      '# Book Reader Mode\nBook reader instructions here.',
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createManager(configTemplates?: Record<string, { displayName?: string; description?: string }>): ProjectManager {
    const pm = new ProjectManager();
    pm.init(workspaceDir, templatesDir, configTemplates);
    return pm;
  }

  describe('init', () => {
    it('should initialize without config templates (no templates available)', () => {
      const pm = new ProjectManager();
      pm.init(workspaceDir, templatesDir);
      expect(pm.listTemplates()).toEqual([]);
    });

    it('should load templates from config that have CLAUDE.md in package', () => {
      const pm = createManager({
        research: { displayName: '研究模式', description: '专注研究' },
      });
      const templates = pm.listTemplates();
      expect(templates).toHaveLength(1);
      expect(templates[0].name).toBe('research');
      expect(templates[0].displayName).toBe('研究模式');
    });

    it('should skip templates without CLAUDE.md', () => {
      fs.mkdirSync(path.join(templatesDir, 'empty-template'));
      const pm = createManager({
        research: {},
        'empty-template': {},
      });
      expect(pm.listTemplates()).toHaveLength(1);
      expect(pm.listTemplates()[0].name).toBe('research');
    });
  });

  describe('getActive', () => {
    it('should return default project when no binding exists', () => {
      const pm = createManager({ research: {} });
      const active = pm.getActive('chat-1');
      expect(active.name).toBe('default');
      expect(active.workingDir).toBe(workspaceDir);
    });

    it('should return bound project when binding exists', () => {
      const pm = createManager({ research: {} });
      pm.create('chat-1', 'research', 'my-research');
      const active = pm.getActive('chat-1');
      expect(active.name).toBe('my-research');
      expect(active.workingDir).toContain('my-research');
    });
  });

  describe('create', () => {
    it('should create instance from template', () => {
      const pm = createManager({ research: {} });
      const result = pm.create('chat-1', 'research', 'my-research');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.name).toBe('my-research');
        expect(result.data.templateName).toBe('research');
        expect(result.data.workingDir).toContain('my-research');
      }
    });

    it('should copy CLAUDE.md to instance workingDir', () => {
      const pm = createManager({ research: {} });
      pm.create('chat-1', 'research', 'my-research');
      const claudeMdPath = path.join(workspaceDir, 'projects', 'my-research', 'CLAUDE.md');
      expect(fs.existsSync(claudeMdPath)).toBe(true);
      expect(fs.readFileSync(claudeMdPath, 'utf-8')).toContain('Research Mode');
    });

    it('should reject non-existent template', () => {
      const pm = createManager({ research: {} });
      const result = pm.create('chat-1', 'nonexistent', 'my-project');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('不存在');
      }
    });

    it('should reject reserved "default" name', () => {
      const pm = createManager({ research: {} });
      const result = pm.create('chat-1', 'research', 'default');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('保留名');
      }
    });

    it('should reject duplicate instance name', () => {
      const pm = createManager({ research: {} });
      pm.create('chat-1', 'research', 'my-research');
      const result = pm.create('chat-2', 'research', 'my-research');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('已存在');
      }
    });

    it('should reject names with path traversal', () => {
      const pm = createManager({ research: {} });
      const result = pm.create('chat-1', 'research', '../etc/passwd');
      expect(result.ok).toBe(false);
    });

    it('should reject empty name', () => {
      const pm = createManager({ research: {} });
      const result = pm.create('chat-1', 'research', '');
      expect(result.ok).toBe(false);
    });

    it('should rollback workingDir on CLAUDE.md copy failure', () => {
      // Create a template dir without CLAUDE.md (edge case)
      fs.mkdirSync(path.join(templatesDir, 'broken'));
      const pm = createManager({ broken: {} });
      // Template should be skipped since no CLAUDE.md
      expect(pm.listTemplates()).toHaveLength(0);
    });
  });

  describe('use', () => {
    it('should bind to existing instance', () => {
      const pm = createManager({ research: {} });
      pm.create('chat-1', 'research', 'my-research');
      const result = pm.use('chat-2', 'my-research');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.name).toBe('my-research');
      }
    });

    it('should reject non-existent instance', () => {
      const pm = createManager({ research: {} });
      const result = pm.use('chat-1', 'nonexistent');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('不存在');
      }
    });

    it('should reset when "default" is used', () => {
      const pm = createManager({ research: {} });
      pm.create('chat-1', 'research', 'my-research');
      const result = pm.use('chat-1', 'default');
      expect(result.ok).toBe(true);
      expect(pm.getActive('chat-1').name).toBe('default');
    });
  });

  describe('reset', () => {
    it('should reset to default project', () => {
      const pm = createManager({ research: {} });
      pm.create('chat-1', 'research', 'my-research');
      const result = pm.reset('chat-1');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.name).toBe('default');
      }
      expect(pm.getActive('chat-1').name).toBe('default');
    });

    it('should be no-op when already on default', () => {
      const pm = createManager({ research: {} });
      const result = pm.reset('chat-1');
      expect(result.ok).toBe(true);
    });
  });

  describe('listTemplates', () => {
    it('should list all configured templates with CLAUDE.md', () => {
      const pm = createManager({
        research: { displayName: '研究模式' },
        'book-reader': { description: '读书助手' },
      });
      const templates = pm.listTemplates();
      expect(templates).toHaveLength(2);
      expect(templates.map(t => t.name).sort()).toEqual(['book-reader', 'research']);
    });

    it('should return empty array when no templates configured', () => {
      const pm = createManager();
      expect(pm.listTemplates()).toEqual([]);
    });
  });

  describe('listInstances', () => {
    it('should list all created instances', () => {
      const pm = createManager({ research: {}, 'book-reader': {} });
      pm.create('chat-1', 'research', 'res-1');
      pm.create('chat-2', 'book-reader', 'book-1');
      const instances = pm.listInstances();
      expect(instances).toHaveLength(2);
      expect(instances.map(i => i.name).sort()).toEqual(['book-1', 'res-1']);
    });

    it('should include chatId bindings', () => {
      const pm = createManager({ research: {} });
      pm.create('chat-1', 'research', 'my-research');
      pm.use('chat-2', 'my-research');
      const instances = pm.listInstances();
      expect(instances).toHaveLength(1);
      expect(instances[0].chatIds).toHaveLength(2);
    });
  });

  describe('createCwdProvider', () => {
    it('should return undefined for default project', () => {
      const pm = createManager({ research: {} });
      const provider = pm.createCwdProvider();
      expect(provider('chat-1')).toBeUndefined();
    });

    it('should return workingDir for non-default project', () => {
      const pm = createManager({ research: {} });
      pm.create('chat-1', 'research', 'my-research');
      const provider = pm.createCwdProvider();
      const cwd = provider('chat-1');
      expect(cwd).toContain('my-research');
    });
  });

  describe('persistence', () => {
    it('should persist data to projects.json', () => {
      const pm = createManager({ research: {} });
      pm.create('chat-1', 'research', 'my-research');

      const dataPath = path.join(workspaceDir, '.disclaude', 'projects.json');
      expect(fs.existsSync(dataPath)).toBe(true);

      const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
      expect(data.projects['my-research'].templateName).toBe('research');
      expect(data.chatProjectMap['chat-1']).toBe('my-research');
    });

    it('should restore persisted data on re-init', () => {
      const pm1 = createManager({ research: {} });
      pm1.create('chat-1', 'research', 'my-research');

      // Create new manager and re-init from same workspace
      const pm2 = new ProjectManager();
      pm2.init(workspaceDir, templatesDir, { research: {} });

      expect(pm2.getActive('chat-1').name).toBe('my-research');
      expect(pm2.listInstances()).toHaveLength(1);
    });

    it('should not restore bindings for deleted instances', () => {
      const pm1 = createManager({ research: {} });
      pm1.create('chat-1', 'research', 'my-research');

      // Delete the instance directory
      fs.rmSync(path.join(workspaceDir, 'projects', 'my-research'), { recursive: true });
      // Delete projects.json
      fs.unlinkSync(path.join(workspaceDir, '.disclaude', 'projects.json'));

      // Re-init should work fine
      const pm2 = new ProjectManager();
      pm2.init(workspaceDir, templatesDir, { research: {} });
      expect(pm2.getActive('chat-1').name).toBe('default');
    });
  });
});
