/**
 * Tests for TaskRecordManager.
 *
 * Issue #1234 Phase 1: Task record format and retrieval.
 *
 * Verifies append, read, search, and filter operations on task records.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TaskRecordManager } from './task-record-manager.js';
import type { TaskRecord } from './types.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-records-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

const sampleRecord: TaskRecord = {
  date: '2026-05-07',
  title: 'Fix WebSocket Reconnection Bug',
  type: 'bugfix',
  estimatedTime: '30 minutes',
  estimationBasis: 'Similar to the previous connection timeout fix',
  actualTime: '45 minutes',
  review: 'Underestimated the edge case where multiple reconnects fire simultaneously',
};

const sampleRecord2: TaskRecord = {
  date: '2026-05-07',
  title: 'Add Markdown Export Feature',
  type: 'feature',
  estimatedTime: '1 hour',
  estimationBasis: 'Data query + format conversion + file download, similar to the report feature',
  actualTime: '55 minutes',
  review: 'Estimation was accurate. Existing format helpers made conversion straightforward.',
};

const sampleRecord3: TaskRecord = {
  date: '2026-05-08',
  title: 'Refactor Authentication Module',
  type: 'refactoring',
  estimatedTime: '2 hours',
  estimationBasis: 'Need to restructure auth flow and update all callers',
  actualTime: '1 hour 45 minutes',
  review: 'The existing test coverage made refactoring safer than expected.',
};

describe('TaskRecordManager', () => {
  let manager: TaskRecordManager;

  beforeEach(() => {
    manager = new TaskRecordManager(tempDir);
  });

  describe('constructor', () => {
    it('should set records path to .claude/task-records.md', () => {
      const recordsPath = manager.getRecordsPath();
      expect(recordsPath).toContain('.claude');
      expect(recordsPath).toContain('task-records.md');
    });
  });

  describe('recordsExist', () => {
    it('should return false when file does not exist', async () => {
      expect(await manager.recordsExist()).toBe(false);
    });

    it('should return true after appending a record', async () => {
      await manager.appendRecord(sampleRecord);
      expect(await manager.recordsExist()).toBe(true);
    });
  });

  describe('appendRecord', () => {
    it('should create file with header when appending to non-existent file', async () => {
      await manager.appendRecord(sampleRecord);

      const content = await fs.readFile(manager.getRecordsPath(), 'utf-8');
      expect(content).toContain('# Task Records');
      expect(content).toContain('## 2026-05-07 Fix WebSocket Reconnection Bug');
      expect(content).toContain('**Type**: bugfix');
      expect(content).toContain('**Estimated Time**: 30 minutes');
      expect(content).toContain('**Actual Time**: 45 minutes');
    });

    it('should append record without duplicating header', async () => {
      await manager.appendRecord(sampleRecord);
      await manager.appendRecord(sampleRecord2);

      const content = await fs.readFile(manager.getRecordsPath(), 'utf-8');
      const headerCount = (content.match(/# Task Records/g) || []).length;
      expect(headerCount).toBe(1);
    });

    it('should append multiple records in order', async () => {
      await manager.appendRecord(sampleRecord);
      await manager.appendRecord(sampleRecord2);

      const content = await fs.readFile(manager.getRecordsPath(), 'utf-8');
      const firstRecordIndex = content.indexOf('Fix WebSocket');
      const secondRecordIndex = content.indexOf('Add Markdown Export');
      expect(firstRecordIndex).toBeLessThan(secondRecordIndex);
    });

    it('should create .claude directory if it does not exist', async () => {
      await manager.appendRecord(sampleRecord);

      const claudeDir = path.join(tempDir, '.claude');
      const stat = await fs.stat(claudeDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should handle all task types', async () => {
      const types: TaskRecord['type'][] = ['bugfix', 'feature', 'refactoring', 'research', 'test', 'docs', 'chore'];

      for (const type of types) {
        const record: TaskRecord = {
          date: '2026-05-08',
          title: `Test ${type} task`,
          type,
          estimatedTime: '10 minutes',
          estimationBasis: 'Test basis',
          actualTime: '10 minutes',
          review: 'Test review',
        };
        await manager.appendRecord(record);
      }

      const content = await fs.readFile(manager.getRecordsPath(), 'utf-8');
      for (const type of types) {
        expect(content).toContain(`**Type**: ${type}`);
      }
    });
  });

  describe('readRecords', () => {
    it('should return empty array when file does not exist', async () => {
      const records = await manager.readRecords();
      expect(records).toEqual([]);
    });

    it('should read a single record', async () => {
      await manager.appendRecord(sampleRecord);

      const records = await manager.readRecords();
      expect(records).toHaveLength(1);
      expect(records[0].title).toBe('Fix WebSocket Reconnection Bug');
      expect(records[0].type).toBe('bugfix');
      expect(records[0].date).toBe('2026-05-07');
      expect(records[0].estimatedTime).toBe('30 minutes');
      expect(records[0].actualTime).toBe('45 minutes');
    });

    it('should read multiple records in reverse order (newest first)', async () => {
      await manager.appendRecord(sampleRecord);    // 2026-05-07
      await manager.appendRecord(sampleRecord3);   // 2026-05-08

      const records = await manager.readRecords();
      expect(records).toHaveLength(2);
      // Newest first (reverse of append order)
      expect(records[0].title).toBe('Refactor Authentication Module');
      expect(records[1].title).toBe('Fix WebSocket Reconnection Bug');
    });

    it('should preserve all fields', async () => {
      await manager.appendRecord(sampleRecord2);

      const records = await manager.readRecords();
      expect(records).toHaveLength(1);

      const [r] = records;
      expect(r.date).toBe('2026-05-07');
      expect(r.title).toBe('Add Markdown Export Feature');
      expect(r.type).toBe('feature');
      expect(r.estimatedTime).toBe('1 hour');
      expect(r.estimationBasis).toBe('Data query + format conversion + file download, similar to the report feature');
      expect(r.actualTime).toBe('55 minutes');
      expect(r.review).toBe('Estimation was accurate. Existing format helpers made conversion straightforward.');
    });

    it('should handle file with extra whitespace gracefully', async () => {
      await manager.appendRecord(sampleRecord);

      // Manually add extra whitespace to the file
      const filePath = manager.getRecordsPath();
      let content = await fs.readFile(filePath, 'utf-8');
      content = `${content  }\n\n\n`;
      await fs.writeFile(filePath, content, 'utf-8');

      const records = await manager.readRecords();
      expect(records).toHaveLength(1);
    });
  });

  describe('getRecordsByType', () => {
    it('should filter records by type', async () => {
      await manager.appendRecord(sampleRecord);    // bugfix
      await manager.appendRecord(sampleRecord2);   // feature
      await manager.appendRecord(sampleRecord3);   // refactoring

      const bugfixes = await manager.getRecordsByType('bugfix');
      expect(bugfixes).toHaveLength(1);
      expect(bugfixes[0].type).toBe('bugfix');
    });

    it('should return empty array for type with no matches', async () => {
      await manager.appendRecord(sampleRecord); // bugfix

      const docs = await manager.getRecordsByType('docs');
      expect(docs).toEqual([]);
    });

    it('should return multiple records of same type', async () => {
      await manager.appendRecord(sampleRecord); // bugfix

      const anotherBugfix: TaskRecord = {
        date: '2026-05-08',
        title: 'Fix Login Redirect Loop',
        type: 'bugfix',
        estimatedTime: '15 minutes',
        estimationBasis: 'Simple redirect logic fix',
        actualTime: '20 minutes',
        review: 'Minor edge case missed in estimate',
      };
      await manager.appendRecord(anotherBugfix);

      const bugfixes = await manager.getRecordsByType('bugfix');
      expect(bugfixes).toHaveLength(2);
    });
  });

  describe('searchRecords', () => {
    it('should find records by title keyword', async () => {
      await manager.appendRecord(sampleRecord);
      await manager.appendRecord(sampleRecord2);

      const results = await manager.searchRecords('WebSocket');
      expect(results).toHaveLength(1);
      expect(results[0].title).toContain('WebSocket');
    });

    it('should find records by review keyword', async () => {
      await manager.appendRecord(sampleRecord);
      await manager.appendRecord(sampleRecord2);

      const results = await manager.searchRecords('accurate');
      expect(results).toHaveLength(1);
      expect(results[0].title).toContain('Markdown Export');
    });

    it('should perform case-insensitive search', async () => {
      await manager.appendRecord(sampleRecord);

      const results = await manager.searchRecords('websocket');
      expect(results).toHaveLength(1);
    });

    it('should find records by estimation basis', async () => {
      await manager.appendRecord(sampleRecord);
      await manager.appendRecord(sampleRecord2);

      const results = await manager.searchRecords('report feature');
      expect(results).toHaveLength(1);
      expect(results[0].title).toContain('Markdown Export');
    });

    it('should return empty for no matches', async () => {
      await manager.appendRecord(sampleRecord);

      const results = await manager.searchRecords('quantum computing');
      expect(results).toEqual([]);
    });

    it('should return all matching records', async () => {
      await manager.appendRecord(sampleRecord);   // "Fix" in title
      await manager.appendRecord(sampleRecord2);  // "Add" in title
      await manager.appendRecord(sampleRecord3);  // "Refactor" in title

      // Search for something that appears in multiple records
      const results = await manager.searchRecords('estimated');
      // "Underestimated" in sampleRecord review
      expect(results.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('getRecentRecords', () => {
    it('should return limited number of records', async () => {
      await manager.appendRecord(sampleRecord);
      await manager.appendRecord(sampleRecord2);
      await manager.appendRecord(sampleRecord3);

      const recent = await manager.getRecentRecords(2);
      expect(recent).toHaveLength(2);
    });

    it('should return all records if count exceeds total', async () => {
      await manager.appendRecord(sampleRecord);

      const recent = await manager.getRecentRecords(10);
      expect(recent).toHaveLength(1);
    });

    it('should return newest records first', async () => {
      await manager.appendRecord(sampleRecord);    // 2026-05-07
      await manager.appendRecord(sampleRecord2);   // 2026-05-07
      await manager.appendRecord(sampleRecord3);   // 2026-05-08

      const recent = await manager.getRecentRecords(1);
      expect(recent[0].title).toBe('Refactor Authentication Module');
    });

    it('should default to 10 records', async () => {
      const recent = await manager.getRecentRecords();
      expect(recent).toEqual([]);
    });
  });

  describe('formatRecord', () => {
    it('should format record as Markdown', () => {
      const formatted = manager.formatRecord(sampleRecord);

      expect(formatted).toContain('## 2026-05-07 Fix WebSocket Reconnection Bug');
      expect(formatted).toContain('**Type**: bugfix');
      expect(formatted).toContain('**Estimated Time**: 30 minutes');
      expect(formatted).toContain('**Estimation Basis**: Similar to the previous connection timeout fix');
      expect(formatted).toContain('**Actual Time**: 45 minutes');
      expect(formatted).toContain('**Review**: Underestimated the edge case');
    });
  });

  describe('parseRecords', () => {
    it('should parse well-formed Markdown', () => {
      const content = `# Task Records

## 2026-05-07 Fix WebSocket Reconnection Bug

- **Type**: bugfix
- **Estimated Time**: 30 minutes
- **Estimation Basis**: Similar to previous fix
- **Actual Time**: 45 minutes
- **Review**: Underestimated edge cases

## 2026-05-07 Add Markdown Export Feature

- **Type**: feature
- **Estimated Time**: 1 hour
- **Estimation Basis**: Data query + format conversion
- **Actual Time**: 55 minutes
- **Review**: Accurate estimate
`;

      const records = manager.parseRecords(content);
      expect(records).toHaveLength(2);
      // Newest first
      expect(records[0].title).toBe('Add Markdown Export Feature');
      expect(records[1].title).toBe('Fix WebSocket Reconnection Bug');
    });

    it('should skip malformed sections', () => {
      const content = `# Task Records

## Not a valid date entry

Some content

## 2026-05-07 Valid Task

- **Type**: feature
- **Estimated Time**: 1 hour
- **Estimation Basis**: Research
- **Actual Time**: 1 hour
- **Review**: Good
`;

      const records = manager.parseRecords(content);
      expect(records).toHaveLength(1);
      expect(records[0].title).toBe('Valid Task');
    });

    it('should skip entries with invalid type', () => {
      const content = `# Task Records

## 2026-05-07 Task with Invalid Type

- **Type**: invalid_type
- **Estimated Time**: 30 minutes
- **Estimation Basis**: Test
- **Actual Time**: 30 minutes
- **Review**: Test
`;

      const records = manager.parseRecords(content);
      expect(records).toHaveLength(0);
    });

    it('should return empty array for empty content', () => {
      const records = manager.parseRecords('');
      expect(records).toEqual([]);
    });

    it('should return empty array for header-only content', () => {
      const records = manager.parseRecords('# Task Records\n');
      expect(records).toEqual([]);
    });
  });

  describe('round-trip: write then read', () => {
    it('should preserve data through write-read cycle', async () => {
      const records: TaskRecord[] = [
        sampleRecord,
        sampleRecord2,
        sampleRecord3,
      ];

      for (const record of records) {
        await manager.appendRecord(record);
      }

      const readBack = await manager.readRecords();
      expect(readBack).toHaveLength(3);

      // Verify each record (newest first)
      expect(readBack[0].title).toBe('Refactor Authentication Module');
      expect(readBack[1].title).toBe('Add Markdown Export Feature');
      expect(readBack[2].title).toBe('Fix WebSocket Reconnection Bug');

      // Verify all fields preserved
      for (const original of records) {
        const found = readBack.find(r => r.title === original.title);
        expect(found).toBeDefined();
        expect(found!.date).toBe(original.date);
        expect(found!.type).toBe(original.type);
        expect(found!.estimatedTime).toBe(original.estimatedTime);
        expect(found!.estimationBasis).toBe(original.estimationBasis);
        expect(found!.actualTime).toBe(original.actualTime);
        expect(found!.review).toBe(original.review);
      }
    });

    it('should support search after multiple appends', async () => {
      await manager.appendRecord(sampleRecord);
      await manager.appendRecord(sampleRecord2);
      await manager.appendRecord(sampleRecord3);

      // Search for "Fix" which appears in bugfix title
      const fixResults = await manager.searchRecords('Fix');
      expect(fixResults.length).toBeGreaterThanOrEqual(1);
      expect(fixResults.some(r => r.title.includes('Fix'))).toBe(true);

      // Filter by type
      const features = await manager.getRecordsByType('feature');
      expect(features).toHaveLength(1);
      expect(features[0].title).toBe('Add Markdown Export Feature');

      // Get recent
      const recent = await manager.getRecentRecords(2);
      expect(recent).toHaveLength(2);
    });
  });
});
