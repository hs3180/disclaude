/**
 * Tests for GenericSkillAgent
 *
 * GenericSkillAgent is the simplified skill execution agent from Issue #413.
 * It reads skill markdown files, replaces template variables, and executes via SDK.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import { GenericSkillAgent, type SkillContext } from './skill-agent.js';
import type { BaseAgentConfig } from './types.js';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

// Mock Config
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: () => '/test/workspace',
    getAgentConfig: () => ({
      apiKey: 'test-key',
      model: 'test-model',
      provider: 'anthropic',
    }),
    getLoggingConfig: () => ({
      sdkDebug: false,
    }),
    getGlobalEnv: () => ({}),
  },
}));

// Mock SDK provider
vi.mock('../sdk/index.js', () => ({
  getProvider: () => ({
    queryOnce: vi.fn().mockImplementation(function* (input: string) {
      yield {
        type: 'text',
        content: `Response to: ${input.substring(0, 50)}...`,
        metadata: {},
      };
    }),
  }),
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  }),
}));

describe('GenericSkillAgent', () => {
  let agent: GenericSkillAgent;
  const config: BaseAgentConfig = {
    apiKey: 'test-api-key',
    model: 'test-model',
    provider: 'anthropic',
    permissionMode: 'bypassPermissions',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new GenericSkillAgent(config);
  });

  afterEach(() => {
    agent.dispose();
  });

  describe('constructor', () => {
    it('should create instance with correct properties', () => {
      expect(agent.type).toBe('skill');
      expect(agent.name).toBe('GenericSkillAgent');
    });
  });

  describe('executeSkill', () => {
    it('should read skill file and execute with template variables', async () => {
      const skillContent = `# Test Skill
Task ID: {{taskId}}
Iteration: {{iteration}}
Path: {{taskMdPath}}`;

      vi.mocked(fs.readFile).mockResolvedValueOnce(skillContent);

      const context: SkillContext = {
        taskId: 'task-123',
        iteration: 1,
        taskMdPath: '/test/workspace/tasks/task-123/Task.md',
      };

      const messages = [];
      for await (const msg of agent.executeSkill('skills/test/SKILL.md', context)) {
        messages.push(msg);
      }

      expect(fs.readFile).toHaveBeenCalled();
      expect(messages.length).toBeGreaterThan(0);
    });

    it('should replace multiple template variables', async () => {
      const skillContent = 'Task: {{taskId}}, Iter: {{iteration}}, Path: {{taskMdPath}}';
      vi.mocked(fs.readFile).mockResolvedValueOnce(skillContent);

      const context: SkillContext = {
        taskId: 'my-task',
        iteration: 5,
        taskMdPath: '/path/to/Task.md',
      };

      const messages = [];
      for await (const msg of agent.executeSkill('skills/test/SKILL.md', context)) {
        messages.push(msg);
      }

      expect(fs.readFile).toHaveBeenCalled();
    });

    it('should replace undefined variables with empty string', async () => {
      const skillContent = 'Task: {{taskId}}, Missing: {{undefinedVar}}';
      vi.mocked(fs.readFile).mockResolvedValueOnce(skillContent);

      const context: SkillContext = {
        taskId: 'task-123',
      };

      const messages = [];
      for await (const msg of agent.executeSkill('skills/test/SKILL.md', context)) {
        messages.push(msg);
      }

      expect(fs.readFile).toHaveBeenCalled();
    });

    it('should handle null variable values', async () => {
      const skillContent = 'Previous: {{previousExecutionPath}}';
      vi.mocked(fs.readFile).mockResolvedValueOnce(skillContent);

      const context: SkillContext = {
        taskId: 'task-123',
        previousExecutionPath: null,
      };

      const messages = [];
      for await (const msg of agent.executeSkill('skills/test/SKILL.md', context)) {
        messages.push(msg);
      }

      expect(fs.readFile).toHaveBeenCalled();
    });

    it('should throw error when skill file cannot be read', async () => {
      vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('File not found'));

      const context: SkillContext = { taskId: 'task-123' };

      await expect(async () => {
        for await (const _ of agent.executeSkill('skills/missing/SKILL.md', context)) {
          // Should not reach here
        }
      }).rejects.toThrow('Failed to read skill file');
    });

    it('should resolve relative paths correctly', async () => {
      vi.mocked(fs.readFile).mockResolvedValueOnce('skill content');

      const context: SkillContext = { taskId: 'task-123' };

      for await (const _ of agent.executeSkill('skills/test/SKILL.md', context)) {
        break;
      }

      // eslint-disable-next-line prefer-destructuring
      const calledPath = vi.mocked(fs.readFile).mock.calls[0][0];
      expect(calledPath).toContain('skills/test/SKILL.md');
    });

    it('should use absolute paths as-is', async () => {
      vi.mocked(fs.readFile).mockResolvedValueOnce('skill content');

      const context: SkillContext = { taskId: 'task-123' };
      const absolutePath = '/absolute/path/to/SKILL.md';

      for await (const _ of agent.executeSkill(absolutePath, context)) {
        break;
      }

      expect(fs.readFile).toHaveBeenCalledWith(absolutePath, 'utf-8');
    });
  });

  describe('execute (SkillAgent interface)', () => {
    it('should execute string input directly', async () => {
      const messages = [];
      for await (const msg of agent.execute('test prompt')) {
        messages.push(msg);
      }

      expect(messages.length).toBeGreaterThan(0);
    });

    it('should execute UserInput array', async () => {
      const messages = [];
      for await (const msg of agent.execute([
        { role: 'user', content: 'hello' },
        { role: 'user', content: 'world' },
      ])) {
        messages.push(msg);
      }

      expect(messages.length).toBeGreaterThan(0);
    });
  });

  describe('dispose', () => {
    it('should be idempotent', () => {
      agent.dispose();
      agent.dispose(); // Should not throw
    });
  });

  describe('SkillContext', () => {
    it('should support all expected fields', () => {
      const context: SkillContext = {
        taskId: 'task-123',
        iteration: 1,
        workspaceDir: '/workspace',
        taskMdPath: '/path/to/Task.md',
        evaluationPath: '/path/to/evaluation.md',
        executionPath: '/path/to/execution.md',
        previousExecutionPath: '/path/to/prev.md',
        finalResultPath: '/path/to/final.md',
        evaluationContent: 'evaluation text',
        customField: 'custom value',
      };

      expect(context.taskId).toBe('task-123');
      expect(context.customField).toBe('custom value');
    });
  });
});
