/**
 * Tests for Result Aggregator.
 *
 * Issue #897 Phase 2: Master-Workers multi-agent collaboration pattern.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ResultAggregator } from './result-aggregator.js';
import type { TaskResult } from './types.js';

describe('ResultAggregator', () => {
  let aggregator: ResultAggregator;

  const createMockResult = (
    taskId: string,
    status: 'completed' | 'failed' = 'completed',
    output?: string
  ): TaskResult => ({
    taskId,
    status,
    output: output ?? `Output from ${taskId}`,
    startedAt: new Date(),
    completedAt: new Date(),
    duration: 1000,
  });

  beforeEach(() => {
    aggregator = new ResultAggregator();
  });

  describe('addResult and getProgress', () => {
    it('should track added results', () => {
      aggregator.setExpectedTotal(3);
      expect(aggregator.getProgress().collected).toBe(0);

      aggregator.addResult(createMockResult('task-1'));
      expect(aggregator.getProgress().collected).toBe(1);

      aggregator.addResult(createMockResult('task-2'));
      expect(aggregator.getProgress().collected).toBe(2);
    });

    it('should report completion status', () => {
      aggregator.setExpectedTotal(2);
      expect(aggregator.getProgress().isComplete).toBe(false);

      aggregator.addResult(createMockResult('task-1'));
      expect(aggregator.getProgress().isComplete).toBe(false);

      aggregator.addResult(createMockResult('task-2'));
      expect(aggregator.getProgress().isComplete).toBe(true);
    });
  });

  describe('onProgress', () => {
    it('should notify progress callbacks', () => {
      const callback = vi.fn();
      aggregator.onProgress(callback);
      aggregator.setExpectedTotal(2);

      aggregator.addResult(createMockResult('task-1'));

      expect(callback).toHaveBeenCalledTimes(2); // setExpectedTotal + addResult
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ collected: 1, total: 2 })
      );
    });
  });

  describe('aggregate with concat strategy', () => {
    it('should concatenate results', () => {
      aggregator.addResults([
        createMockResult('task-1', 'completed', 'Output 1'),
        createMockResult('task-2', 'completed', 'Output 2'),
      ]);

      const result = aggregator.aggregate({ strategy: 'concat' });

      expect(result.output).toContain('task-1');
      expect(result.output).toContain('Output 1');
      expect(result.output).toContain('task-2');
      expect(result.output).toContain('Output 2');
    });

    it('should use custom separator', () => {
      aggregator.addResults([
        createMockResult('task-1', 'completed', 'A'),
        createMockResult('task-2', 'completed', 'B'),
      ]);

      const result = aggregator.aggregate({ strategy: 'concat', separator: '|||' });

      expect(result.output).toContain('|||');
    });

    it('should respect max length', () => {
      aggregator.addResults([
        createMockResult('task-1', 'completed', 'A'.repeat(1000)),
      ]);

      const result = aggregator.aggregate({ strategy: 'concat', maxLength: 100 });

      expect(result.output.length).toBeLessThanOrEqual(150); // 100 + truncation message
      expect(result.output).toContain('truncated');
    });
  });

  describe('aggregate with summarize strategy', () => {
    it('should generate a summary', () => {
      aggregator.addResults([
        createMockResult('task-1', 'completed', 'Output 1'),
        createMockResult('task-2', 'completed', 'Output 2'),
        { ...createMockResult('task-3', 'failed'), error: 'Something went wrong' },
      ]);

      const result = aggregator.aggregate({ strategy: 'summarize' });

      expect(result.output).toContain('Aggregated Results Summary');
      expect(result.output).toContain('Total tasks: 3');
      expect(result.output).toContain('COMPLETED');
      expect(result.output).toContain('FAILED');
    });
  });

  describe('aggregate with merge strategy', () => {
    it('should merge JSON results', () => {
      aggregator.addResults([
        createMockResult('task-1', 'completed', '{"a": 1}'),
        createMockResult('task-2', 'completed', '{"b": 2}'),
      ]);

      const result = aggregator.aggregate({ strategy: 'merge' });

      const parsed = JSON.parse(result.output);
      expect(parsed.a).toBe(1);
      expect(parsed.b).toBe(2);
    });

    it('should handle non-JSON results', () => {
      aggregator.addResults([
        createMockResult('task-1', 'completed', 'plain text'),
      ]);

      const result = aggregator.aggregate({ strategy: 'merge' });

      const parsed = JSON.parse(result.output);
      expect(parsed['task-1']).toBe('plain text');
    });
  });

  describe('aggregate with best strategy', () => {
    it('should select the longest result by default', () => {
      aggregator.addResults([
        createMockResult('task-1', 'completed', 'Short'),
        createMockResult('task-2', 'completed', 'This is a much longer output'),
        createMockResult('task-3', 'completed', 'Medium'),
      ]);

      const result = aggregator.aggregate({ strategy: 'best' });

      expect(result.output).toContain('task-2');
      expect(result.output).toContain('This is a much longer output');
    });

    it('should use custom selector', () => {
      aggregator.addResults([
        createMockResult('task-1', 'completed', 'AAA'),
        createMockResult('task-2', 'completed', 'BBB'),
      ]);

      const result = aggregator.aggregate({
        strategy: 'best',
        bestSelector: (results) => results.find(r => r.taskId === 'task-2')!,
      });

      expect(result.output).toContain('task-2');
    });
  });

  describe('aggregateDirect', () => {
    it('should aggregate results directly', () => {
      const result = aggregator.aggregateDirect([
        createMockResult('task-1', 'completed', 'Output 1'),
        createMockResult('task-2', 'completed', 'Output 2'),
      ]);

      expect(result.metadata.totalTasks).toBe(2);
      expect(result.metadata.successfulTasks).toBe(2);
    });
  });

  describe('metadata and errors', () => {
    it('should report metadata correctly', () => {
      aggregator.addResults([
        createMockResult('task-1', 'completed'),
        createMockResult('task-2', 'failed', undefined),
        { ...createMockResult('task-3', 'failed'), error: 'Error message' },
      ]);

      const result = aggregator.aggregate();

      expect(result.metadata.totalTasks).toBe(3);
      expect(result.metadata.successfulTasks).toBe(1);
      expect(result.metadata.failedTasks).toBe(2);
      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(2);
    });

    it('should report success when all tasks succeed', () => {
      aggregator.addResults([
        createMockResult('task-1', 'completed'),
        createMockResult('task-2', 'completed'),
      ]);

      const result = aggregator.aggregate();

      expect(result.success).toBe(true);
      expect(result.errors).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('should clear all results', () => {
      aggregator.addResults([createMockResult('task-1')]);
      aggregator.setExpectedTotal(1);

      aggregator.clear();

      expect(aggregator.getProgress().collected).toBe(0);
      expect(aggregator.getProgress().total).toBe(0);
    });
  });
});
