/**
 * Tests for SkillAgentManager.
 *
 * Tests the Skill Agent System (Issue #455):
 * - Starting skill agents
 * - Listing agents
 * - Stopping agents
 * - State persistence
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { SkillAgentManager, getSkillAgentManager } from './skill-agent-manager.js';
import type { BaseAgentConfig } from './types.js';

// Mock SkillAgent to avoid actual SDK calls
vi.mock('./skill-agent.js', () => ({
  SkillAgent: class MockSkillAgent {
    readonly type = 'skill' as const;
    readonly name: string;

    constructor(_config: unknown, skillPath: string) {
      this.name = path.basename(skillPath, '.md');
    }

    initialize() {}

    async *executeWithContext(_options: unknown) {
      // Simulate async execution
      await new Promise(resolve => setTimeout(resolve, 10));
      yield { content: 'Test result from mock agent' };
    }

    dispose() {}
  },
}));

// Mock Config module
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: () => '/tmp/skill-agent-manager-test-workspace',
  },
}));

describe('SkillAgentManager', () => {
  let manager: SkillAgentManager;
  let tempDir: string;
  let skillPath: string;
  let agentConfig: BaseAgentConfig;

  beforeEach(async () => {
    // Create temp directory for test workspace
    tempDir = '/tmp/skill-agent-manager-test-workspace';
    await fs.mkdir(tempDir, { recursive: true });

    // Create a test skill file
    skillPath = path.join(tempDir, 'test-skill.md');
    await fs.writeFile(skillPath, '# Test Skill\n\nTest content');

    agentConfig = {
      apiKey: 'test-api-key',
      model: 'claude-3-5-sonnet-20241022',
      provider: 'anthropic',
    };

    manager = new SkillAgentManager(agentConfig);
  });

  afterEach(async () => {
    manager.dispose();
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe('start', () => {
    it('should start a skill agent and return agent ID', async () => {
      const agentId = await manager.start({
        skillPath,
        templateVars: { taskId: 'task-123' },
      });

      expect(agentId).toBeDefined();
      expect(agentId).toMatch(/^[0-9a-f-]{36}$/); // UUID format

      const info = manager.get(agentId);
      expect(info).toBeDefined();
      expect(info?.name).toBe('test-skill');
      expect(info?.status).toBe('running');
    });

    it('should store chatId for result notification', async () => {
      const agentId = await manager.start({
        skillPath,
        chatId: 'oc_test_chat',
      });

      const info = manager.get(agentId);
      expect(info?.chatId).toBe('oc_test_chat');
    });

    it('should store template variables', async () => {
      const templateVars = { taskId: 'task-123', iteration: '1' };

      const agentId = await manager.start({
        skillPath,
        templateVars,
      });

      const info = manager.get(agentId);
      expect(info?.templateVars).toEqual(templateVars);
    });

    it('should throw error for non-existent skill file', async () => {
      await expect(manager.start({
        skillPath: '/non/existent/skill.md',
      })).rejects.toThrow('Skill file not found');
    });
  });

  describe('list', () => {
    it('should return empty array when no agents', () => {
      const agents = manager.list();
      expect(agents).toEqual([]);
    });

    it('should list all agents', async () => {
      await manager.start({ skillPath });
      await manager.start({ skillPath });

      const agents = manager.list();
      expect(agents.length).toBe(2);
    });

    it('should filter agents by status', async () => {
      // Start agents
      const id1 = await manager.start({ skillPath });

      // Manually set one to completed
      const info = manager.get(id1);
      if (info) {
        (info as { status: string }).status = 'completed';
      }

      const runningAgents = manager.list('running');
      const completedAgents = manager.list('completed');

      expect(runningAgents.length).toBe(0);
      expect(completedAgents.length).toBe(1);
    });
  });

  describe('get', () => {
    it('should return undefined for non-existent agent', () => {
      const info = manager.get('non-existent-id');
      expect(info).toBeUndefined();
    });

    it('should return agent info', async () => {
      const agentId = await manager.start({ skillPath });

      const info = manager.get(agentId);
      expect(info).toBeDefined();
      expect(info?.id).toBe(agentId);
      expect(info?.startedAt).toBeDefined();
    });
  });

  describe('stop', () => {
    it('should throw error for non-existent agent', async () => {
      await expect(manager.stop('non-existent-id')).rejects.toThrow('not found');
    });

    it('should throw error for non-running agent', async () => {
      const agentId = await manager.start({ skillPath });

      // Manually set status to completed
      const info = manager.get(agentId);
      if (info) {
        (info as { status: string }).status = 'completed';
      }

      await expect(manager.stop(agentId)).rejects.toThrow('not running');
    });

    it('should stop a running agent', async () => {
      const agentId = await manager.start({ skillPath });

      // Agent should be running
      expect(manager.get(agentId)?.status).toBe('running');

      // Stop the agent
      await manager.stop(agentId);

      // Agent should be stopped
      expect(manager.get(agentId)?.status).toBe('stopped');
    });
  });

  describe('clearHistory', () => {
    it('should clear completed and failed agents', async () => {
      const agentId = await manager.start({ skillPath });

      // Manually set status to completed
      const info = manager.get(agentId);
      if (info) {
        (info as { status: string }).status = 'completed';
      }

      await manager.clearHistory();

      const agents = manager.list();
      expect(agents.length).toBe(0);
    });

    it('should keep running agents', async () => {
      await manager.start({ skillPath });

      await manager.clearHistory();

      const agents = manager.list();
      expect(agents.length).toBe(1);
      expect(agents[0].status).toBe('running');
    });
  });

  describe('dispose', () => {
    it('should dispose all resources without error', async () => {
      await manager.start({ skillPath });
      await manager.start({ skillPath });

      // Should not throw
      manager.dispose();
      expect(true).toBe(true);
    });

    it('should prevent starting new agents after dispose', async () => {
      manager.dispose();

      await expect(manager.start({ skillPath })).rejects.toThrow('disposed');
    });
  });

  describe('getSkillAgentManager', () => {
    it('should return the global manager instance', () => {
      expect(getSkillAgentManager()).toBe(manager);
    });

    it('should return null after dispose', () => {
      manager.dispose();
      expect(getSkillAgentManager()).toBeNull();
    });
  });
});
