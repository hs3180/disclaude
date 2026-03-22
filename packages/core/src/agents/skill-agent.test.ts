/**
 * Unit tests for SkillAgent
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SkillAgent } from './skill-agent.js';
import type { BaseAgentConfig } from './types.js';
import { setRuntimeContext, clearRuntimeContext } from './types.js';

// Mock fs/promises
const mockReadFile = vi.fn();
vi.mock('fs/promises', () => ({
  default: {
    readFile: (...args: unknown[]) => mockReadFile(...args),
  },
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

// Mock the SDK module
const mockQueryOnce = vi.fn();
vi.mock('../sdk/index.js', () => ({
  getProvider: () => ({
    queryOnce: (...args: unknown[]) => mockQueryOnce(...args),
    queryStream: vi.fn(),
  }),
}));

// Mock buildSdkEnv
vi.mock('../utils/sdk.js', () => ({
  buildSdkEnv: (apiKey: string) => ({ ANTHROPIC_API_KEY: apiKey }),
}));

// Mock loadRuntimeEnv
vi.mock('../config/runtime-env.js', () => ({
  loadRuntimeEnv: () => ({}),
}));

describe('SkillAgent', () => {
  const workspaceDir = '/workspace';
  let config: BaseAgentConfig;
  let skillPath: string;
  let skillContent: string;

  beforeEach(() => {
    config = {
      apiKey: 'test-api-key',
      model: 'claude-3-5-sonnet-20241022',
      provider: 'anthropic',
    };
    skillContent = '# Evaluator\n\nEvaluate the following task:\n{taskDescription}';
    skillPath = `${workspaceDir}/skills/evaluator/SKILL.md`;

    setRuntimeContext({
      getWorkspaceDir: () => workspaceDir,
      getAgentConfig: () => ({ apiKey: 'key', model: 'model', provider: 'anthropic' }),
      getLoggingConfig: () => ({ sdkDebug: false }),
      getGlobalEnv: () => ({}),
      isAgentTeamsEnabled: () => false,
    });

    // Mock fs.readFile to return skill content
    mockReadFile.mockResolvedValue(skillContent);
  });

  afterEach(() => {
    clearRuntimeContext();
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create a SkillAgent with correct properties', () => {
      const agent = new SkillAgent(config, skillPath);

      expect(agent).toBeDefined();
      expect(agent.type).toBe('skill');
      expect(agent.name).toBe('SKILL');
    });

    it('should extract skill name from file path', () => {
      const agent = new SkillAgent(config, skillPath);
      expect(agent.name).toBe('SKILL');
    });

    it('should handle relative paths by joining with workspace dir', () => {
      const agent = new SkillAgent(config, 'skills/evaluator/SKILL.md');
      expect(agent).toBeDefined();
      expect(agent.name).toBe('SKILL');
    });

    it('should handle absolute paths', () => {
      const absPath = '/absolute/path/to/SKILL.md';
      const agent = new SkillAgent(config, absPath);
      expect(agent).toBeDefined();
      expect(agent.name).toBe('SKILL');
    });
  });

  describe('initialize', () => {
    it('should mark agent as initialized', () => {
      const agent = new SkillAgent(config, skillPath);
      agent.initialize();
      // No public accessor for initialized, but subsequent calls should not throw
      agent.initialize(); // Should be idempotent
    });
  });

  describe('executeWithContext', () => {
    it('should auto-initialize if not initialized', async () => {
      const agent = new SkillAgent(config, skillPath);
      expect(agent.type).toBe('skill');
    });

    it('should substitute template variables in skill content', async () => {
      const agent = new SkillAgent(config, skillPath);

      // Setup mock to capture the prompt
      mockQueryOnce.mockImplementation(function* () {
        yield { type: 'text', content: 'Evaluation result' };
      });

      const messages: unknown[] = [];
      for await (const msg of agent.executeWithContext({
        templateVars: { taskDescription: 'Build a REST API' },
      })) {
        messages.push(msg);
      }

      // Verify readFile was called
      expect(mockReadFile).toHaveBeenCalledWith(skillPath, 'utf-8');
      expect(messages).toHaveLength(1);
    });

    it('should handle errors and yield error message', async () => {
      const agent = new SkillAgent(config, skillPath);

      mockQueryOnce.mockImplementation(() => {
        throw new Error('SDK error');
      });

      const messages: unknown[] = [];
      for await (const msg of agent.executeWithContext()) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        role: 'assistant',
        messageType: 'error',
      });
    });
  });

  describe('execute', () => {
    it('should combine skill content with string input', async () => {
      const agent = new SkillAgent(config, skillPath);

      mockQueryOnce.mockImplementation(function* () {
        yield { type: 'text', content: 'Result' };
      });

      const messages: unknown[] = [];
      for await (const msg of agent.execute('input task')) {
        messages.push(msg);
      }

      expect(mockReadFile).toHaveBeenCalledWith(skillPath, 'utf-8');
      expect(messages).toHaveLength(1);
    });

    it('should combine skill content with UserInput array', async () => {
      const agent = new SkillAgent(config, skillPath);

      mockQueryOnce.mockImplementation(function* () {
        yield { type: 'text', content: 'Result' };
      });

      const messages: unknown[] = [];
      for await (const msg of agent.execute([
        { role: 'user', content: 'input 1' },
        { role: 'user', content: 'input 2' },
      ])) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(1);
    });

    it('should handle errors in execute', async () => {
      const agent = new SkillAgent(config, skillPath);

      mockQueryOnce.mockImplementation(() => {
        throw new Error('Execute error');
      });

      const messages: unknown[] = [];
      for await (const msg of agent.execute('test')) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        messageType: 'error',
      });
    });
  });
});
