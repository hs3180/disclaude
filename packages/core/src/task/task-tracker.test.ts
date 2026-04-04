/**
 * Tests for TaskTracker.
 *
 * Verifies task record persistence and dialogue task management.
 *
 * Issue #1617: Phase 2 - task module test coverage.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TaskTracker } from './task-tracker.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-tracker-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('TaskTracker', () => {
  let tracker: TaskTracker;

  beforeEach(() => {
    tracker = new TaskTracker(tempDir);
  });

  describe('constructor', () => {
    it('should create tracker with workspace directory', () => {
      expect(tracker).toBeInstanceOf(TaskTracker);
    });
  });

  describe('path methods', () => {
    it('should return task file path', () => {
      const result = tracker.getTaskFilePath('msg-123');
      expect(result).toContain('tasks');
      expect(result).toContain('msg-123');
      expect(result).toContain('task.md');
    });

    it('should sanitize message ID in path', () => {
      const result = tracker.getTaskFilePath('msg/123@abc');
      const dirName = path.basename(path.dirname(result));
      expect(dirName).not.toContain('/');
      expect(dirName).not.toContain('@');
    });

    it('should return dialogue task path', () => {
      const result = tracker.getDialogueTaskPath('msg-456');
      expect(result).toContain('tasks');
      expect(result).toContain('msg-456');
      expect(result).toContain('task.md');
    });
  });

  describe('ensureTasksDir', () => {
    it('should create tasks directory', async () => {
      await tracker.ensureTasksDir();

      const tasksDir = path.join(tempDir, 'tasks');
      const stat = await fs.stat(tasksDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should handle existing directory', async () => {
      await tracker.ensureTasksDir();
      await tracker.ensureTasksDir(); // should not throw
    });
  });

  describe('saveTaskRecord', () => {
    it('should save task record to disk', async () => {
      const metadata = {
        chatId: 'oc_test',
        senderType: 'user',
        senderId: 'user-123',
        text: 'Hello world',
        timestamp: '2026-01-01T00:00:00Z',
      };

      await tracker.saveTaskRecord('msg-1', metadata, 'Response content');

      const filePath = tracker.getTaskFilePath('msg-1');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('msg-1');
      expect(content).toContain('oc_test');
      expect(content).toContain('Hello world');
      expect(content).toContain('2026-01-01T00:00:00Z');
    });

    it('should use current timestamp when not provided', async () => {
      const before = new Date().toISOString();
      await tracker.saveTaskRecord('msg-2', {
        chatId: 'oc_test',
        text: 'Test',
      }, 'Response');
      const content = await fs.readFile(tracker.getTaskFilePath('msg-2'), 'utf-8');
      expect(content).toContain('Created');
      // Timestamp should contain current year
      expect(content).toContain(before.substring(0, 4));
    });

    it('should create task directory structure', async () => {
      await tracker.saveTaskRecord('msg-3', {
        chatId: 'oc_test',
        text: 'Test',
      }, 'Response');

      const taskDir = path.join(tempDir, 'tasks', 'msg-3');
      const stat = await fs.stat(taskDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should handle long text by truncating title', async () => {
      const longText = 'A'.repeat(100);
      await tracker.saveTaskRecord('msg-4', {
        chatId: 'oc_test',
        text: longText,
      }, 'Response');

      const content = await fs.readFile(tracker.getTaskFilePath('msg-4'), 'utf-8');
      expect(content).toContain('...');
      expect(content).toContain('Task:');
    });

    it('should include optional fields when provided', async () => {
      await tracker.saveTaskRecord('msg-5', {
        chatId: 'oc_test',
        senderType: 'bot',
        senderId: 'bot-123',
        text: 'Test',
      }, 'Response');

      const content = await fs.readFile(tracker.getTaskFilePath('msg-5'), 'utf-8');
      expect(content).toContain('Sender Type');
      expect(content).toContain('bot');
      expect(content).toContain('bot-123');
    });

    it('should not include senderType when not provided', async () => {
      await tracker.saveTaskRecord('msg-6', {
        chatId: 'oc_test',
        text: 'Test',
      }, 'Response');

      const content = await fs.readFile(tracker.getTaskFilePath('msg-6'), 'utf-8');
      expect(content).not.toContain('Sender Type');
    });
  });

  describe('saveTaskRecordSync', () => {
    it('should save task record synchronously', async () => {
      tracker.saveTaskRecordSync('msg-sync-1', {
        chatId: 'oc_test',
        text: 'Sync test',
        timestamp: '2026-01-01T00:00:00Z',
      }, 'Sync response');

      const content = await fs.readFile(tracker.getTaskFilePath('msg-sync-1'), 'utf-8');
      expect(content).toContain('Sync test');
      expect(content).toContain('2026-01-01T00:00:00Z');
    });
  });

  describe('createDialogueTask', () => {
    it('should create dialogue task file and return path', async () => {
      const taskPath = await tracker.createDialogueTask('msg-d-1', {
        chatId: 'oc_test',
        userId: 'user-123',
        text: 'Create a report',
        timestamp: '2026-01-01T00:00:00Z',
      });

      expect(taskPath).toContain('msg-d-1');
      expect(taskPath).toContain('task.md');

      const content = await fs.readFile(taskPath, 'utf-8');
      expect(content).toContain('msg-d-1');
      expect(content).toContain('oc_test');
      expect(content).toContain('user-123');
      expect(content).toContain('Create a report');
      expect(content).toContain('2026-01-01T00:00:00Z');
      expect(content).toContain('Original Request');
    });

    it('should truncate long text in title', async () => {
      const longText = 'X'.repeat(200);
      const taskPath = await tracker.createDialogueTask('msg-d-2', {
        chatId: 'oc_test',
        text: longText,
      });

      const content = await fs.readFile(taskPath, 'utf-8');
      expect(content).toContain('...');
    });

    it('should use N/A when userId is not provided', async () => {
      const taskPath = await tracker.createDialogueTask('msg-d-3', {
        chatId: 'oc_test',
        text: 'Test',
      });

      const content = await fs.readFile(taskPath, 'utf-8');
      expect(content).toContain('User ID');
      expect(content).toContain('N/A');
    });
  });

  describe('appendTaskDefinition', () => {
    it('should append task definition to existing task file', async () => {
      const taskPath = await tracker.createDialogueTask('msg-d-4', {
        chatId: 'oc_test',
        text: 'Build a REST API',
      });

      await tracker.appendTaskDefinition(taskPath, {
        primary_goal: 'Create a fully functional REST API',
        success_criteria: ['API returns correct status codes', 'Documentation included'],
        expected_outcome: 'A working REST API with tests',
        deliverables: ['API code', 'Tests', 'Documentation'],
        format_requirements: ['TypeScript', 'Express.js'],
        constraints: ['No external database'],
        quality_criteria: ['Code coverage > 80%', 'Passes linting'],
      });

      const content = await fs.readFile(taskPath, 'utf-8');
      expect(content).toContain('Task Objectives');
      expect(content).toContain('Primary Goal');
      expect(content).toContain('Create a fully functional REST API');
      expect(content).toContain('Success Criteria');
      expect(content).toContain('API returns correct status codes');
      expect(content).toContain('Expected Outcome');
      expect(content).toContain('Required Deliverables');
      expect(content).toContain('API code');
      expect(content).toContain('Format Requirements');
      expect(content).toContain('TypeScript');
      expect(content).toContain('Constraints');
      expect(content).toContain('No external database');
      expect(content).toContain('Quality Criteria');
      expect(content).toContain('Code coverage > 80%');
    });

    it('should handle minimal task definition', async () => {
      const taskPath = await tracker.createDialogueTask('msg-d-5', {
        chatId: 'oc_test',
        text: 'Simple task',
      });

      await tracker.appendTaskDefinition(taskPath, {
        primary_goal: 'Do something',
        success_criteria: ['Done'],
        expected_outcome: 'It is done',
        deliverables: ['Output'],
        format_requirements: [],
        constraints: [],
        quality_criteria: ['Good quality'],
      });

      const content = await fs.readFile(taskPath, 'utf-8');
      expect(content).toContain('Primary Goal');
      expect(content).not.toContain('Format Requirements');
      expect(content).not.toContain('Constraints');
    });
  });
});
