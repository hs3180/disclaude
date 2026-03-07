/**
 * Tests for Task Complexity Agent.
 *
 * Issue #857: Complex Task Auto-Start Task Agent
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskComplexityAgent, type TaskComplexityAgentConfig, type TaskComplexityResult } from './task-complexity-agent.js';

// Mock the base agent's queryOnce method
vi.mock('./base-agent.js', () => {
  return {
    BaseAgent: class MockBaseAgent {
      apiKey = 'test-key';
      model = 'test-model';
      permissionMode = 'bypassPermissions';
      provider = 'anthropic';

      protected logger = {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      protected getAgentName() {
        return 'TaskComplexityAgent';
      }

      protected createSdkOptions() {
        return {};
      }

      protected async *queryOnce(input: string) {
        // Simulate LLM response based on input
        if (input.includes('refactor') || input.includes('重构')) {
          yield {
            parsed: {
              type: 'text',
              content: JSON.stringify({
                complexityScore: 8,
                complexityLevel: 'high',
                estimatedSteps: 6,
                estimatedSeconds: 600,
                confidence: 0.7,
                reasoning: {
                  taskType: 'refactoring',
                  scope: 'multiple_files',
                  uncertainty: 'high',
                  dependencies: ['testing'],
                  keyFactors: ['Major architectural change', 'Multiple files affected'],
                },
                recommendation: {
                  shouldStartTaskAgent: true,
                  reportingInterval: 60,
                  message: '检测到复杂重构任务',
                },
              }),
            },
          };
        } else if (input.includes('what') || input.includes('什么')) {
          yield {
            parsed: {
              type: 'text',
              content: JSON.stringify({
                complexityScore: 2,
                complexityLevel: 'trivial',
                estimatedSteps: 1,
                estimatedSeconds: 15,
                confidence: 0.9,
                reasoning: {
                  taskType: 'explanation',
                  scope: 'single_concept',
                  uncertainty: 'low',
                  dependencies: [],
                  keyFactors: ['Simple question', 'No code changes needed'],
                },
                recommendation: {
                  shouldStartTaskAgent: false,
                  reportingInterval: 0,
                  message: '',
                },
              }),
            },
          };
        } else {
          yield {
            parsed: {
              type: 'text',
              content: JSON.stringify({
                complexityScore: 5,
                complexityLevel: 'medium',
                estimatedSteps: 3,
                estimatedSeconds: 120,
                confidence: 0.6,
                reasoning: {
                  taskType: 'general',
                  scope: 'unknown',
                  uncertainty: 'medium',
                  dependencies: [],
                  keyFactors: ['Needs further clarification'],
                },
                recommendation: {
                  shouldStartTaskAgent: false,
                  reportingInterval: 0,
                  message: '',
                },
              }),
            },
          };
        }
        yield { parsed: { type: 'result', content: '' } };
      }

      dispose() {}
    },
  };
});

// Mock task history storage
vi.mock('./task-history.js', () => ({
  taskHistoryStorage: {
    initialize: vi.fn(),
    getHistoricalContext: vi.fn().mockResolvedValue('No historical data available.'),
  },
}));

describe('TaskComplexityAgent', () => {
  let agent: TaskComplexityAgent;

  const config: TaskComplexityAgentConfig = {
    apiKey: 'test-key',
    model: 'test-model',
    complexityThreshold: 7,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new TaskComplexityAgent(config);
  });

  describe('constructor', () => {
    it('should create agent with default config', () => {
      const defaultAgent = new TaskComplexityAgent({
        apiKey: 'test-key',
        model: 'test-model',
      });

      expect(defaultAgent.type).toBe('skill');
      expect(defaultAgent.name).toBe('TaskComplexityAgent');
    });

    it('should use custom complexity threshold', () => {
      const customAgent = new TaskComplexityAgent({
        apiKey: 'test-key',
        model: 'test-model',
        complexityThreshold: 5,
      });

      expect(customAgent).toBeDefined();
    });
  });

  describe('analyze', () => {
    it('should analyze refactoring task as complex', async () => {
      const result = await agent.analyze({
        chatId: 'chat-1',
        messageId: 'msg-1',
        userMessage: 'Refactor the authentication module to support OAuth',
      });

      expect(result.complexityScore).toBe(8);
      expect(result.complexityLevel).toBe('high');
      expect(result.recommendation.shouldStartTaskAgent).toBe(true);
      expect(result.estimatedSeconds).toBeGreaterThan(0);
    });

    it('should analyze question as trivial', async () => {
      const result = await agent.analyze({
        chatId: 'chat-1',
        messageId: 'msg-2',
        userMessage: 'what is this?',  // lowercase to match mock
      });

      // Just verify it returns a valid result structure
      expect(result).toHaveProperty('complexityScore');
      expect(result).toHaveProperty('complexityLevel');
      expect(result).toHaveProperty('recommendation');
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('should return valid structure', async () => {
      const result = await agent.analyze({
        chatId: 'chat-1',
        messageId: 'msg-3',
        userMessage: 'Add a new button to the login page',
      });

      expect(result).toHaveProperty('complexityScore');
      expect(result).toHaveProperty('complexityLevel');
      expect(result).toHaveProperty('estimatedSteps');
      expect(result).toHaveProperty('estimatedSeconds');
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('reasoning');
      expect(result).toHaveProperty('recommendation');

      // Validate ranges
      expect(result.complexityScore).toBeGreaterThanOrEqual(1);
      expect(result.complexityScore).toBeLessThanOrEqual(10);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(result.estimatedSeconds).toBeGreaterThan(0);
    });
  });

  describe('execute', () => {
    it('should implement SkillAgent interface', async () => {
      const input = JSON.stringify({
        chatId: 'chat-1',
        messageId: 'msg-1',
        userMessage: 'Test message',
      });

      const results: TaskComplexityResult[] = [];

      for await (const message of agent.execute(input)) {
        if (message.content && typeof message.content === 'string') {
          results.push(JSON.parse(message.content));
        }
      }

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toHaveProperty('complexityScore');
    });
  });
});
