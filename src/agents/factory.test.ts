/**
 * Tests for AgentFactory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentFactory } from './factory.js';
import { Pilot } from './pilot/index.js';

// Mock Config module
vi.mock('../config/index.js', () => ({
  Config: {
    getAgentConfig: vi.fn(() => ({
      apiKey: 'test-api-key',
      model: 'test-model',
      apiBaseUrl: 'https://api.test.com',
      provider: 'glm',
    })),
    getWorkspaceDir: vi.fn(() => '/tmp/test-workspace'),
    getGlobalEnv: vi.fn(() => ({})),
    getMcpServersConfig: vi.fn(() => ({})), // No Playwright by default
    getLoggingConfig: vi.fn(() => ({ sdkDebug: false })),
    getSkillsDir: vi.fn(() => '/tmp/test-skills'),
  },
}));

// Mock skills finder module
vi.mock('../skills/index.js', () => ({
  findSkill: vi.fn((name: string) => {
    // Simulate finding evaluator and executor skills
    if (name === 'evaluator') {
      return Promise.resolve('/tmp/test-skills/evaluator/SKILL.md');
    }
    if (name === 'executor') {
      return Promise.resolve('/tmp/test-skills/executor/SKILL.md');
    }
    // Unknown skill not found
    return Promise.resolve(null);
  }),
}));

describe('AgentFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ============================================================================
  // AgentFactoryInterface Methods (Issue #282 Phase 3 - Issue #326)
  // ============================================================================

  describe('createChatAgent', () => {
    const mockCallbacks = {
      sendMessage: vi.fn(),
      sendCard: vi.fn(),
      sendFile: vi.fn(),
    };

    it('should create Pilot when name is "pilot"', () => {
      const pilot = AgentFactory.createChatAgent('pilot', mockCallbacks);

      expect(pilot).toBeInstanceOf(Pilot);
      expect(pilot.type).toBe('chat');
    });

    it('should throw error for unknown ChatAgent name', () => {
      expect(() => {
        AgentFactory.createChatAgent('unknown');
      }).toThrow('Unknown ChatAgent: unknown');
    });
  });

  describe('createSkillAgent', () => {
    it('should create Evaluator when name is "evaluator"', async () => {
      const evaluator = await AgentFactory.createSkillAgent('evaluator');

      expect(evaluator).toBeDefined();
      expect(evaluator.type).toBe('skill');
    });

    it('should create Executor when name is "executor"', async () => {
      const executor = await AgentFactory.createSkillAgent('executor');

      expect(executor).toBeDefined();
      expect(executor.type).toBe('skill');
    });

    it('should pass options to agent', async () => {
      const evaluator = await AgentFactory.createSkillAgent('evaluator', { model: 'custom-model' });

      expect(evaluator).toBeDefined();
    });

    it('should throw error for unknown SkillAgent name', async () => {
      await expect(AgentFactory.createSkillAgent('unknown')).rejects.toThrow('Skill not found: unknown');
    });
  });

  describe('createSubagent', () => {
    it('should throw error when Playwright is not available', () => {
      // Mock isPlaywrightAvailable to return false
      vi.doMock('./site-miner.js', () => ({
        isPlaywrightAvailable: () => false,
        createSiteMiner: vi.fn(),
      }));

      expect(() => {
        AgentFactory.createSubagent('site-miner');
      }).toThrow('SiteMiner requires Playwright MCP to be configured');
    });

    it('should throw error for unknown Subagent name', () => {
      expect(() => {
        AgentFactory.createSubagent('unknown');
      }).toThrow('Unknown Subagent: unknown');
    });
  });
});
