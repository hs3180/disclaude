/**
 * Tests for ETA Task Records (Markdown-based).
 *
 * Issue #1234: Task ETA Estimation System
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ETATaskRecords, type ETATaskRecord } from './eta-records.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('ETATaskRecords', () => {
  let records: ETATaskRecords;
  let testDir: string;

  beforeEach(async () => {
    // Create unique test directory for each test
    testDir = join(tmpdir(), `eta-records-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Create records with test directory
    records = new ETATaskRecords(testDir);
    await records.initialize();
  });

  afterEach(async () => {
    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('initialize', () => {
    it('should create records file with header', async () => {
      const content = await records.readRecords();
      expect(content).toContain('# 任务记录');
    });

    it('should preserve existing records on re-initialization', async () => {
      await records.recordTask({
        date: '2024-03-10',
        title: 'Test Task',
        taskType: 'testing',
        estimatedTime: '30分钟',
        estimatedSeconds: 1800,
        estimationBasis: 'Similar to previous tasks',
        actualTime: '25分钟',
        actualSeconds: 1500,
        review: 'Went smoothly',
        success: true,
      });

      // Re-initialize
      const newRecords = new ETATaskRecords(testDir);
      await newRecords.initialize();

      const content = await newRecords.readRecords();
      expect(content).toContain('Test Task');
    });
  });

  describe('recordTask', () => {
    it('should record a task with all fields', async () => {
      const record: ETATaskRecord = {
        date: '2024-03-10',
        title: 'Add user export feature',
        taskType: 'feature',
        estimatedTime: '1小时',
        estimatedSeconds: 3600,
        estimationBasis: '需要数据查询 + 格式转换 + 文件下载',
        actualTime: '55分钟',
        actualSeconds: 3300,
        review: '估计较准确',
        success: true,
      };

      await records.recordTask(record);

      const content = await records.readRecords();
      expect(content).toContain('Add user export feature');
      expect(content).toContain('feature');
      expect(content).toContain('1小时');
      expect(content).toContain('55分钟');
      expect(content).toContain('✅');
    });

    it('should record failed tasks', async () => {
      await records.recordTask({
        date: '2024-03-10',
        title: 'Failed task',
        taskType: 'bugfix',
        estimatedTime: '30分钟',
        estimatedSeconds: 1800,
        estimationBasis: 'Simple fix',
        actualTime: '2小时',
        actualSeconds: 7200,
        review: 'Underestimated complexity',
        success: false,
      });

      const content = await records.readRecords();
      expect(content).toContain('❌');
    });

    it('should include accuracy indicator', async () => {
      // Accurate estimate
      await records.recordTask({
        date: '2024-03-10',
        title: 'Accurate task',
        taskType: 'feature',
        estimatedTime: '30分钟',
        estimatedSeconds: 1800,
        estimationBasis: 'Test',
        actualTime: '32分钟',
        actualSeconds: 1920,
        review: 'Good',
        success: true,
      });

      const content = await records.readRecords();
      expect(content).toContain('🎯'); // Accuracy emoji
    });
  });

  describe('findSimilarTasks', () => {
    beforeEach(async () => {
      // Add some test records
      await records.recordTask({
        date: '2024-03-08',
        title: 'Refactor login module',
        taskType: 'refactoring',
        estimatedTime: '30分钟',
        estimatedSeconds: 1800,
        estimationBasis: 'Similar to form refactor',
        actualTime: '45分钟',
        actualSeconds: 2700,
        review: 'Password validation was complex',
        success: true,
      });

      await records.recordTask({
        date: '2024-03-09',
        title: 'Add user export feature',
        taskType: 'feature',
        estimatedTime: '1小时',
        estimatedSeconds: 3600,
        estimationBasis: 'Data query + format + download',
        actualTime: '55分钟',
        actualSeconds: 3300,
        review: 'Accurate estimate',
        success: true,
      });

      await records.recordTask({
        date: '2024-03-10',
        title: 'Refactor authentication module',
        taskType: 'refactoring',
        estimatedTime: '45分钟',
        estimatedSeconds: 2700,
        estimationBasis: 'Similar to login refactor',
        actualTime: '40分钟',
        actualSeconds: 2400,
        review: 'Went well',
        success: true,
      });
    });

    it('should find tasks by keyword', async () => {
      const similar = await records.findSimilarTasks(['refactor']);
      expect(similar.length).toBe(2);
    });

    it('should rank by keyword match count', async () => {
      const similar = await records.findSimilarTasks(['refactor', 'module']);
      expect(similar.length).toBe(2);
      // Both have "refactor" and "module"
    });

    it('should respect limit parameter', async () => {
      const similar = await records.findSimilarTasks(['refactor'], 1);
      expect(similar.length).toBe(1);
    });

    it('should return empty array for no matches', async () => {
      const similar = await records.findSimilarTasks(['nonexistent']);
      expect(similar.length).toBe(0);
    });
  });

  describe('getRecentTasks', () => {
    it('should return recent tasks', async () => {
      await records.recordTask({
        date: '2024-03-10',
        title: 'Task 1',
        taskType: 'feature',
        estimatedTime: '30分钟',
        estimatedSeconds: 1800,
        estimationBasis: 'Test',
        actualTime: '30分钟',
        actualSeconds: 1800,
        review: 'Good',
        success: true,
      });

      await records.recordTask({
        date: '2024-03-10',
        title: 'Task 2',
        taskType: 'feature',
        estimatedTime: '30分钟',
        estimatedSeconds: 1800,
        estimationBasis: 'Test',
        actualTime: '30分钟',
        actualSeconds: 1800,
        review: 'Good',
        success: true,
      });

      const recent = await records.getRecentTasks(10);
      expect(recent.length).toBe(2);
    });

    it('should respect limit', async () => {
      for (let i = 0; i < 5; i++) {
        await records.recordTask({
          date: '2024-03-10',
          title: `Task ${i}`,
          taskType: 'feature',
          estimatedTime: '30分钟',
          estimatedSeconds: 1800,
          estimationBasis: 'Test',
          actualTime: '30分钟',
          actualSeconds: 1800,
          review: 'Good',
          success: true,
        });
      }

      const recent = await records.getRecentTasks(3);
      expect(recent.length).toBe(3);
    });
  });

  describe('getTasksByType', () => {
    beforeEach(async () => {
      await records.recordTask({
        date: '2024-03-10',
        title: 'Feature Task',
        taskType: 'feature',
        estimatedTime: '30分钟',
        estimatedSeconds: 1800,
        estimationBasis: 'Test',
        actualTime: '30分钟',
        actualSeconds: 1800,
        review: 'Good',
        success: true,
      });

      await records.recordTask({
        date: '2024-03-10',
        title: 'Bugfix Task',
        taskType: 'bugfix',
        estimatedTime: '15分钟',
        estimatedSeconds: 900,
        estimationBasis: 'Test',
        actualTime: '20分钟',
        actualSeconds: 1200,
        review: 'OK',
        success: true,
      });
    });

    it('should filter by task type', async () => {
      const features = await records.getTasksByType('feature');
      expect(features.length).toBe(1);
      expect(features[0].taskType).toBe('feature');

      const bugfixes = await records.getTasksByType('bugfix');
      expect(bugfixes.length).toBe(1);
      expect(bugfixes[0].taskType).toBe('bugfix');
    });

    it('should be case-insensitive', async () => {
      const features = await records.getTasksByType('FEATURE');
      expect(features.length).toBe(1);
    });
  });
});
