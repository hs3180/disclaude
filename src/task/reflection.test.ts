/**
 * Tests for Reflection Pattern (Issue #271 Phase 3)
 *
 * @module task/reflection.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ReflectionController,
  TerminationConditions,
  DEFAULT_REFLECTION_CONFIG,
  type ReflectionConfig,
  type ReflectionContext,
  type ReflectionEvaluationResult,
  type ReflectionEvent,
  type AgentMessage,
} from './reflection.js';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a mock async generator that yields messages.
 */
async function* mockMessageGenerator(
  messages: AgentMessage[]
): AsyncGenerator<AgentMessage> {
  for (const msg of messages) {
    yield msg;
  }
}

/**
 * Create a mock execute phase that yields messages.
 */
function createMockExecutePhase(messages: AgentMessage[] = []) {
  return vi.fn().mockImplementation(() => mockMessageGenerator(messages));
}

/**
 * Create a mock evaluate phase that yields messages.
 */
function createMockEvaluatePhase(messages: AgentMessage[] = []) {
  return vi.fn().mockImplementation(() => mockMessageGenerator(messages));
}

/**
 * Create a mock reflect phase that yields messages.
 */
function createMockReflectPhase(messages: AgentMessage[] = []) {
  return vi.fn().mockImplementation(() => mockMessageGenerator(messages));
}

// ============================================================================
// Tests
// ============================================================================

describe('ReflectionController', () => {
  let controller: ReflectionController;
  const defaultMessages: AgentMessage[] = [
    { content: 'Test message', role: 'assistant', messageType: 'text' },
  ];

  beforeEach(() => {
    controller = new ReflectionController();
  });

  describe('constructor', () => {
    it('should create controller with default config', () => {
      expect(controller).toBeDefined();
      expect(controller.getMetrics()).toBeDefined();
    });

    it('should accept custom config', () => {
      const customConfig: Partial<ReflectionConfig> = {
        maxIterations: 5,
        confidenceThreshold: 0.9,
        enableMetrics: false,
      };
      const customController = new ReflectionController(customConfig);

      expect(customController).toBeDefined();
    });
  });

  describe('run', () => {
    it('should run a single iteration and return result', async () => {
      const executePhase = createMockExecutePhase(defaultMessages);
      const evaluatePhase = createMockEvaluatePhase(defaultMessages);

      // Terminate after first iteration
      const singleIterationController = new ReflectionController(
        { maxIterations: 1 },
        [TerminationConditions.maxIterations(1)]
      );

      const generator = singleIterationController.run(
        'test-task',
        executePhase,
        evaluatePhase
      );

      const messages: AgentMessage[] = [];
      let result = await generator.next();
      while (!result.done) {
        messages.push(result.value);
        result = await generator.next();
      }

      expect(executePhase).toHaveBeenCalledTimes(1);
      expect(evaluatePhase).toHaveBeenCalledTimes(1);
      expect(messages.length).toBeGreaterThan(0);
    });

    it('should collect metrics when enabled', async () => {
      const executePhase = createMockExecutePhase(defaultMessages);
      const evaluatePhase = createMockEvaluatePhase(defaultMessages);

      const metricsController = new ReflectionController(
        { enableMetrics: true, maxIterations: 1 },
        [TerminationConditions.maxIterations(1)]
      );

      const generator = metricsController.run(
        'test-task',
        executePhase,
        evaluatePhase
      );

      // Consume all messages
      for await (const _ of generator) {
        // Just consume
      }

      const metrics = metricsController.getMetrics();
      expect(metrics).toBeDefined();
      expect(metrics.totalIterations).toBe(1);
      expect(metrics.phases.execute.count).toBe(1);
      expect(metrics.phases.evaluate.count).toBe(1);
    });

    it('should emit events via onEvent callback', async () => {
      const events: ReflectionEvent[] = [];
      const onEvent = (event: ReflectionEvent) => {
        events.push(event);
      };

      const eventController = new ReflectionController(
        { maxIterations: 1, onEvent },
        [TerminationConditions.maxIterations(1)]
      );

      const executePhase = createMockExecutePhase(defaultMessages);
      const evaluatePhase = createMockEvaluatePhase(defaultMessages);

      const generator = eventController.run(
        'test-task',
        executePhase,
        evaluatePhase
      );

      // Consume all messages
      for await (const _ of generator) {
        // Just consume
      }

      expect(events.length).toBeGreaterThan(0);
      expect(events.some((e) => e.type === 'iteration_start')).toBe(true);
      expect(events.some((e) => e.type === 'iteration_end')).toBe(true);
      expect(events.some((e) => e.type === 'phase_start')).toBe(true);
      expect(events.some((e) => e.type === 'phase_end')).toBe(true);
    });

    it('should call reflect phase when provided', async () => {
      const executePhase = createMockExecutePhase(defaultMessages);
      const evaluatePhase = createMockEvaluatePhase(defaultMessages);
      const reflectPhase = createMockReflectPhase(defaultMessages);

      const reflectController = new ReflectionController(
        { maxIterations: 1 },
        [TerminationConditions.maxIterations(1)]
      );

      const generator = reflectController.run(
        'test-task',
        executePhase,
        evaluatePhase,
        reflectPhase
      );

      // Consume all messages
      for await (const _ of generator) {
        // Just consume
      }

      expect(reflectPhase).toHaveBeenCalledTimes(1);
    });

    it('should reset metrics', async () => {
      const executePhase = createMockExecutePhase(defaultMessages);
      const evaluatePhase = createMockEvaluatePhase(defaultMessages);

      const generator = controller.run(
        'test-task',
        executePhase,
        evaluatePhase
      );

      // Consume all messages
      for await (const _ of generator) {
        // Just consume
      }

      expect(controller.getMetrics().totalIterations).toBeGreaterThan(0);

      controller.resetMetrics();
      expect(controller.getMetrics().totalIterations).toBe(0);
    });
  });

  describe('getMetrics', () => {
    it('should return empty metrics initially', () => {
      const metrics = controller.getMetrics();

      expect(metrics.totalIterations).toBe(0);
      expect(metrics.successfulIterations).toBe(0);
      expect(metrics.failedIterations).toBe(0);
    });
  });
});

