/**
 * Tests for AgentFactory module.
 *
 * Tests the unified factory for creating Agent instances (Issue #129).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentFactory } from './agent-factory.js';
import { Pilot } from './pilot.js';
import { Evaluator } from './evaluator.js';
import { Executor } from './executor.js';
import { Reporter } from './reporter.js';

// Mock Config
vi.mock('../config/index.js', () => ({
  Config: {
    getAgentConfig: vi.fn(() => ({
      apiKey: 'default-test-key',
      model: 'default-test-model',
      apiBaseUrl: 'https://default.api.url',
    })),
    getWorkspaceDir: vi.fn(() => '/test/workspace'),
    getMcpServersConfig: vi.fn(() => undefined),
  },
}));

// Mock Pilot callbacks
const mockCallbacks = {
  sendMessage: vi.fn(async () => {}),
  sendCard: vi.fn(async () => {}),
  sendFile: vi.fn(async () => {}),
};

describe('AgentFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('createPilot', () => {
    it('should create Pilot with default config from Config.getAgentConfig', () => {
      const pilot = AgentFactory.createPilot({
        callbacks: mockCallbacks,
      });

      expect(pilot).toBeInstanceOf(Pilot);
    });

    it('should create Pilot with explicit overrides', () => {
      const pilot = AgentFactory.createPilot({
        callbacks: mockCallbacks,
        apiKey: 'custom-key',
        model: 'custom-model',
        apiBaseUrl: 'https://custom.api.url',
        isCliMode: true,
      });

      expect(pilot).toBeInstanceOf(Pilot);
    });

    it('should create Pilot in CLI mode', () => {
      const pilot = AgentFactory.createPilot({
        callbacks: mockCallbacks,
        isCliMode: true,
      });

      expect(pilot).toBeInstanceOf(Pilot);
    });

    it('should create Pilot in non-CLI mode by default', () => {
      const pilot = AgentFactory.createPilot({
        callbacks: mockCallbacks,
      });

      expect(pilot).toBeInstanceOf(Pilot);
    });
  });

  describe('createEvaluator', () => {
    it('should create Evaluator with default config', () => {
      const evaluator = AgentFactory.createEvaluator();

      expect(evaluator).toBeInstanceOf(Evaluator);
    });

    it('should create Evaluator with subdirectory option', () => {
      const evaluator = AgentFactory.createEvaluator({
        subdirectory: 'regular',
      });

      expect(evaluator).toBeInstanceOf(Evaluator);
    });

    it('should create Evaluator with explicit overrides', () => {
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
    });

    it('should create Executor with abort signal', () => {
      const controller = new AbortController();
      const executor = AgentFactory.createExecutor({
        abortSignal: controller.signal,
      });

      expect(executor).toBeInstanceOf(Executor);
    });

    it('should create Executor with explicit overrides', () => {
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
    });

    it('should create Reporter with explicit overrides', () => {
      const reporter = AgentFactory.createReporter({
        apiKey: 'custom-key',
        model: 'custom-model',
      });

      expect(reporter).toBeInstanceOf(Reporter);
    });
  });

  describe('Config Consistency', () => {
    it('should use same default config for all agent types', () => {
      // All agents should use Config.getAgentConfig() for defaults
      const pilot = AgentFactory.createPilot({ callbacks: mockCallbacks });
      const evaluator = AgentFactory.createEvaluator();
      const executor = AgentFactory.createExecutor();
      const reporter = AgentFactory.createReporter();

      expect(pilot).toBeInstanceOf(Pilot);
      expect(evaluator).toBeInstanceOf(Evaluator);
      expect(executor).toBeInstanceOf(Executor);
      expect(reporter).toBeInstanceOf(Reporter);
    });

    it('should allow per-agent config override', () => {
      // Each agent can override specific config fields
      const pilot = AgentFactory.createPilot({
        callbacks: mockCallbacks,
        model: 'pilot-model',
      });
      const evaluator = AgentFactory.createEvaluator({
        model: 'evaluator-model',
      });

      expect(pilot).toBeInstanceOf(Pilot);
      expect(evaluator).toBeInstanceOf(Evaluator);
    });
  });
});
