/**
 * Tests for AgentFactory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentFactory } from './factory.js';
import { Pilot } from './pilot.js';

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
    it('should throw deprecation error for "evaluator"', () => {
      expect(() => {
        AgentFactory.createSkillAgent('evaluator');
      }).toThrow("'evaluator' is deprecated. Use GenericSkillAgent directly instead");
    });

    it('should throw deprecation error for "executor"', () => {
      expect(() => {
        AgentFactory.createSkillAgent('executor');
      }).toThrow("'executor' is deprecated. Use GenericSkillAgent directly instead");
    });

    it('should throw error for unknown SkillAgent name', () => {
      expect(() => {
        AgentFactory.createSkillAgent('unknown');
      }).toThrow('Unknown SkillAgent: unknown. Use GenericSkillAgent directly.');
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
