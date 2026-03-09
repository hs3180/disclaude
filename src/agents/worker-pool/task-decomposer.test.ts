/**
 * Tests for Task Decomposer.
 *
 * Issue #897 Phase 2: Master-Workers multi-agent collaboration pattern.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TaskDecomposer } from './task-decomposer.js';

describe('TaskDecomposer', () => {
  let decomposer: TaskDecomposer;
  const mockCallbacks = {
    sendMessage: async () => {},
    sendCard: async () => {},
    sendFile: async () => {},
  };

  beforeEach(() => {
    decomposer = new TaskDecomposer();
  });

  describe('decompose', () => {
    it('should decompose a task into subtasks', () => {
      const result = decomposer.decompose(
        {
          parentTaskId: 'analyze-project',
          chatId: 'chat-123',
          callbacks: mockCallbacks,
        },
        [
          { id: 'read-config', name: 'Read Config', prompt: 'Read the config file' },
          { id: 'analyze-src', name: 'Analyze Source', prompt: 'Analyze source code' },
        ]
      );

      expect(result.subtasks).toHaveLength(2);
      expect(result.subtasks[0].id).toBe('analyze-project-read-config');
      expect(result.subtasks[0].name).toBe('Read Config');
      expect(result.subtasks[1].id).toBe('analyze-project-analyze-src');
    });

    it('should set up dependencies correctly', () => {
      const result = decomposer.decompose(
        {
          parentTaskId: 'pipeline',
          chatId: 'chat-123',
          callbacks: mockCallbacks,
        },
        [
          { id: 'step1', name: 'Step 1', prompt: 'First step' },
          { id: 'step2', name: 'Step 2', prompt: 'Second step', dependsOn: ['step1'] },
          { id: 'step3', name: 'Step 3', prompt: 'Third step', dependsOn: ['step2'] },
        ]
      );

      expect(result.subtasks[0].dependencies).toHaveLength(0);
      expect(result.subtasks[1].dependencies).toHaveLength(1);
      expect(result.subtasks[1].dependencies![0].taskId).toBe('pipeline-step1');
      expect(result.subtasks[2].dependencies![0].taskId).toBe('pipeline-step2');
    });

    it('should calculate execution plan with waves', () => {
      const result = decomposer.decompose(
        {
          parentTaskId: 'parallel-tasks',
          chatId: 'chat-123',
          callbacks: mockCallbacks,
        },
        [
          { id: 'task-a', name: 'Task A', prompt: 'Do A' },
          { id: 'task-b', name: 'Task B', prompt: 'Do B' },
          { id: 'task-c', name: 'Task C', prompt: 'Do C', dependsOn: ['task-a', 'task-b'] },
        ]
      );

      // First wave: task-a and task-b (parallel)
      // Second wave: task-c (depends on both)
      expect(result.executionPlan.totalWaves).toBe(2);
      expect(result.executionPlan.waves[0]).toHaveLength(2);
      expect(result.executionPlan.waves[1]).toHaveLength(1);
      expect(result.executionPlan.maxParallelism).toBe(2);
    });

    it('should calculate critical path correctly', () => {
      const result = decomposer.decompose(
        {
          parentTaskId: 'critical-path-test',
          chatId: 'chat-123',
          callbacks: mockCallbacks,
        },
        [
          { id: 'a', name: 'A', prompt: 'A' },
          { id: 'b', name: 'B', prompt: 'B', dependsOn: ['a'] },
          { id: 'c', name: 'C', prompt: 'C', dependsOn: ['b'] },
          { id: 'd', name: 'D', prompt: 'D', dependsOn: ['a'] },
        ]
      );

      // Critical path should be a -> b -> c (3 nodes)
      expect(result.executionPlan.criticalPath).toHaveLength(3);
    });

    it('should handle empty subtask list', () => {
      const result = decomposer.decompose(
        {
          parentTaskId: 'empty',
          chatId: 'chat-123',
          callbacks: mockCallbacks,
        },
        []
      );

      expect(result.subtasks).toHaveLength(0);
      expect(result.executionPlan.totalWaves).toBe(0);
    });
  });

  describe('decomposeForFileAnalysis', () => {
    it('should create parallel tasks for file analysis', () => {
      const result = decomposer.decomposeForFileAnalysis(
        {
          parentTaskId: 'analyze-files',
          chatId: 'chat-123',
          callbacks: mockCallbacks,
        },
        ['file1.ts', 'file2.ts', 'file3.ts'],
        'Analyze {file}'
      );

      expect(result.subtasks).toHaveLength(3);
      expect(result.metadata.strategy).toBe('parallel');
      expect(result.executionPlan.totalWaves).toBe(1); // All parallel
    });
  });

  describe('decomposeForMultiSourceSearch', () => {
    it('should create search tasks with aggregation', () => {
      const result = decomposer.decomposeForMultiSourceSearch(
        {
          parentTaskId: 'multi-search',
          chatId: 'chat-123',
          callbacks: mockCallbacks,
        },
        ['source1', 'source2'],
        'test query'
      );

      // 2 search tasks + 1 aggregation task
      expect(result.subtasks).toHaveLength(3);
      expect(result.metadata.strategy).toBe('hybrid');

      // Last task should depend on search tasks
      const aggregateTask = result.subtasks[2];
      expect(aggregateTask.id).toContain('aggregate');
      expect(aggregateTask.dependencies).toHaveLength(2);
    });
  });

  describe('decomposePipeline', () => {
    it('should create sequential pipeline tasks', () => {
      const result = decomposer.decomposePipeline(
        {
          parentTaskId: 'pipeline',
          chatId: 'chat-123',
          callbacks: mockCallbacks,
        },
        [
          { id: 'fetch', name: 'Fetch', prompt: 'Fetch data' },
          { id: 'process', name: 'Process', prompt: 'Process data' },
          { id: 'save', name: 'Save', prompt: 'Save data' },
        ]
      );

      expect(result.subtasks).toHaveLength(3);
      expect(result.metadata.strategy).toBe('sequential');

      // Each task depends on the previous one
      expect(result.executionPlan.totalWaves).toBe(3);
      expect(result.executionPlan.maxParallelism).toBe(1);
    });
  });
});
