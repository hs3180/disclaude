/**
 * Tests for TaskPlanExtractor.
 */

import { describe, it, expect } from 'vitest';
import { TaskPlanExtractor } from './task-plan-extractor.js';

describe('TaskPlanExtractor', () => {
  const extractor = new TaskPlanExtractor();

  describe('extract', () => {
    it('should extract title from markdown headers', () => {
      const output = `# Analyze Codebase

This is a task to analyze the codebase.`;
      const result = extractor.extract(output, 'analyze the codebase');

      expect(result?.title).toBe('Analyze Codebase');
    });

    it('should default to Untitled Task when no header found', () => {
      const output = `This is just some text without headers.`;
      const result = extractor.extract(output, 'test');

      expect(result?.title).toBe('Untitled Task');
    });

    it('should extract milestones from numbered lists', () => {
      const output = `# Task

Steps:
1. First step
2. Second step
3. Third step`;
      const result = extractor.extract(output, 'test');

      expect(result?.milestones).toEqual(['First step', 'Second step', 'Third step']);
    });

    it('should extract milestones from bullet points', () => {
      const output = `# Task

- First milestone
- Second milestone
- Third milestone`;
      const result = extractor.extract(output, 'test');

      expect(result?.milestones).toEqual(['First milestone', 'Second milestone', 'Third milestone']);
    });

    it('should detect milestones section header', () => {
      const output = `# Task

## Milestones

- Item 1
- Item 2`;

      const result = extractor.extract(output, 'test');

      expect(result?.milestones).toEqual(['Item 1', 'Item 2']);
    });

    it('should generate unique task IDs', () => {
      const output = '# Task';
      const result1 = extractor.extract(output, 'test');
      const result2 = extractor.extract(output, 'test');

      expect(result1?.taskId).not.toBe(result2?.taskId);
    });

    it('should include original request in result', () => {
      const output = '# Task';
      const originalRequest = 'analyze the codebase';
      const result = extractor.extract(output, originalRequest);

      expect(result?.originalRequest).toBe(originalRequest);
    });

    it('should include createdAt timestamp', () => {
      const output = '# Task';
      const before = new Date().toISOString();
      const result = extractor.extract(output, 'test');
      const after = new Date().toISOString();

      // ISO timestamp strings can be compared lexicographically
      expect(result).toBeDefined();
      expect(result!.createdAt >= before).toBe(true);
      expect(result!.createdAt <= after).toBe(true);
    });

    it('should use shorter description when milestones exist', () => {
      const longText = 'a'.repeat(1000);
      const output = `# Task

- Milestone 1

${longText}`;
      const result = extractor.extract(output, 'test');

      // Description should be truncated to 500 chars when milestones exist
      expect(result?.description.length).toBeLessThanOrEqual(500);
    });

    it('should use longer description when no milestones', () => {
      const longText = 'a'.repeat(1000);
      const output = `# Task\n\n${longText}`;
      const result = extractor.extract(output, 'test');

      // Description should be truncated to 1000 chars when no milestones
      expect(result?.description.length).toBeLessThanOrEqual(1000);
    });
  });

  describe('with custom taskId generator', () => {
    it('should use custom taskId generator', () => {
      const customId = 'custom-task-id-123';
      const extractor = new TaskPlanExtractor({
        generateTaskId: () => customId,
      });

      const result = extractor.extract('# Task', 'test');

      expect(result?.taskId).toBe(customId);
    });
  });
});
