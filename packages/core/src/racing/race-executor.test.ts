/**
 * Race Executor Unit Tests
 *
 * Tests for the Agent Framework Racing execution engine.
 * Uses mocked providers to avoid external SDK dependencies.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RaceExecutor } from './race-executor.js';
import { RaceReportGenerator } from './race-report.js';
import type {
  RaceConfig,
} from './types.js';

// ============================================================================
// Helper Functions
// ============================================================================

function createBasicConfig(overrides?: Partial<RaceConfig>): RaceConfig {
  return {
    id: 'test-race',
    name: 'Test Race',
    participants: [
      {
        id: 'fast-provider',
        name: 'Fast Provider',
        providerType: 'claude',
        model: 'test-model-fast',
      },
      {
        id: 'slow-provider',
        name: 'Slow Provider',
        providerType: 'claude',
        model: 'test-model-slow',
      },
    ],
    tasks: [
      {
        id: 'task-1',
        description: 'Test task',
        category: 'test',
        input: 'Hello',
        mode: 'queryOnce',
      },
    ],
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('RaceExecutor', () => {
  let executor: RaceExecutor;

  beforeEach(() => {
    executor = new RaceExecutor();
  });

  // ==========================================================================
  // Configuration Validation
  // ==========================================================================

  describe('configuration validation', () => {
    it('should throw if race has no id', async () => {
      const config = createBasicConfig();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any).id = '';
      await expect(executor.run(config)).rejects.toThrow('must have an id');
    });

    it('should throw if race has no name', async () => {
      const config = createBasicConfig();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any).name = '';
      await expect(executor.run(config)).rejects.toThrow('must have a name');
    });

    it('should throw if race has less than 2 participants', async () => {
      const config = createBasicConfig({ participants: [createBasicConfig().participants[0]] });
      await expect(executor.run(config)).rejects.toThrow('at least 2 participants');
    });

    it('should throw if race has no tasks', async () => {
      const config = createBasicConfig({ tasks: [] });
      await expect(executor.run(config)).rejects.toThrow('at least 1 task');
    });

    it('should throw if participant IDs are not unique', async () => {
      const p = createBasicConfig().participants[0];
      const config = createBasicConfig({ participants: [p, p] });
      await expect(executor.run(config)).rejects.toThrow('unique');
    });

    it('should throw if task IDs are not unique', async () => {
      const t = createBasicConfig().tasks[0];
      const config = createBasicConfig({ tasks: [t, t] });
      await expect(executor.run(config)).rejects.toThrow('unique');
    });
  });

  // ==========================================================================
  // Race Execution
  // ==========================================================================

  describe('race execution', () => {
    it('should return a result with correct structure', async () => {
      const config = createBasicConfig();

      const result = await executor.run(config);

      expect(result).toBeDefined();
      expect(result.config).toBe(config);
      expect(result.taskResults).toHaveLength(1);
      expect(result.overallStandings).toBeDefined();
      expect(result.startedAt).toBeGreaterThan(0);
      expect(result.completedAt).toBeGreaterThanOrEqual(result.startedAt);
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('should execute all participants for each task', async () => {
      const config = createBasicConfig();

      const result = await executor.run(config);
      const taskResult = result.taskResults[0];

      expect(taskResult.participantResults).toHaveLength(2);
      expect(taskResult.rankings).toHaveLength(2);
    });

    it('should collect metrics for each participant', async () => {
      const config = createBasicConfig();

      const result = await executor.run(config);
      const taskResult = result.taskResults[0];

      for (const pr of taskResult.participantResults) {
        expect(pr.metrics).toBeDefined();
        expect(pr.metrics.totalElapsedMs).toBeGreaterThanOrEqual(0);
        expect(pr.metrics.messageCount).toBeGreaterThanOrEqual(0);
        expect(typeof pr.metrics.hasError).toBe('boolean');
      }
    });

    it('should produce rankings sorted by score', async () => {
      const config = createBasicConfig();

      const result = await executor.run(config);
      const taskResult = result.taskResults[0];

      const scores = taskResult.rankings.map(r => r.score);
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
      }

      expect(taskResult.rankings[0].rank).toBe(1);
      expect(taskResult.rankings[1].rank).toBe(2);
    });

    it('should produce overall standings', async () => {
      const config = createBasicConfig({
        tasks: [
          {
            id: 'task-1',
            description: 'Task 1',
            category: 'test',
            input: 'Hello',
            mode: 'queryOnce',
          },
          {
            id: 'task-2',
            description: 'Task 2',
            category: 'test',
            input: 'World',
            mode: 'queryOnce',
          },
        ],
      });

      const result = await executor.run(config);

      expect(result.overallStandings).toHaveLength(2);
      expect(result.overallStandings[0].rank).toBe(1);
      expect(result.overallStandings[1].rank).toBe(2);
    });
  });

  // ==========================================================================
  // Quality Evaluation
  // ==========================================================================

  describe('quality evaluation', () => {
    it('should evaluate quality when expectedOutput is a string', async () => {
      const config = createBasicConfig({
        tasks: [
          {
            id: 'task-1',
            description: 'Test task',
            category: 'test',
            input: 'Hello',
            mode: 'queryOnce',
            expectedOutput: 'hello',
          },
        ],
      });

      const result = await executor.run(config);
      const pr = result.taskResults[0].participantResults[0];

      expect(pr.quality).toBeDefined();
      expect(typeof pr.quality!.passed).toBe('boolean');
      expect(typeof pr.quality!.score).toBe('number');
    });

    it('should evaluate quality when expectedOutput is a function', async () => {
      const config = createBasicConfig({
        tasks: [
          {
            id: 'task-1',
            description: 'Test task',
            category: 'test',
            input: 'Hello',
            mode: 'queryOnce',
            expectedOutput: (output: string) => typeof output === 'string',
          },
        ],
      });

      const result = await executor.run(config);
      const pr = result.taskResults[0].participantResults[0];

      expect(pr.quality).toBeDefined();
      expect(typeof pr.quality!.passed).toBe('boolean');
      // The function should be called with the output (even if empty due to provider error)
      expect(pr.quality!.score).toBeGreaterThanOrEqual(0);
    });

    it('should not evaluate quality when expectedOutput is undefined', async () => {
      const config = createBasicConfig();
      const result = await executor.run(config);
      const pr = result.taskResults[0].participantResults[0];

      expect(pr.quality).toBeUndefined();
    });
  });

  // ==========================================================================
  // Callbacks
  // ==========================================================================

  describe('callbacks', () => {
    it('should call onRaceStart and onRaceComplete', async () => {
      const onRaceStart = vi.fn();
      const onRaceComplete = vi.fn();
      const config = createBasicConfig({
        callbacks: { onRaceStart, onRaceComplete },
      });

      await executor.run(config);

      expect(onRaceStart).toHaveBeenCalledOnce();
      expect(onRaceComplete).toHaveBeenCalledOnce();
    });

    it('should call onParticipantStart and onParticipantComplete for each participant', async () => {
      const onParticipantStart = vi.fn();
      const onParticipantComplete = vi.fn();
      const config = createBasicConfig({
        callbacks: { onParticipantStart, onParticipantComplete },
      });

      await executor.run(config);

      expect(onParticipantStart).toHaveBeenCalledTimes(2);
      expect(onParticipantComplete).toHaveBeenCalledTimes(2);
    });

    it('should call onTaskComplete for each task', async () => {
      const onTaskComplete = vi.fn();
      const config = createBasicConfig({
        callbacks: { onTaskComplete },
        tasks: [
          { id: 't1', description: 'Task 1', category: 'test', input: 'a', mode: 'queryOnce' },
          { id: 't2', description: 'Task 2', category: 'test', input: 'b', mode: 'queryOnce' },
        ],
      });

      await executor.run(config);

      expect(onTaskComplete).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // State Management
  // ==========================================================================

  describe('state management', () => {
    it('should start in pending state', () => {
      expect(executor.getState()).toBe('pending');
    });

    it('should transition to completed after run', async () => {
      await executor.run(createBasicConfig());
      expect(executor.getState()).toBe('completed');
    });

    it('should provide progress during execution', async () => {
      const config = createBasicConfig();
      const runPromise = executor.run(config);

      // Check progress during run (may be pending or running)
      const progress = executor.getProgress();
      expect(progress).not.toBeNull();
      expect(progress!.totalTasks).toBe(1);
      expect(progress!.totalParticipants).toBe(2);

      await runPromise;

      // After completion
      expect(executor.getProgress()!.state).toBe('completed');
      expect(executor.getProgress()!.completedTasks).toBe(1);
      expect(executor.getProgress()!.completedParticipants).toBe(2);
    });
  });
});

// ============================================================================
// Report Generator Tests
// ============================================================================

describe('RaceReportGenerator', () => {
  it('should generate markdown report', async () => {
    const executor = new RaceExecutor();
    const result = await executor.run(createBasicConfig());

    const report = RaceReportGenerator.generate(result, { format: 'markdown' });

    expect(report).toContain('Race Report');
    expect(report).toContain('Overall Standings');
    expect(report).toContain('Fast Provider');
    expect(report).toContain('Slow Provider');
    expect(report).toContain('| Rank |');
  });

  it('should generate text report', async () => {
    const executor = new RaceExecutor();
    const result = await executor.run(createBasicConfig());

    const report = RaceReportGenerator.generate(result, { format: 'text' });

    expect(report).toContain('Race Report');
    expect(report).toContain('OVERALL STANDINGS');
    expect(report).toContain('Fast Provider');
    expect(report).toContain('Slow Provider');
  });

  it('should include task breakdown when configured', async () => {
    const executor = new RaceExecutor();
    const result = await executor.run(createBasicConfig());

    const report = RaceReportGenerator.generate(result, {
      format: 'markdown',
      includeTaskBreakdown: true,
    });

    expect(report).toContain('Task Breakdown');
    expect(report).toContain('Test task');
  });

  it('should use custom title', async () => {
    const executor = new RaceExecutor();
    const result = await executor.run(createBasicConfig());

    const report = RaceReportGenerator.generate(result, {
      format: 'markdown',
      title: 'Custom Title',
    });

    expect(report).toContain('Custom Title');
  });
});
