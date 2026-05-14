/**
 * Tests for TaskRecordManager.
 *
 * Verifies Markdown-based task record appending and parsing.
 *
 * Issue #1234: Phase 1 — Task record format.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TaskRecordManager, type TaskRecordInput } from './task-record.js';

let tempDir: string;
let manager: TaskRecordManager;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-record-test-'));
  manager = new TaskRecordManager(tempDir);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

const sampleRecord: TaskRecordInput = {
  title: 'Fix WebSocket Reconnection Bug',
  type: 'bugfix',
  estimatedMinutes: 30,
  estimationBasis: 'Similar to previous connection timeout fix',
  actualMinutes: 45,
  review: 'Underestimated edge case with simultaneous reconnects',
};

describe('TaskRecordManager', () => {
  describe('getFilePath', () => {
    it('should return path under .claude/task-records.md', () => {
      const fp = manager.getFilePath();
      expect(fp).toBe(path.join(tempDir, '.claude', 'task-records.md'));
    });
  });

  describe('append', () => {
    it('should create file with header on first append', async () => {
      await manager.append(sampleRecord);

      const content = await fs.readFile(manager.getFilePath(), 'utf-8');
      expect(content).toContain('# Task Records');
      expect(content).toContain('Fix WebSocket Reconnection Bug');
      expect(content).toContain('**Type**: bugfix');
      expect(content).toContain('**Estimated Time**: 30 minutes');
      expect(content).toContain('**Actual Time**: 45 minutes');
    });

    it('should not duplicate header on subsequent appends', async () => {
      await manager.append(sampleRecord);
      await manager.append({
        ...sampleRecord,
        title: 'Add Markdown Export Feature',
        type: 'feature',
      });

      const content = await fs.readFile(manager.getFilePath(), 'utf-8');
      const headerCount = (content.match(/^# Task Records/gm) || []).length;
      expect(headerCount).toBe(1);
      expect(content).toContain('Fix WebSocket Reconnection Bug');
      expect(content).toContain('Add Markdown Export Feature');
    });

    it('should include date in heading', async () => {
      await manager.append(sampleRecord);

      const content = await fs.readFile(manager.getFilePath(), 'utf-8');
      const [today] = new Date().toISOString().split('T');
      expect(content).toContain(`## ${today} Fix WebSocket Reconnection Bug`);
    });

    it('should create .claude directory if it does not exist', async () => {
      await manager.append(sampleRecord);

      const stat = await fs.stat(path.join(tempDir, '.claude'));
      expect(stat.isDirectory()).toBe(true);
    });

    it('should include all fields in the record', async () => {
      await manager.append(sampleRecord);

      const content = await fs.readFile(manager.getFilePath(), 'utf-8');
      expect(content).toContain('**Estimation Basis**: Similar to previous connection timeout fix');
      expect(content).toContain('**Review**: Underestimated edge case with simultaneous reconnects');
    });
  });

  describe('readAll', () => {
    it('should return empty array when file does not exist', async () => {
      const result = await manager.readAll();
      expect(result.records).toEqual([]);
      expect(result.raw).toBe('');
    });

    it('should parse a single record', async () => {
      await manager.append(sampleRecord);

      const result = await manager.readAll();
      expect(result.records).toHaveLength(1);

      const [record] = result.records;
      expect(record.input.title).toBe('Fix WebSocket Reconnection Bug');
      expect(record.input.type).toBe('bugfix');
      expect(record.input.estimatedMinutes).toBe(30);
      expect(record.input.actualMinutes).toBe(45);
      expect(record.input.estimationBasis).toBe('Similar to previous connection timeout fix');
      expect(record.input.review).toBe('Underestimated edge case with simultaneous reconnects');
      expect(record.index).toBe(1);
    });

    it('should parse multiple records', async () => {
      await manager.append(sampleRecord);
      await manager.append({
        title: 'Add Export Feature',
        type: 'feature',
        estimatedMinutes: 60,
        estimationBasis: 'Need query + format + download',
        actualMinutes: 55,
        review: 'Accurate estimate',
      });

      const result = await manager.readAll();
      expect(result.records).toHaveLength(2);
      expect(result.records[0].input.title).toBe('Fix WebSocket Reconnection Bug');
      expect(result.records[1].input.title).toBe('Add Export Feature');
      expect(result.records[1].index).toBe(2);
    });

    it('should return raw file content', async () => {
      await manager.append(sampleRecord);

      const result = await manager.readAll();
      expect(result.raw).toContain('# Task Records');
      expect(result.raw).toContain('Fix WebSocket Reconnection Bug');
    });
  });

  describe('round-trip', () => {
    it('should preserve data through append → readAll cycle', async () => {
      const records: TaskRecordInput[] = [
        {
          title: 'Bug Fix A',
          type: 'bugfix',
          estimatedMinutes: 15,
          estimationBasis: 'Simple config change',
          actualMinutes: 20,
          review: 'Had to check downstream effects',
        },
        {
          title: 'Feature B',
          type: 'feature',
          estimatedMinutes: 120,
          estimationBasis: 'New API integration',
          actualMinutes: 90,
          review: 'Existing helpers saved time',
        },
        {
          title: 'Refactor C',
          type: 'refactoring',
          estimatedMinutes: 45,
          estimationBasis: 'Similar to previous module refactor',
          actualMinutes: 45,
          review: 'Spot on',
        },
      ];

      for (const r of records) {
        await manager.append(r);
      }

      const result = await manager.readAll();
      expect(result.records).toHaveLength(3);

      for (let i = 0; i < records.length; i++) {
        const parsed = result.records[i].input;
        expect(parsed.title).toBe(records[i].title);
        expect(parsed.type).toBe(records[i].type);
        expect(parsed.estimatedMinutes).toBe(records[i].estimatedMinutes);
        expect(parsed.actualMinutes).toBe(records[i].actualMinutes);
      }
    });
  });
});
