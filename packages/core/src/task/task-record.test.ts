/**
 * Tests for TaskRecordService.
 *
 * Verifies Markdown-based task record creation, parsing, and retrieval.
 *
 * Issue #1234: Phase 1 - Task ETA Estimation System.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TaskRecordService, type TaskRecordInput } from './task-record.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-record-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('TaskRecordService', () => {
  let service: TaskRecordService;

  beforeEach(() => {
    service = new TaskRecordService(tempDir);
  });

  describe('constructor', () => {
    it('should create service with workspace directory', () => {
      expect(service).toBeInstanceOf(TaskRecordService);
    });

    it('should set records path to .claude/task-records.md', () => {
      expect(service.getRecordsPath()).toContain('.claude');
      expect(service.getRecordsPath()).toContain('task-records.md');
    });
  });

  describe('initialize', () => {
    it('should create .claude directory and records file', async () => {
      await service.initialize();

      const claudeDir = path.join(tempDir, '.claude');
      const stat = await fs.stat(claudeDir);
      expect(stat.isDirectory()).toBe(true);

      const content = await fs.readFile(service.getRecordsPath(), 'utf-8');
      expect(content).toContain('Task Records');
    });

    it('should not overwrite existing file', async () => {
      await service.initialize();
      await service.appendRecord({
        title: 'Test Task',
        type: 'bugfix',
        estimatedMinutes: 10,
        estimationBasis: 'Test',
      });

      const contentBefore = await fs.readFile(service.getRecordsPath(), 'utf-8');
      await service.initialize();
      const contentAfter = await fs.readFile(service.getRecordsPath(), 'utf-8');

      expect(contentBefore).toBe(contentAfter);
    });
  });

  describe('appendRecord', () => {
    it('should append a complete task record', async () => {
      const record: TaskRecordInput = {
        title: 'Refactor Login Module',
        type: 'refactoring',
        estimatedMinutes: 30,
        estimationBasis: 'Similar to form refactoring, took 25 minutes',
        actualMinutes: 45,
        review: 'Underestimated password validation complexity',
      };

      await service.appendRecord(record);

      const content = await fs.readFile(service.getRecordsPath(), 'utf-8');
      expect(content).toContain('## ');
      expect(content).toContain('Refactor Login Module');
      expect(content).toContain('**Type**: refactoring');
      expect(content).toContain('**Estimated Time**: 30 minutes');
      expect(content).toContain('**Estimation Basis**: Similar to form refactoring');
      expect(content).toContain('**Actual Time**: 45 minutes');
      expect(content).toContain('**Review**: Underestimated');
    });

    it('should append record without optional fields', async () => {
      const record: TaskRecordInput = {
        title: 'Fix typo in README',
        type: 'bugfix',
        estimatedMinutes: 5,
        estimationBasis: 'Simple text change',
      };

      await service.appendRecord(record);

      const content = await fs.readFile(service.getRecordsPath(), 'utf-8');
      expect(content).toContain('Fix typo in README');
      expect(content).toContain('**Estimated Time**: 5 minutes');
      expect(content).not.toContain('**Actual Time**');
      expect(content).not.toContain('**Review**');
    });

    it('should include timestamps when provided', async () => {
      const record: TaskRecordInput = {
        title: 'Build API',
        type: 'feature',
        estimatedMinutes: 60,
        estimationBasis: 'Standard CRUD',
        startedAt: '2026-04-24T10:00:00Z',
        completedAt: '2026-04-24T11:15:00Z',
        actualMinutes: 75,
      };

      await service.appendRecord(record);

      const content = await fs.readFile(service.getRecordsPath(), 'utf-8');
      expect(content).toContain('**Started At**: 2026-04-24T10:00:00Z');
      expect(content).toContain('**Completed At**: 2026-04-24T11:15:00Z');
    });

    it('should use startedAt date in section header', async () => {
      const record: TaskRecordInput = {
        title: 'Test Task',
        type: 'test',
        estimatedMinutes: 10,
        estimationBasis: 'Test',
        startedAt: '2026-03-15T08:00:00Z',
      };

      await service.appendRecord(record);

      const content = await fs.readFile(service.getRecordsPath(), 'utf-8');
      expect(content).toContain('## 2026-03-15 Test Task');
    });

    it('should append multiple records', async () => {
      await service.appendRecord({
        title: 'First Task',
        type: 'bugfix',
        estimatedMinutes: 10,
        estimationBasis: 'Quick fix',
      });

      await service.appendRecord({
        title: 'Second Task',
        type: 'feature',
        estimatedMinutes: 30,
        estimationBasis: 'New endpoint',
      });

      const records = await service.readRecords();
      expect(records).toHaveLength(2);
      // Newest first
      expect(records[0].title).toBe('Second Task');
      expect(records[1].title).toBe('First Task');
    });
  });

  describe('readRecords', () => {
    it('should return empty array when no records file exists', async () => {
      const records = await service.readRecords();
      expect(records).toEqual([]);
    });

    it('should parse a single record', async () => {
      await service.appendRecord({
        title: 'Test Parse',
        type: 'feature',
        estimatedMinutes: 20,
        estimationBasis: 'Similar to previous task',
        actualMinutes: 25,
        review: 'Slightly underestimated',
      });

      const records = await service.readRecords();
      expect(records).toHaveLength(1);
      expect(records[0].title).toBe('Test Parse');
      expect(records[0].type).toBe('feature');
      expect(records[0].estimatedMinutes).toBe(20);
      expect(records[0].estimationBasis).toBe('Similar to previous task');
      expect(records[0].actualMinutes).toBe(25);
      expect(records[0].review).toBe('Slightly underestimated');
    });

    it('should parse multiple records with correct order', async () => {
      await service.appendRecord({
        title: 'Oldest',
        type: 'bugfix',
        estimatedMinutes: 5,
        estimationBasis: 'First',
      });
      await service.appendRecord({
        title: 'Middle',
        type: 'feature',
        estimatedMinutes: 15,
        estimationBasis: 'Second',
      });
      await service.appendRecord({
        title: 'Newest',
        type: 'refactoring',
        estimatedMinutes: 30,
        estimationBasis: 'Third',
      });

      const records = await service.readRecords();
      expect(records).toHaveLength(3);
      expect(records[0].title).toBe('Newest');
      expect(records[1].title).toBe('Middle');
      expect(records[2].title).toBe('Oldest');
    });

    it('should handle records without optional fields', async () => {
      await service.appendRecord({
        title: 'Minimal Record',
        type: 'chore',
        estimatedMinutes: 10,
        estimationBasis: 'Test',
      });

      const records = await service.readRecords();
      expect(records[0].actualMinutes).toBeUndefined();
      expect(records[0].review).toBeUndefined();
      expect(records[0].startedAt).toBeUndefined();
      expect(records[0].completedAt).toBeUndefined();
    });
  });

  describe('parseRecords', () => {
    it('should parse well-formed Markdown content', () => {
      const content = `# Task Records

> Auto-generated

---

## 2026-04-24 Refactor Login Module

- **Type**: refactoring
- **Estimated Time**: 30 minutes
- **Estimation Basis**: Similar to previous form task
- **Actual Time**: 45 minutes
- **Review**: Underestimated complexity

---

## 2026-04-23 Fix Bug in Parser

- **Type**: bugfix
- **Estimated Time**: 15 minutes
- **Estimation Basis**: Simple regex fix
- **Actual Time**: 10 minutes

---
`;

      const records = service.parseRecords(content);
      expect(records).toHaveLength(2);
      // Records are reversed: newest (last-in-file) first
      expect(records[0].title).toBe('Fix Bug in Parser');
      expect(records[0].date).toBe('2026-04-23');
      expect(records[0].type).toBe('bugfix');
      expect(records[0].estimatedMinutes).toBe(15);
      expect(records[0].actualMinutes).toBe(10);
      expect(records[1].title).toBe('Refactor Login Module');
      expect(records[1].date).toBe('2026-04-24');
      expect(records[1].type).toBe('refactoring');
      expect(records[1].estimatedMinutes).toBe(30);
      expect(records[1].actualMinutes).toBe(45);
    });

    it('should handle empty content', () => {
      const records = service.parseRecords('');
      expect(records).toEqual([]);
    });

    it('should skip non-section content', () => {
      const content = `# Header

Some text without sections.

---
`;
      const records = service.parseRecords(content);
      expect(records).toEqual([]);
    });
  });

  describe('findSimilarRecords', () => {
    beforeEach(async () => {
      await service.appendRecord({
        title: 'Refactor Login Module',
        type: 'refactoring',
        estimatedMinutes: 30,
        estimationBasis: 'Similar to form refactoring',
        actualMinutes: 45,
        review: 'Password validation was complex',
      });
      await service.appendRecord({
        title: 'Build User API',
        type: 'feature',
        estimatedMinutes: 60,
        estimationBasis: 'Standard CRUD endpoint',
        actualMinutes: 55,
      });
      await service.appendRecord({
        title: 'Fix Login Bug',
        type: 'bugfix',
        estimatedMinutes: 15,
        estimationBasis: 'Simple authentication fix',
        actualMinutes: 20,
      });
    });

    it('should find records by title keyword', async () => {
      const results = await service.findSimilarRecords('Login');
      expect(results.length).toBeGreaterThanOrEqual(2);
      const titles = results.map(r => r.title);
      expect(titles).toContain('Refactor Login Module');
      expect(titles).toContain('Fix Login Bug');
    });

    it('should find records by type', async () => {
      const results = await service.findSimilarRecords('bugfix');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some(r => r.type === 'bugfix')).toBe(true);
    });

    it('should find records by review content', async () => {
      const results = await service.findSimilarRecords('password');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some(r => r.title === 'Refactor Login Module')).toBe(true);
    });

    it('should return empty for no matches', async () => {
      const results = await service.findSimilarRecords('nonexistent-xyz');
      expect(results).toEqual([]);
    });

    it('should respect limit parameter', async () => {
      const results = await service.findSimilarRecords('Login', 1);
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it('should return all records for empty keywords', async () => {
      const results = await service.findSimilarRecords('', 10);
      expect(results.length).toBe(3);
    });
  });

  describe('getStats', () => {
    it('should return zero stats for no records', async () => {
      const stats = await service.getStats();
      expect(stats.totalRecords).toBe(0);
      expect(stats.averageEstimateMinutes).toBe(0);
      expect(stats.averageActualMinutes).toBe(0);
      expect(stats.averageAccuracy).toBe(0);
    });

    it('should calculate correct statistics', async () => {
      await service.appendRecord({
        title: 'Task 1',
        type: 'bugfix',
        estimatedMinutes: 10,
        estimationBasis: 'Test',
        actualMinutes: 15,
      });
      await service.appendRecord({
        title: 'Task 2',
        type: 'bugfix',
        estimatedMinutes: 20,
        estimationBasis: 'Test',
        actualMinutes: 20,
      });
      await service.appendRecord({
        title: 'Task 3',
        type: 'feature',
        estimatedMinutes: 60,
        estimationBasis: 'Test',
        // No actual time
      });

      const stats = await service.getStats();
      expect(stats.totalRecords).toBe(3);
      expect(stats.byType['bugfix']).toBe(2);
      expect(stats.byType['feature']).toBe(1);
      expect(stats.averageEstimateMinutes).toBe(30); // (10+20+60)/3
      expect(stats.averageActualMinutes).toBe(18); // (15+20)/2
      // Accuracy: (15/10 + 20/20) / 2 = (1.5 + 1.0) / 2 = 1.25
      expect(stats.averageAccuracy).toBe(1.25);
    });
  });

  describe('exists', () => {
    it('should return false when file does not exist', async () => {
      expect(await service.exists()).toBe(false);
    });

    it('should return true after initialization', async () => {
      await service.initialize();
      expect(await service.exists()).toBe(true);
    });
  });

  describe('getRecordCount', () => {
    it('should return 0 for no records', async () => {
      expect(await service.getRecordCount()).toBe(0);
    });

    it('should count records correctly', async () => {
      await service.appendRecord({
        title: 'Task 1',
        type: 'bugfix',
        estimatedMinutes: 10,
        estimationBasis: 'Test',
      });
      await service.appendRecord({
        title: 'Task 2',
        type: 'feature',
        estimatedMinutes: 20,
        estimationBasis: 'Test',
      });

      expect(await service.getRecordCount()).toBe(2);
    });
  });

  describe('readRawContent', () => {
    it('should return empty string when file does not exist', async () => {
      expect(await service.readRawContent()).toBe('');
    });

    it('should return raw Markdown content', async () => {
      await service.appendRecord({
        title: 'Test',
        type: 'bugfix',
        estimatedMinutes: 10,
        estimationBasis: 'Test basis',
      });

      const content = await service.readRawContent();
      expect(content).toContain('## ');
      expect(content).toContain('Test');
    });
  });

  describe('completeLatestPending', () => {
    it('should update latest record without actual time', async () => {
      await service.appendRecord({
        title: 'Pending Task',
        type: 'feature',
        estimatedMinutes: 30,
        estimationBasis: 'Test',
      });

      const result = await service.completeLatestPending(35, 'Slightly underestimated');
      expect(result).toBe(true);

      const records = await service.readRecords();
      expect(records[0].actualMinutes).toBe(35);
      expect(records[0].review).toBe('Slightly underestimated');
    });

    it('should update without review', async () => {
      await service.appendRecord({
        title: 'Another Pending',
        type: 'bugfix',
        estimatedMinutes: 10,
        estimationBasis: 'Test',
      });

      const result = await service.completeLatestPending(12);
      expect(result).toBe(true);

      const records = await service.readRecords();
      expect(records[0].actualMinutes).toBe(12);
    });

    it('should return false when no pending records', async () => {
      await service.appendRecord({
        title: 'Completed Task',
        type: 'bugfix',
        estimatedMinutes: 10,
        estimationBasis: 'Test',
        actualMinutes: 12,
      });

      const result = await service.completeLatestPending(15);
      expect(result).toBe(false);
    });

    it('should return false when no records exist', async () => {
      const result = await service.completeLatestPending(10);
      expect(result).toBe(false);
    });

    it('should only update the latest pending record, not all', async () => {
      await service.appendRecord({
        title: 'First Pending',
        type: 'bugfix',
        estimatedMinutes: 10,
        estimationBasis: 'First',
      });
      await service.appendRecord({
        title: 'Second Pending',
        type: 'feature',
        estimatedMinutes: 30,
        estimationBasis: 'Second',
      });

      await service.completeLatestPending(25);

      const records = await service.readRecords();
      // Newest record updated
      expect(records[0].actualMinutes).toBe(25);
      expect(records[0].title).toBe('Second Pending');
      // Older record unchanged
      expect(records[1].actualMinutes).toBeUndefined();
      expect(records[1].title).toBe('First Pending');
    });
  });
});
