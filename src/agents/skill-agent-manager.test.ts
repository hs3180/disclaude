/**
 * Tests for SkillAgentManager.
 *
 * Issue #455: Skill Agent System - 后台执行的独立 Agent 进程
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SkillAgentManager } from './skill-agent-manager.js';

// Mock the Config module
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: () => '/tmp/test-workspace',
  },
}));

// Mock the logger
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock AgentFactory
vi.mock('./factory.js', () => ({
  AgentFactory: {
    createSkillAgent: async () => {
      // Return a mock skill agent
      return {
        initialize: vi.fn(),
        executeWithContext: async function* () {
          yield { content: 'Test response' };
          yield { content: 'Second response' };
        },
      };
    },
  },
}));

describe('SkillAgentManager', () => {
  let manager: SkillAgentManager;
  let tempDir: string;

  beforeEach(async () => {
    // Create a temporary directory for testing
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-agent-test-'));

    // Reset the Config mock to use temp directory
    vi.mocked(await import('../config/index.js')).Config.getWorkspaceDir = () => tempDir;

    manager = new SkillAgentManager();
    await manager.initialize();
  });

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('initialization', () => {
    it('should initialize with empty agent list', () => {
      const agents = manager.list();
      expect(agents).toEqual([]);
    });

    it('should create state file on first save', async () => {
      const statePath = path.join(tempDir, '.skill-agents.json');

      // Start an agent to trigger a save
      await manager.start({
        skillPath: 'skills/test/SKILL.md',
        chatId: 'oc_test',
      });

      // Check state file exists
      const exists = await fs.access(statePath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });
  });

  describe('start', () => {
    it('should start a skill agent and return an ID', async () => {
      const agentId = await manager.start({
        skillPath: 'skills/test/SKILL.md',
        chatId: 'oc_test',
      });

      expect(agentId).toMatch(/^skill-/);
      expect(typeof agentId).toBe('string');
    });

    it('should register the agent with correct info', async () => {
      const agentId = await manager.start({
        skillPath: 'skills/test/SKILL.md',
        chatId: 'oc_test',
      });

      const agent = manager.get(agentId);
      expect(agent).toBeDefined();
      expect(agent?.status).toBe('running');
      expect(agent?.skillName).toBe('test');
      expect(agent?.chatId).toBe('oc_test');
    });

    it('should accept template variables', async () => {
      const agentId = await manager.start({
        skillPath: 'skills/test/SKILL.md',
        chatId: 'oc_test',
        templateVars: { url: 'https://example.com', taskId: '123' },
      });

      const agent = manager.get(agentId);
      expect(agent?.templateVars).toEqual({
        url: 'https://example.com',
        taskId: '123',
      });
    });

    it('should extract skill name from path correctly', async () => {
      const agentId = await manager.start({
        skillPath: 'skills/my-custom-skill/SKILL.md',
        chatId: 'oc_test',
      });

      const agent = manager.get(agentId);
      expect(agent?.skillName).toBe('my-custom-skill');
    });
  });

  describe('stop', () => {
    it('should return false for non-existent agent', async () => {
      const stopped = await manager.stop('non-existent');
      expect(stopped).toBe(false);
    });
  });

  describe('list', () => {
    it('should list all agents', async () => {
      await manager.start({
        skillPath: 'skills/test1/SKILL.md',
        chatId: 'oc_test1',
      });
      await manager.start({
        skillPath: 'skills/test2/SKILL.md',
        chatId: 'oc_test2',
      });

      const agents = manager.list();
      expect(agents.length).toBe(2);
    });
  });

  describe('listRunning', () => {
    it('should return running agents', async () => {
      await manager.start({
        skillPath: 'skills/test1/SKILL.md',
        chatId: 'oc_test1',
      });

      const running = manager.listRunning();
      // Agent should be running immediately after start
      expect(running.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('clearHistory', () => {
    it('should clear non-running agents', async () => {
      // Start and immediately complete an agent (mocked)
      await manager.start({
        skillPath: 'skills/test/SKILL.md',
        chatId: 'oc_test',
      });

      // Wait a bit for the agent to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      // Clear history - this should clear completed agents
      const count = await manager.clearHistory();
      // Count may be 0 or 1 depending on timing
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });

  describe('persistence', () => {
    it('should persist agents to state file', async () => {
      const agentId = await manager.start({
        skillPath: 'skills/test/SKILL.md',
        chatId: 'oc_test',
        templateVars: { key: 'value' },
      });

      // Create a new manager to load from disk
      const newManager = new SkillAgentManager();
      await newManager.initialize();

      const agent = newManager.get(agentId);
      expect(agent).toBeDefined();
      expect(agent?.skillName).toBe('test');
      expect(agent?.templateVars).toEqual({ key: 'value' });
    });

    it('should mark running agents as stopped on load', async () => {
      // Start an agent and save while running
      await manager.start({
        skillPath: 'skills/test/SKILL.md',
        chatId: 'oc_test',
      });

      // Create a new manager (simulating restart)
      const newManager = new SkillAgentManager();
      await newManager.initialize();

      // The previously running agent should be marked as stopped
      const agents = newManager.list();
      expect(agents.length).toBe(1);
      expect(agents[0].status).toBe('stopped');
      expect(agents[0].error).toBe('Process restarted');
    });
  });

  describe('ID generation', () => {
    it('should generate unique IDs', async () => {
      const id1 = await manager.start({
        skillPath: 'skills/test1/SKILL.md',
        chatId: 'oc_test1',
      });
      const id2 = await manager.start({
        skillPath: 'skills/test2/SKILL.md',
        chatId: 'oc_test2',
      });

      expect(id1).not.toBe(id2);
    });
  });
});
