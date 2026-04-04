/**
 * Tests for ResearchModeManager.
 * @see Issue #1709
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { ResearchModeManager } from '../research-mode-manager.js';

describe('ResearchModeManager', () => {
  let testWorkspaceDir: string;
  let manager: ResearchModeManager;

  beforeEach(() => {
    // Create a temporary workspace for testing
    testWorkspaceDir = path.join(process.cwd(), '.test-workspace-' + Date.now());
    mkdirSync(testWorkspaceDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up temporary workspace
    if (existsSync(testWorkspaceDir)) {
      rmSync(testWorkspaceDir, { recursive: true, force: true });
    }
  });

  describe('constructor', () => {
    it('should initialize with default config when no config provided', () => {
      manager = new ResearchModeManager({ baseWorkspaceDir: testWorkspaceDir });
      expect(manager.getMode()).toBe('normal');
      expect(manager.isResearchMode()).toBe(false);
      expect(manager.getTopic()).toBe('');
      expect(manager.isEnabled()).toBe(false);
    });

    it('should initialize with provided config', () => {
      manager = new ResearchModeManager({
        baseWorkspaceDir: testWorkspaceDir,
        config: {
          enabled: true,
          defaultTopic: 'test-topic',
          workspaceSuffix: 'studies',
        },
      });
      expect(manager.isEnabled()).toBe(true);
      expect(manager.getMode()).toBe('normal');
    });
  });

  describe('resolveResearchWorkspaceDir', () => {
    it('should resolve to correct path with default suffix', () => {
      manager = new ResearchModeManager({ baseWorkspaceDir: testWorkspaceDir });
      const result = manager.resolveResearchWorkspaceDir('my-topic');
      expect(result).toBe(path.resolve(testWorkspaceDir, 'research', 'my-topic'));
    });

    it('should resolve to correct path with custom suffix', () => {
      manager = new ResearchModeManager({
        baseWorkspaceDir: testWorkspaceDir,
        config: { workspaceSuffix: 'studies' },
      });
      const result = manager.resolveResearchWorkspaceDir('my-topic');
      expect(result).toBe(path.resolve(testWorkspaceDir, 'studies', 'my-topic'));
    });
  });

  describe('activateResearch', () => {
    it('should fail when research mode is not enabled', () => {
      manager = new ResearchModeManager({ baseWorkspaceDir: testWorkspaceDir });
      const result = manager.activateResearch('test');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not enabled');
      expect(manager.getMode()).toBe('normal');
    });

    it('should activate with default topic when no topic provided', () => {
      manager = new ResearchModeManager({
        baseWorkspaceDir: testWorkspaceDir,
        config: { enabled: true },
      });
      const result = manager.activateResearch();
      expect(result.success).toBe(true);
      expect(manager.getMode()).toBe('research');
      expect(manager.getTopic()).toBe('default');
      expect(result.researchWorkspaceDir).toContain('research');
      expect(result.researchWorkspaceDir).toContain('default');
    });

    it('should activate with custom topic', () => {
      manager = new ResearchModeManager({
        baseWorkspaceDir: testWorkspaceDir,
        config: { enabled: true },
      });
      const result = manager.activateResearch('my-research');
      expect(result.success).toBe(true);
      expect(manager.getTopic()).toBe('my-research');
      expect(result.researchWorkspaceDir).toBe(
        path.resolve(testWorkspaceDir, 'research', 'my-research')
      );
    });

    it('should create research workspace directory on activation', () => {
      manager = new ResearchModeManager({
        baseWorkspaceDir: testWorkspaceDir,
        config: { enabled: true },
      });
      const result = manager.activateResearch('new-topic');
      expect(result.success).toBe(true);
      expect(existsSync(result.researchWorkspaceDir)).toBe(true);
    });

    it('should copy research SOUL template (CLAUDE.md) to new workspace', () => {
      manager = new ResearchModeManager({
        baseWorkspaceDir: testWorkspaceDir,
        config: { enabled: true },
      });
      const result = manager.activateResearch('new-topic');
      expect(result.success).toBe(true);

      const soulPath = path.join(result.researchWorkspaceDir, 'CLAUDE.md');
      expect(existsSync(soulPath)).toBe(true);

      const content = readFileSync(soulPath, 'utf-8');
      expect(content).toContain('Research Mode');
      expect(content).toContain('Research Behavior');
    });

    it('should not overwrite existing CLAUDE.md in research workspace', () => {
      // Pre-create directory with custom CLAUDE.md
      const existingDir = path.resolve(testWorkspaceDir, 'research', 'existing-topic');
      mkdirSync(existingDir, { recursive: true });
      writeFileSync(
        path.join(existingDir, 'CLAUDE.md'),
        '# Custom Research SOUL\nThis is a custom SOUL.',
      );

      manager = new ResearchModeManager({
        baseWorkspaceDir: testWorkspaceDir,
        config: { enabled: true },
      });
      const result = manager.activateResearch('existing-topic');
      expect(result.success).toBe(true);

      const content = readFileSync(path.join(result.researchWorkspaceDir, 'CLAUDE.md'), 'utf-8');
      expect(content).toContain('Custom Research SOUL');
      expect(content).not.toContain('# Research Mode');
    });

    it('should succeed even if directory already exists', () => {
      // Pre-create the directory
      const existingDir = path.resolve(testWorkspaceDir, 'research', 'existing');
      mkdirSync(existingDir, { recursive: true });

      manager = new ResearchModeManager({
        baseWorkspaceDir: testWorkspaceDir,
        config: { enabled: true },
      });
      const result = manager.activateResearch('existing');
      expect(result.success).toBe(true);
    });

    it('should use configured default topic', () => {
      manager = new ResearchModeManager({
        baseWorkspaceDir: testWorkspaceDir,
        config: { enabled: true, defaultTopic: 'my-default' },
      });
      const result = manager.activateResearch();
      expect(result.success).toBe(true);
      expect(manager.getTopic()).toBe('my-default');
    });
  });

  describe('deactivateResearch', () => {
    it('should switch back to normal mode', () => {
      manager = new ResearchModeManager({
        baseWorkspaceDir: testWorkspaceDir,
        config: { enabled: true },
      });
      manager.activateResearch('test');
      expect(manager.isResearchMode()).toBe(true);

      manager.deactivateResearch();
      expect(manager.getMode()).toBe('normal');
      expect(manager.getTopic()).toBe('');
    });

    it('should be no-op when already in normal mode', () => {
      manager = new ResearchModeManager({ baseWorkspaceDir: testWorkspaceDir });
      manager.deactivateResearch(); // Should not throw
      expect(manager.getMode()).toBe('normal');
    });
  });

  describe('getEffectiveCwd', () => {
    it('should return base workspace in normal mode', () => {
      manager = new ResearchModeManager({ baseWorkspaceDir: testWorkspaceDir });
      expect(manager.getEffectiveCwd()).toBe(testWorkspaceDir);
    });

    it('should return research workspace dir in research mode', () => {
      manager = new ResearchModeManager({
        baseWorkspaceDir: testWorkspaceDir,
        config: { enabled: true },
      });
      manager.activateResearch('my-research');
      expect(manager.getEffectiveCwd()).toBe(
        path.resolve(testWorkspaceDir, 'research', 'my-research')
      );
    });

    it('should return base workspace after deactivation', () => {
      manager = new ResearchModeManager({
        baseWorkspaceDir: testWorkspaceDir,
        config: { enabled: true },
      });
      manager.activateResearch('test');
      manager.deactivateResearch();
      expect(manager.getEffectiveCwd()).toBe(testWorkspaceDir);
    });
  });

  describe('getState', () => {
    it('should return a copy of the state', () => {
      manager = new ResearchModeManager({
        baseWorkspaceDir: testWorkspaceDir,
        config: { enabled: true },
      });
      manager.activateResearch('test');

      const state1 = manager.getState();
      const state2 = manager.getState();
      expect(state1).toEqual(state2);
      expect(state1).not.toBe(state2); // Different object references
    });
  });

  describe('researchWorkspaceExists', () => {
    it('should return false for non-existent topic', () => {
      manager = new ResearchModeManager({
        baseWorkspaceDir: testWorkspaceDir,
        config: { enabled: true },
      });
      expect(manager.researchWorkspaceExists('nonexistent')).toBe(false);
    });

    it('should return true for existing topic', () => {
      const dir = path.resolve(testWorkspaceDir, 'research', 'existing');
      mkdirSync(dir, { recursive: true });

      manager = new ResearchModeManager({
        baseWorkspaceDir: testWorkspaceDir,
        config: { enabled: true },
      });
      expect(manager.researchWorkspaceExists('existing')).toBe(true);
    });
  });

  describe('listResearchTopics', () => {
    it('should return empty array when no research root exists', () => {
      manager = new ResearchModeManager({
        baseWorkspaceDir: testWorkspaceDir,
        config: { enabled: true },
      });
      expect(manager.listResearchTopics()).toEqual([]);
    });

    it('should list existing research topic directories', () => {
      mkdirSync(path.resolve(testWorkspaceDir, 'research', 'topic-a'), { recursive: true });
      mkdirSync(path.resolve(testWorkspaceDir, 'research', 'topic-b'), { recursive: true });
      writeFileSync(path.resolve(testWorkspaceDir, 'research', 'file.txt'), 'test');

      manager = new ResearchModeManager({
        baseWorkspaceDir: testWorkspaceDir,
        config: { enabled: true },
      });
      const topics = manager.listResearchTopics();
      expect(topics).toContain('topic-a');
      expect(topics).toContain('topic-b');
      expect(topics).not.toContain('file.txt');
    });
  });

  describe('mode switching lifecycle', () => {
    it('should support multiple activate/deactivate cycles', () => {
      manager = new ResearchModeManager({
        baseWorkspaceDir: testWorkspaceDir,
        config: { enabled: true },
      });

      // First cycle
      manager.activateResearch('topic-1');
      expect(manager.getTopic()).toBe('topic-1');
      expect(manager.getEffectiveCwd()).toContain('topic-1');

      manager.deactivateResearch();
      expect(manager.getMode()).toBe('normal');

      // Second cycle with different topic
      manager.activateResearch('topic-2');
      expect(manager.getTopic()).toBe('topic-2');
      expect(manager.getEffectiveCwd()).toContain('topic-2');

      manager.deactivateResearch();
      expect(manager.getMode()).toBe('normal');
    });

    it('should allow switching between research topics', () => {
      manager = new ResearchModeManager({
        baseWorkspaceDir: testWorkspaceDir,
        config: { enabled: true },
      });

      manager.activateResearch('topic-a');
      expect(manager.getTopic()).toBe('topic-a');

      // Switch to different topic
      manager.activateResearch('topic-b');
      expect(manager.getTopic()).toBe('topic-b');
      expect(manager.isResearchMode()).toBe(true);
    });
  });
});