describe('TerminationConditions', () => {
  const mockContext: ReflectionContext = {
    taskId: 'test-task',
    iteration: 1,
    config: DEFAULT_REFLECTION_CONFIG,
    metrics: {
      totalIterations: 1,
      successfulIterations: 1,
      failedIterations: 0,
      totalDurationMs: 100,
      avgIterationDurationMs: 100,
      phases: {
        execute: { count: 1, totalDurationMs: 50, avgDurationMs: 50, failureCount: 0 },
        evaluate: { count: 1, totalDurationMs: 30, avgDurationMs: 30, failureCount: 0 },
        reflect: { count: 0, totalDurationMs: 0, avgDurationMs: 0, failureCount: 0 },
      },
    },
  };

  describe('isComplete', () => {
    it('should return true when task is complete with sufficient confidence', () => {
      const condition = TerminationConditions.isComplete(0.8);
      const result: ReflectionEvaluationResult = {
        isComplete: true,
        confidence: 0.9,
        reasoning: 'Task is complete',
      };

      expect(condition(mockContext, result)).toBe(true);
    });

    it('should return false when confidence is below threshold', () => {
      const condition = TerminationConditions.isComplete(0.8);
      const result: ReflectionEvaluationResult = {
        isComplete: true,
        confidence: 0.7,
        reasoning: 'Task might be complete',
      };

      expect(condition(mockContext, result)).toBe(false);
    });

    it('should return false when task is not complete', () => {
      const condition = TerminationConditions.isComplete(0.8);
      const result: ReflectionEvaluationResult = {
        isComplete: false,
        confidence: 0.9,
        reasoning: 'Task needs more work',
      };

      expect(condition(mockContext, result)).toBe(false);
    });
  });

  describe('maxIterations', () => {
    it('should return true when max iterations reached', () => {
      const condition = TerminationConditions.maxIterations(3);
      const context = { ...mockContext, iteration: 3 };

      expect(condition(context, {} as ReflectionEvaluationResult)).toBe(true);
    });

    it('should return false when below max iterations', () => {
      const condition = TerminationConditions.maxIterations(3);
      const context = { ...mockContext, iteration: 2 };

      expect(condition(context, {} as ReflectionEvaluationResult)).toBe(false);
    });
  });

  describe('evaluationComplete', () => {
    it('should return true when evaluation is complete', () => {
      const condition = TerminationConditions.evaluationComplete();
      const result: ReflectionEvaluationResult = {
        isComplete: true,
        confidence: 0.5,
        reasoning: 'Done',
      };

      expect(condition(mockContext, result)).toBe(true);
    });

    it('should return false when evaluation is not complete', () => {
      const condition = TerminationConditions.evaluationComplete();
      const result: ReflectionEvaluationResult = {
        isComplete: false,
        confidence: 0.5,
        reasoning: 'Not done',
      };

      expect(condition(mockContext, result)).toBe(false);
    });
  });

  describe('all', () => {
    it('should return true when all conditions are met', async () => {
      const condition = TerminationConditions.all(
        TerminationConditions.maxIterations(3),
        TerminationConditions.evaluationComplete()
      );
      const context = { ...mockContext, iteration: 3 };
      const result: ReflectionEvaluationResult = {
        isComplete: true,
        confidence: 0.5,
        reasoning: 'Done',
      };

      expect(await condition(context, result)).toBe(true);
    });

    it('should return false when any condition is not met', async () => {
      const condition = TerminationConditions.all(
        TerminationConditions.maxIterations(3),
        TerminationConditions.evaluationComplete()
      );
      const context = { ...mockContext, iteration: 2 };
      const result: ReflectionEvaluationResult = {
        isComplete: true,
        confidence: 0.5,
        reasoning: 'Done',
      };

      expect(await condition(context, result)).toBe(false);
    });
  });

  describe('any', () => {
    it('should return true when any condition is met', async () => {
      const condition = TerminationConditions.any(
        TerminationConditions.maxIterations(10),
        TerminationConditions.evaluationComplete()
      );
      const context = { ...mockContext, iteration: 2 };
      const result: ReflectionEvaluationResult = {
        isComplete: true,
        confidence: 0.5,
        reasoning: 'Done',
      };

      expect(await condition(context, result)).toBe(true);
    });

    it('should return false when no condition is met', async () => {
      const condition = TerminationConditions.any(
        TerminationConditions.maxIterations(10),
        TerminationConditions.evaluationComplete()
      );
      const context = { ...mockContext, iteration: 2 };
      const result: ReflectionEvaluationResult = {
        isComplete: false,
        confidence: 0.5,
        reasoning: 'Not done',
      };

      expect(await condition(context, result)).toBe(false);
    });
  });
});

describe('DEFAULT_REFLECTION_CONFIG', () => {
  it('should have sensible defaults', () => {
    expect(DEFAULT_REFLECTION_CONFIG.maxIterations).toBe(10);
    expect(DEFAULT_REFLECTION_CONFIG.confidenceThreshold).toBe(0.8);
    expect(DEFAULT_REFLECTION_CONFIG.enableMetrics).toBe(true);
  });
});
