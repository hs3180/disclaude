/**
 * Tests for SkillAgent - Minimal agent that executes skills from markdown files.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SkillAgent } from './skill-agent.js';
import type { BaseAgentConfig } from './types.js';

// Mock SDK provider
vi.mock('../sdk/index.js', () => ({
  getProvider: vi.fn(() => ({
    queryOnce: vi.fn(async function* () {
      yield { type: 'text', content: 'SDK response', role: 'assistant' };
    }),
    queryStream: vi.fn(() => ({
      handle: { close: vi.fn(), cancel: vi.fn() },
      iterator: (async function* () {
        yield { type: 'text', content: 'SDK response', role: 'assistant' };
      })(),
    })),
  })),
}));

// Mock config
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: vi.fn(() => '/test/workspace'),
    getAgentConfig: vi.fn(() => ({
      apiKey: 'test-key',
      model: 'test-model',
      provider: 'anthropic',
    })),
    getGlobalEnv: vi.fn(() => ({})),
    getLoggingConfig: vi.fn(() => ({
      level: 'info',
      pretty: true,
      rotate: false,
      sdkDebug: true,
    })),
  },
}));

// Mock utils
vi.mock('../utils/sdk.js', () => ({
  parseSDKMessage: vi.fn((msg) => ({
    type: msg.type || 'text',
    content: msg.content || '',
    metadata: {},
  })),
  buildSdkEnv: vi.fn(() => ({})),
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Test skill file content
const TEST_SKILL_CONTENT = `# Test Skill

This is a test skill prompt.

Task ID: {taskId}
Iteration: {iteration}
Custom Var: {customVar}
`;

describe('SkillAgent', () => {
  let tempDir: string;
  let skillPath: string;
  let mockConfig: BaseAgentConfig;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-agent-test-'));
    skillPath = path.join(tempDir, 'test-skill.md');
    await fs.writeFile(skillPath, TEST_SKILL_CONTENT);

    // Mock config - use test API key
    mockConfig = {
      apiKey: 'test-api-key',
      model: 'claude-3-5-sonnet-20241022',
      provider: 'anthropic',
    };
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should create SkillAgent with skill path', () => {
    const agent = new SkillAgent(mockConfig, skillPath);

    expect(agent.type).toBe('skill');
    expect(agent.name).toBe('test-skill');
  });

  it('should initialize properly', () => {
    const agent = new SkillAgent(mockConfig, skillPath);
    agent.initialize();

    // Should be idempotent
    agent.initialize();
  });

  it('should dispose properly', () => {
    const agent = new SkillAgent(mockConfig, skillPath);
    agent.initialize();

    agent.dispose();

    // Should be safe to call dispose multiple times
    agent.dispose();
  });

  it('should extract skill name from relative path', () => {
    const agent = new SkillAgent(mockConfig, 'skills/evaluator/SKILL.md');

    expect(agent.name).toBe('SKILL');
  });

  describe('template variable substitution', () => {
    it('should substitute template variables in skill content', async () => {
      const agent = new SkillAgent(mockConfig, skillPath);
      agent.initialize();

      // The template substitution is internal, but we can verify it doesn't throw
      const generator = agent.executeWithContext({
        templateVars: {
          taskId: 'task-123',
          iteration: '1',
          customVar: 'custom-value',
        },
      });

      // Just verify it returns an async generator
      expect(generator[Symbol.asyncIterator]).toBeDefined();

      // Consume the generator to cover more code paths
      const results = [];
      for await (const msg of generator) {
        results.push(msg);
      }
      expect(results.length).toBeGreaterThan(0);
    });

    it('should execute without template variables', async () => {
      const agent = new SkillAgent(mockConfig, skillPath);
      agent.initialize();

      const generator = agent.executeWithContext();

      // Consume the generator
      const results = [];
      for await (const msg of generator) {
        results.push(msg);
      }
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('execute method', () => {
    it('should accept string input and execute', async () => {
      const agent = new SkillAgent(mockConfig, skillPath);
      agent.initialize();

      const generator = agent.execute('test input');

      // Verify it returns an async generator
      expect(generator[Symbol.asyncIterator]).toBeDefined();

      // Consume the generator to cover more code paths
      const results = [];
      for await (const msg of generator) {
        results.push(msg);
      }
      expect(results.length).toBeGreaterThan(0);
    });

    it('should accept UserInput array and execute', async () => {
      const agent = new SkillAgent(mockConfig, skillPath);
      agent.initialize();

      const generator = agent.execute([
        { role: 'user', content: 'test input 1' },
        { role: 'user', content: 'test input 2' },
      ]);

      // Verify it returns an async generator
      expect(generator[Symbol.asyncIterator]).toBeDefined();

      // Consume the generator to cover more code paths
      const results = [];
      for await (const msg of generator) {
        results.push(msg);
      }
      expect(results.length).toBeGreaterThan(0);
    });

    it('should auto-initialize when not initialized', async () => {
      const agent = new SkillAgent(mockConfig, skillPath);
      // Don't call initialize() - should auto-initialize

      const generator = agent.execute('test input');

      // Consume the generator
      const results = [];
      for await (const msg of generator) {
        results.push(msg);
      }
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('executeWithContext', () => {
    it('should auto-initialize when not initialized', async () => {
      const agent = new SkillAgent(mockConfig, skillPath);
      // Don't call initialize() - should auto-initialize

      const generator = agent.executeWithContext({
        templateVars: { taskId: 'test' },
      });

      // Consume the generator
      const results = [];
      for await (const msg of generator) {
        results.push(msg);
      }
      expect(results.length).toBeGreaterThan(0);
    });
  });
});
