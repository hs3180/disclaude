/**
 * Tests for AgentFactory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentFactory } from './factory.js';
import { Evaluator } from './evaluator.js';
import { Executor } from './executor.js';
import { Reporter } from './reporter.js';
import { Pilot } from './pilot.js';
import { Config } from '../config/index.js';

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
  },
}));

describe('AgentFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createEvaluator', () => {
    it('should create Evaluator with default config', () => {
      const evaluator = AgentFactory.createEvaluator();

      expect(evaluator).toBeInstanceOf(Evaluator);
      expect(Config.getAgentConfig).toHaveBeenCalled();
    });

    it('should create Evaluator with custom subdirectory', () => {
      const evaluator = AgentFactory.createEvaluator({}, 'regular');

      expect(evaluator).toBeInstanceOf(Evaluator);
    });

    it('should allow overriding config options', () => {
      const evaluator = AgentFactory.createEvaluator({
        apiKey: 'custom-key',
        model: 'custom-model',
      });

      expect(evaluator).toBeInstanceOf(Evaluator);
    });
  });

  describe('createExecutor', () => {
    it('should create Executor with default config', () => {
      const executor = AgentFactory.createExecutor();

      expect(executor).toBeInstanceOf(Executor);
      expect(Config.getAgentConfig).toHaveBeenCalled();
    });

    it('should create Executor with abort signal', () => {
      const controller = new AbortController();
      const executor = AgentFactory.createExecutor({}, controller.signal);

      expect(executor).toBeInstanceOf(Executor);
    });

    it('should allow overriding config options', () => {
      const executor = AgentFactory.createExecutor({
        apiKey: 'custom-key',
        model: 'custom-model',
      });

      expect(executor).toBeInstanceOf(Executor);
    });
  });

  describe('createReporter', () => {
    it('should create Reporter with default config', () => {
      const reporter = AgentFactory.createReporter();

      expect(reporter).toBeInstanceOf(Reporter);
      expect(Config.getAgentConfig).toHaveBeenCalled();
    });

    it('should allow overriding config options', () => {
      const reporter = AgentFactory.createReporter({
        apiKey: 'custom-key',
        model: 'custom-model',
      });

      expect(reporter).toBeInstanceOf(Reporter);
    });
  });

  describe('createPilot', () => {
    const mockCallbacks = {
      sendMessage: vi.fn(),
      sendCard: vi.fn(),
      sendFile: vi.fn(),
    };

    it('should create Pilot with callbacks', () => {
      const pilot = AgentFactory.createPilot(mockCallbacks);

      expect(pilot).toBeInstanceOf(Pilot);
      expect(Config.getAgentConfig).toHaveBeenCalled();
    });

    it('should allow overriding config options', () => {
      const pilot = AgentFactory.createPilot(mockCallbacks, {
        apiKey: 'custom-key',
        model: 'custom-model',
      });

      expect(pilot).toBeInstanceOf(Pilot);
    });
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
    it('should create Evaluator when name is "evaluator"', () => {
      const evaluator = AgentFactory.createSkillAgent('evaluator');

      expect(evaluator).toBeDefined();
      expect(evaluator.type).toBe('skill');
    });

    it('should create Executor when name is "executor"', () => {
      const executor = AgentFactory.createSkillAgent('executor');

      expect(executor).toBeDefined();
      expect(executor.type).toBe('skill');
    });

    it('should create Reporter when name is "reporter"', () => {
      const reporter = AgentFactory.createSkillAgent('reporter');

      expect(reporter).toBeDefined();
      expect(reporter.type).toBe('skill');
    });

    it('should pass subdirectory to Evaluator', () => {
      const evaluator = AgentFactory.createSkillAgent('evaluator', {}, 'regular');

      expect(evaluator).toBeDefined();
    });

    it('should pass abortSignal to Executor', () => {
      const controller = new AbortController();
      const executor = AgentFactory.createSkillAgent('executor', {}, controller.signal);

      expect(executor).toBeDefined();
    });

    it('should throw error for unknown SkillAgent name', () => {
      expect(() => {
        AgentFactory.createSkillAgent('unknown');
      }).toThrow('Unknown SkillAgent: unknown');
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
