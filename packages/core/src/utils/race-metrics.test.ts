/**
 * Tests for RaceMetricsCollector (packages/core/src/utils/race-metrics.ts)
 */

import { describe, it, expect, vi } from 'vitest';
import { RaceMetricsCollector, type RaceMetrics } from './race-metrics.js';

describe('RaceMetricsCollector', () => {
  const defaultOptions = {
    agentType: 'skillAgent',
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    taskType: 'coding',
  };

  describe('construction', () => {
    it('should create collector with required options', () => {
      const collector = new RaceMetricsCollector(defaultOptions);
      expect(collector.getSnapshot()).toEqual({
        agentType: 'skillAgent',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        taskType: 'coding',
        elapsedMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        toolCalls: 0,
        success: true,
      });
    });
  });

  describe('recordMessage', () => {
    it('should accumulate metrics from multiple messages', () => {
      const collector = new RaceMetricsCollector(defaultOptions);

      collector.recordMessage({
        elapsedMs: 1000,
        inputTokens: 500,
        outputTokens: 200,
        costUsd: 0.01,
      }, 'text');

      collector.recordMessage({
        elapsedMs: 2000,
        inputTokens: 300,
        outputTokens: 400,
        costUsd: 0.02,
      }, 'text');

      const snapshot = collector.getSnapshot();
      expect(snapshot.elapsedMs).toBe(3000);
      expect(snapshot.inputTokens).toBe(800);
      expect(snapshot.outputTokens).toBe(600);
      expect(snapshot.costUsd).toBe(0.03);
    });

    it('should count tool_use messages as tool calls', () => {
      const collector = new RaceMetricsCollector(defaultOptions);

      collector.recordMessage({ toolName: 'Read' }, 'tool_use');
      collector.recordMessage({ toolName: 'Write' }, 'tool_use');
      collector.recordMessage({}, 'text');

      expect(collector.getSnapshot().toolCalls).toBe(2);
    });

    it('should mark as failed on error messages', () => {
      const collector = new RaceMetricsCollector(defaultOptions);

      collector.recordMessage({}, 'error');

      expect(collector.getSnapshot().success).toBe(false);
    });

    it('should handle undefined metadata gracefully', () => {
      const collector = new RaceMetricsCollector(defaultOptions);

      collector.recordMessage(undefined, 'text');

      expect(collector.getSnapshot()).toEqual({
        agentType: 'skillAgent',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        taskType: 'coding',
        elapsedMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        toolCalls: 0,
        success: true,
      });
    });

    it('should handle partial metadata fields', () => {
      const collector = new RaceMetricsCollector(defaultOptions);

      collector.recordMessage({ elapsedMs: 500 }, 'text');
      collector.recordMessage({ inputTokens: 100, costUsd: 0.005 }, 'text');

      const snapshot = collector.getSnapshot();
      expect(snapshot.elapsedMs).toBe(500);
      expect(snapshot.inputTokens).toBe(100);
      expect(snapshot.outputTokens).toBe(0);
      expect(snapshot.costUsd).toBe(0.005);
    });
  });

  describe('recordToolCall', () => {
    it('should increment tool call count', () => {
      const collector = new RaceMetricsCollector(defaultOptions);

      collector.recordToolCall();
      collector.recordToolCall();
      collector.recordToolCall();

      expect(collector.getSnapshot().toolCalls).toBe(3);
    });
  });

  describe('markFailed', () => {
    it('should set success to false', () => {
      const collector = new RaceMetricsCollector(defaultOptions);

      expect(collector.getSnapshot().success).toBe(true);
      collector.markFailed();
      expect(collector.getSnapshot().success).toBe(false);
    });
  });

  describe('finalize', () => {
    it('should return RaceMetrics with keyword and timestamp', () => {
      const collector = new RaceMetricsCollector(defaultOptions);

      collector.recordMessage({
        elapsedMs: 5000,
        inputTokens: 1000,
        outputTokens: 500,
        costUsd: 0.05,
      }, 'text');

      const metrics = collector.finalize();

      expect(metrics.keyword).toBe('race-metrics');
      expect(metrics.timestamp).toBeDefined();
      expect(new Date(metrics.timestamp).getTime()).not.toBeNaN();
      expect(metrics.elapsedMs).toBe(5000);
      expect(metrics.inputTokens).toBe(1000);
      expect(metrics.outputTokens).toBe(500);
      expect(metrics.costUsd).toBe(0.05);
      expect(metrics.success).toBe(true);
      expect(metrics.toolCalls).toBe(0);
    });

    it('should round costUsd to 6 decimal places', () => {
      const collector = new RaceMetricsCollector(defaultOptions);

      collector.recordMessage({ costUsd: 0.123456789 }, 'text');

      const metrics = collector.finalize();
      expect(metrics.costUsd).toBe(0.123457);
    });

    it('should include all configuration fields', () => {
      const collector = new RaceMetricsCollector({
        agentType: 'chatAgent',
        provider: 'openai',
        model: 'gpt-4o',
        taskType: 'analysis',
      });

      const metrics = collector.finalize();

      expect(metrics.agentType).toBe('chatAgent');
      expect(metrics.provider).toBe('openai');
      expect(metrics.model).toBe('gpt-4o');
      expect(metrics.taskType).toBe('analysis');
    });

    it('should return same result on subsequent finalize calls', () => {
      const collector = new RaceMetricsCollector(defaultOptions);

      collector.recordMessage({ elapsedMs: 100 }, 'text');

      const metrics1 = collector.finalize();
      const metrics2 = collector.finalize();

      expect(metrics1).toEqual(metrics2);
    });

    it('should log at info level', () => {
      const infoFn = vi.fn();
      const mockLogger = {
        info: infoFn,
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn().mockReturnThis(),
      } as unknown as import('pino').Logger;

      const collector = new RaceMetricsCollector({
        ...defaultOptions,
        logger: mockLogger,
      });

      collector.finalize();

      expect(infoFn).toHaveBeenCalledTimes(1);
      const loggedData = infoFn.mock.calls[0][0] as RaceMetrics;
      expect(loggedData.keyword).toBe('race-metrics');
    });
  });

  describe('full execution scenario', () => {
    it('should track a realistic agent execution lifecycle', () => {
      const collector = new RaceMetricsCollector(defaultOptions);

      // Simulate: text response
      collector.recordMessage({
        elapsedMs: 150,
        inputTokens: 2000,
        outputTokens: 100,
        costUsd: 0.006,
      }, 'text');

      // Simulate: tool call
      collector.recordMessage({
        elapsedMs: 50,
        toolName: 'Read',
        inputTokens: 0,
        outputTokens: 50,
        costUsd: 0.001,
      }, 'tool_use');

      // Simulate: tool result
      collector.recordMessage({
        elapsedMs: 200,
        toolName: 'Read',
      }, 'tool_result');

      // Simulate: another tool call
      collector.recordMessage({
        elapsedMs: 80,
        toolName: 'Write',
        inputTokens: 0,
        outputTokens: 80,
        costUsd: 0.002,
      }, 'tool_use');

      // Simulate: tool result
      collector.recordMessage({
        elapsedMs: 300,
        toolName: 'Write',
      }, 'tool_result');

      // Simulate: final text response
      collector.recordMessage({
        elapsedMs: 2000,
        inputTokens: 3000,
        outputTokens: 500,
        costUsd: 0.015,
      }, 'text');

      // Simulate: result message
      collector.recordMessage({
        elapsedMs: 0,
        costUsd: 0,
      }, 'result');

      const metrics = collector.finalize();

      expect(metrics.elapsedMs).toBe(2780);
      expect(metrics.inputTokens).toBe(5000);
      expect(metrics.outputTokens).toBe(730);
      expect(metrics.costUsd).toBe(0.024);
      expect(metrics.toolCalls).toBe(2);
      expect(metrics.success).toBe(true);
    });

    it('should track execution with errors', () => {
      const collector = new RaceMetricsCollector(defaultOptions);

      collector.recordMessage({
        elapsedMs: 500,
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.003,
      }, 'text');

      collector.recordMessage({}, 'error');

      const metrics = collector.finalize();
      expect(metrics.success).toBe(false);
      expect(metrics.elapsedMs).toBe(500);
    });
  });
});
