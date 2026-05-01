/**
 * Tests for ETARecorder.
 *
 * Verifies Markdown-based task record management for ETA estimation.
 * All storage is free-form Markdown, no structured serialization.
 *
 * Issue #1234: Task ETA estimation system (Phase 1)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ETARecorder, type TaskRecord } from './eta-recorder.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eta-recorder-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('ETARecorder', () => {
  let recorder: ETARecorder;

  beforeEach(() => {
    recorder = new ETARecorder({ workspaceDir: tempDir });
  });

  describe('constructor', () => {
    it('should create recorder with workspace directory', () => {
      expect(recorder).toBeInstanceOf(ETARecorder);
    });

    it('should set correct file paths', () => {
      expect(recorder.getTaskRecordsPath()).toContain('.claude');
      expect(recorder.getTaskRecordsPath()).toContain('task-records.md');
      expect(recorder.getETARulesPath()).toContain('eta-rules.md');
    });
  });

  describe('ensureTaskRecords', () => {
    it('should create task-records.md if it does not exist', async () => {
      const created = await recorder.ensureTaskRecords();
      expect(created).toBe(true);

      const content = await fs.readFile(recorder.getTaskRecordsPath(), 'utf-8');
      expect(content).toContain('# Task Records');
      expect(content).toContain('Historical task execution records');
    });

    it('should not overwrite existing task-records.md', async () => {
      await recorder.ensureTaskRecords();
      const created = await recorder.ensureTaskRecords();
      expect(created).toBe(false);
    });

    it('should create .claude directory if needed', async () => {
      await recorder.ensureTaskRecords();
      const stat = await fs.stat(path.join(tempDir, '.claude'));
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('ensureETARules', () => {
    it('should create eta-rules.md with template', async () => {
      const created = await recorder.ensureETARules();
      expect(created).toBe(true);

      const content = await fs.readFile(recorder.getETARulesPath(), 'utf-8');
      expect(content).toContain('# ETA Estimation Rules');
      expect(content).toContain('Task Type Baselines');
      expect(content).toContain('Adjustment Factors');
    });

    it('should not overwrite existing eta-rules.md', async () => {
      await recorder.ensureETARules();
      const created = await recorder.ensureETARules();
      expect(created).toBe(false);
    });
  });

  describe('readTaskRecords', () => {
    it('should return empty string when file does not exist', async () => {
      const content = await recorder.readTaskRecords();
      expect(content).toBe('');
    });

    it('should return file content when it exists', async () => {
      await recorder.ensureTaskRecords();
      const content = await recorder.readTaskRecords();
      expect(content).toContain('# Task Records');
    });
  });

  describe('readETARules', () => {
    it('should return empty string when file does not exist', async () => {
      const content = await recorder.readETARules();
      expect(content).toBe('');
    });

    it('should return file content when it exists', async () => {
      await recorder.ensureETARules();
      const content = await recorder.readETARules();
      expect(content).toContain('ETA Estimation Rules');
    });
  });

  describe('appendTaskRecord', () => {
    const sampleRecord: TaskRecord = {
      title: 'Fix login validation bug',
      type: 'bugfix',
      estimatedMinutes: 30,
      estimationBasis: 'Simple validation fix, similar to previous bugs',
      actualMinutes: 45,
      review: 'Underestimated - two validators needed coordination',
      files: ['src/auth/validator.ts'],
    };

    it('should append a task record to empty file', async () => {
      await recorder.ensureTaskRecords();
      await recorder.appendTaskRecord(sampleRecord);

      const content = await recorder.readTaskRecords();
      expect(content).toContain('Fix login validation bug');
      expect(content).toContain('**Type**: bugfix');
      expect(content).toContain('**Estimated Time**: 30 minutes');
      expect(content).toContain('**Actual Time**: 45 minutes');
      expect(content).toContain('**Files**: src/auth/validator.ts');
    });

    it('should use custom date when provided', async () => {
      await recorder.ensureTaskRecords();
      await recorder.appendTaskRecord({ ...sampleRecord, date: '2024-03-10' });

      const content = await recorder.readTaskRecords();
      expect(content).toContain('## 2024-03-10 Fix login validation bug');
    });

    it('should use today date when not provided', async () => {
      await recorder.ensureTaskRecords();
      await recorder.appendTaskRecord(sampleRecord);

      const content = await recorder.readTaskRecords();
      const [today] = new Date().toISOString().split('T');
      expect(content).toContain(`## ${today} Fix login validation bug`);
    });

    it('should prepend record (newest first)', async () => {
      await recorder.ensureTaskRecords();

      await recorder.appendTaskRecord({ ...sampleRecord, title: 'First task' });
      await recorder.appendTaskRecord({ ...sampleRecord, title: 'Second task' });

      const content = await recorder.readTaskRecords();
      const firstPos = content.indexOf('First task');
      const secondPos = content.indexOf('Second task');
      // Second task should appear before first (newest first)
      expect(secondPos).toBeLessThan(firstPos);
    });

    it('should handle record without files', async () => {
      await recorder.ensureTaskRecords();
      const recordWithoutFiles: TaskRecord = {
        title: 'Research task',
        type: 'research',
        estimatedMinutes: 60,
        estimationBasis: 'Need to investigate multiple approaches',
        actualMinutes: 50,
        review: 'Found answer quicker than expected',
      };
      await recorder.appendTaskRecord(recordWithoutFiles);

      const content = await recorder.readTaskRecords();
      expect(content).toContain('Research task');
      expect(content).not.toContain('**Files**:');
    });

    it('should include all required fields', async () => {
      await recorder.ensureTaskRecords();
      await recorder.appendTaskRecord(sampleRecord);

      const content = await recorder.readTaskRecords();
      expect(content).toContain('**Estimation Basis**:');
      expect(content).toContain('**Review**:');
      expect(content).toContain('---');
    });
  });

  describe('searchTaskRecords', () => {
    beforeEach(async () => {
      await recorder.ensureTaskRecords();
      await recorder.appendTaskRecord({
        title: 'Fix login bug',
        type: 'bugfix',
        estimatedMinutes: 30,
        estimationBasis: 'Simple fix',
        actualMinutes: 25,
        review: 'Quick fix',
      });
      await recorder.appendTaskRecord({
        title: 'Add export feature',
        type: 'feature-medium',
        estimatedMinutes: 120,
        estimationBasis: 'Multiple components needed',
        actualMinutes: 150,
        review: 'Took longer due to edge cases',
      });
    });

    it('should find records matching keyword', async () => {
      const results = await recorder.searchTaskRecords('login');
      expect(results.length).toBe(1);
      expect(results[0]).toContain('Fix login bug');
    });

    it('should be case-insensitive', async () => {
      const results = await recorder.searchTaskRecords('EXPORT');
      expect(results.length).toBe(1);
      expect(results[0]).toContain('Add export feature');
    });

    it('should return empty array when no matches', async () => {
      const results = await recorder.searchTaskRecords('nonexistent');
      expect(results).toEqual([]);
    });

    it('should return empty array when file does not exist', async () => {
      const newRecorder = new ETARecorder({ workspaceDir: path.join(tempDir, 'nonexistent') });
      const results = await newRecorder.searchTaskRecords('anything');
      expect(results).toEqual([]);
    });
  });

  describe('getRecentRecords', () => {
    beforeEach(async () => {
      await recorder.ensureTaskRecords();
      for (let i = 1; i <= 5; i++) {
        await recorder.appendTaskRecord({
          title: `Task ${i}`,
          type: 'bugfix',
          estimatedMinutes: 10 * i,
          estimationBasis: `Basis ${i}`,
          actualMinutes: 15 * i,
          review: `Review ${i}`,
        });
      }
    });

    it('should return most recent records by default', async () => {
      const records = await recorder.getRecentRecords();
      expect(records.length).toBe(5);
      // Most recent should be first (Task 5 is most recently appended)
      expect(records[0]).toContain('Task 5');
    });

    it('should respect count parameter', async () => {
      const records = await recorder.getRecentRecords(2);
      expect(records.length).toBe(2);
      expect(records[0]).toContain('Task 5');
      expect(records[1]).toContain('Task 4');
    });

    it('should return empty array when file does not exist', async () => {
      const newRecorder = new ETARecorder({ workspaceDir: path.join(tempDir, 'nonexistent') });
      const records = await newRecorder.getRecentRecords();
      expect(records).toEqual([]);
    });
  });

  describe('writeETARules', () => {
    it('should write custom ETA rules content', async () => {
      await recorder.ensureETARules();
      const customRules = '# Custom ETA Rules\n\nNew rules here.';
      await recorder.writeETARules(customRules);

      const content = await recorder.readETARules();
      expect(content).toBe(customRules);
    });

    it('should create file if it does not exist', async () => {
      const customRules = '# Custom Rules\n\nTest.';
      await recorder.writeETARules(customRules);

      const content = await recorder.readETARules();
      expect(content).toBe(customRules);
    });
  });

  describe('hasTaskRecords / hasETARules', () => {
    it('should return false before initialization', async () => {
      expect(await recorder.hasTaskRecords()).toBe(false);
      expect(await recorder.hasETARules()).toBe(false);
    });

    it('should return true after initialization', async () => {
      await recorder.ensureTaskRecords();
      await recorder.ensureETARules();
      expect(await recorder.hasTaskRecords()).toBe(true);
      expect(await recorder.hasETARules()).toBe(true);
    });
  });

  describe('Markdown format verification', () => {
    it('should produce valid Markdown with proper headers', async () => {
      await recorder.ensureTaskRecords();
      await recorder.appendTaskRecord({
        title: 'Test task',
        type: 'feature-small',
        estimatedMinutes: 30,
        estimationBasis: 'Test basis',
        actualMinutes: 25,
        review: 'Test review',
        date: '2024-03-10',
      });

      const content = await recorder.readTaskRecords();
      // Should have ## header for the record
      expect(content).toMatch(/## 2024-03-10 Test task/);
      // Should have all fields as list items
      expect(content).toMatch(/^- \*\*Type\*\*:/m);
      // Should end with separator
      expect(content).toContain('---');
    });

    it('should produce clean Markdown without JSON', async () => {
      await recorder.ensureTaskRecords();
      await recorder.appendTaskRecord({
        title: 'Verify format',
        type: 'bugfix',
        estimatedMinutes: 15,
        estimationBasis: 'Just checking',
        actualMinutes: 10,
        review: 'Looks good',
        date: '2024-03-10',
      });

      const content = await recorder.readTaskRecords();
      // Should not contain JSON-like structures
      expect(content).not.toMatch(/\{[^}]*"[a-z]"/);
      expect(content).not.toContain('"type":');
      expect(content).not.toContain('"estimatedMinutes":');
    });
  });
});
