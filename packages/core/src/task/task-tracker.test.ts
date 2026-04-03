/**
 * Tests for TaskTracker - dialogue task workflow management.
 *
 * @module task/task-tracker.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as syncFs from 'fs';
import * as path from 'path';
import os from 'os';
import { TaskTracker } from './task-tracker.js';
import type { TaskDefinitionDetails } from './types.js';

describe('TaskTracker', () => {
  let tmpDir: string;
  let tracker: TaskTracker;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-tracker-test-'));
    tracker = new TaskTracker(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should create tracker with workspace directory', () => {
      const t = new TaskTracker('/workspace');
      expect(t.getTaskFilePath('msg-1')).toContain('/workspace/tasks/');
    });
  });

  describe('getTaskFilePath', () => {
    it('should return correct task file path', () => {
      const filePath = tracker.getTaskFilePath('msg-123');
      expect(filePath).toBe(path.join(tmpDir, 'tasks', 'msg-123', 'task.md'));
    });

    it('should sanitize message ID', () => {
      const filePath = tracker.getTaskFilePath('msg/123@chat#id');
      expect(filePath).toBe(path.join(tmpDir, 'tasks', 'msg_123_chat_id', 'task.md'));
    });
  });

  describe('getDialogueTaskPath', () => {
    it('should return correct dialogue task path', () => {
      const taskPath = tracker.getDialogueTaskPath('msg-123');
      expect(taskPath).toBe(path.join(tmpDir, 'tasks', 'msg-123', 'task.md'));
    });

    it('should sanitize message ID', () => {
      const taskPath = tracker.getDialogueTaskPath('msg/abc@123');
      expect(taskPath).toBe(path.join(tmpDir, 'tasks', 'msg_abc_123', 'task.md'));
    });
  });

  describe('ensureTasksDir', () => {
    it('should create tasks directory', async () => {
      await tracker.ensureTasksDir();
      const tasksDir = path.join(tmpDir, 'tasks');
      await expect(fs.access(tasksDir)).resolves.toBeUndefined();
    });

    it('should handle existing directory', async () => {
      await tracker.ensureTasksDir();
      await tracker.ensureTasksDir(); // Second call should not throw
    });
  });

  describe('saveTaskRecord', () => {
    it('should save task record to disk', async () => {
      await tracker.saveTaskRecord('msg-123', {
        chatId: 'chat-1',
        senderType: 'user',
        senderId: 'user-1',
        text: 'Fix the bug',
        timestamp: '2026-01-01T00:00:00Z',
      }, 'Done');

      const filePath = tracker.getTaskFilePath('msg-123');
      const content = await fs.readFile(filePath, 'utf-8');

      expect(content).toContain('# Task: Fix the bug');
      expect(content).toContain('**Task ID**: msg-123');
      expect(content).toContain('**Chat ID**: chat-1');
      expect(content).toContain('**User ID**: user-1');
      expect(content).toContain('**Sender Type**: user');
      expect(content).toContain('Fix the bug');
    });

    it('should generate timestamp when not provided', async () => {
      await tracker.saveTaskRecord('msg-456', {
        chatId: 'chat-2',
        text: 'Hello world',
      }, 'Response');

      const filePath = tracker.getTaskFilePath('msg-456');
      const content = await fs.readFile(filePath, 'utf-8');

      expect(content).toContain('**Created**:');
      expect(content).toContain('Hello world');
    });

    it('should truncate long text for title', async () => {
      const longText = 'A'.repeat(100);
      await tracker.saveTaskRecord('msg-789', {
        chatId: 'chat-3',
        text: longText,
      }, 'Response');

      const filePath = tracker.getTaskFilePath('msg-789');
      const content = await fs.readFile(filePath, 'utf-8');

      // Title should be truncated to 50 chars with '...'
      expect(content).toContain('...');
    });

    it('should handle multiline text', async () => {
      await tracker.saveTaskRecord('msg-multi', {
        chatId: 'chat-4',
        text: 'Line 1\nLine 2\nLine 3',
      }, 'Response');

      const filePath = tracker.getTaskFilePath('msg-multi');
      const content = await fs.readFile(filePath, 'utf-8');

      // Title should be from first line only
      expect(content).toContain('# Task: Line 1');
      // Full text in code block
      expect(content).toContain('Line 2');
      expect(content).toContain('Line 3');
    });

    it('should handle missing optional fields', async () => {
      await tracker.saveTaskRecord('msg-minimal', {
        chatId: 'chat-5',
        text: 'Minimal task',
      }, 'Done');

      const filePath = tracker.getTaskFilePath('msg-minimal');
      const content = await fs.readFile(filePath, 'utf-8');

      expect(content).toContain('**User ID**: N/A');
      expect(content).not.toContain('**Sender Type**');
    });
  });

  describe('saveTaskRecordSync', () => {
    it('should save task record synchronously', () => {
      tracker.saveTaskRecordSync('msg-sync-1', {
        chatId: 'chat-sync',
        senderType: 'user',
        senderId: 'user-sync',
        text: 'Sync task',
        timestamp: '2026-01-01T00:00:00Z',
      }, 'Done');

      const filePath = tracker.getTaskFilePath('msg-sync-1');
      const content = syncFs.readFileSync(filePath, 'utf-8');

      expect(content).toContain('# Task: Sync task');
      expect(content).toContain('**Task ID**: msg-sync-1');
      expect(content).toContain('**Chat ID**: chat-sync');
    });

    it('should generate timestamp when not provided (sync)', () => {
      tracker.saveTaskRecordSync('msg-sync-2', {
        chatId: 'chat-sync',
        text: 'No timestamp',
      }, 'Response');

      const filePath = tracker.getTaskFilePath('msg-sync-2');
      const content = syncFs.readFileSync(filePath, 'utf-8');

      expect(content).toContain('**Created**:');
    });
  });

  describe('createDialogueTask', () => {
    it('should create dialogue task file and return path', async () => {
      const taskPath = await tracker.createDialogueTask('msg-dialogue-1', {
        chatId: 'chat-d',
        userId: 'user-d',
        text: 'Create a feature',
        timestamp: '2026-01-01T00:00:00Z',
      });

      expect(taskPath).toContain('tasks/msg-dialogue-1/task.md');

      const content = await fs.readFile(taskPath, 'utf-8');
      expect(content).toContain('# Task: Create a feature');
      expect(content).toContain('**Task ID**: msg-dialogue-1');
      expect(content).toContain('**Chat ID**: chat-d');
      expect(content).toContain('**User ID**: user-d');
      expect(content).toContain('Create a feature');
    });

    it('should handle missing userId', async () => {
      const taskPath = await tracker.createDialogueTask('msg-dialogue-2', {
        chatId: 'chat-d',
        text: 'Task without user',
      });

      const content = await fs.readFile(taskPath, 'utf-8');
      expect(content).toContain('**User ID**: N/A');
    });

    it('should generate timestamp when not provided', async () => {
      const taskPath = await tracker.createDialogueTask('msg-dialogue-3', {
        chatId: 'chat-d',
        text: 'Auto timestamp',
      });

      const content = await fs.readFile(taskPath, 'utf-8');
      expect(content).toContain('**Created**:');
    });
  });

  describe('appendTaskDefinition', () => {
    it('should append task definition to existing task file', async () => {
      // Create initial task
      const taskPath = await tracker.createDialogueTask('msg-def-1', {
        chatId: 'chat-def',
        text: 'Define this task',
      });

      const details: TaskDefinitionDetails = {
        primary_goal: 'Fix the authentication bug',
        success_criteria: ['Users can log in', 'Session persists'],
        expected_outcome: 'Working login flow',
        deliverables: ['Fixed code', 'Test coverage'],
        format_requirements: ['TypeScript', 'With tests'],
        constraints: ['No breaking changes'],
        quality_criteria: ['All tests pass', 'No regressions'],
      };

      await tracker.appendTaskDefinition(taskPath, details);

      const content = await fs.readFile(taskPath, 'utf-8');

      expect(content).toContain('## Task Objectives');
      expect(content).toContain('### Primary Goal');
      expect(content).toContain('Fix the authentication bug');
      expect(content).toContain('### Success Criteria');
      expect(content).toContain('- Users can log in');
      expect(content).toContain('- Session persists');
      expect(content).toContain('### Expected Outcome');
      expect(content).toContain('Working login flow');
      expect(content).toContain('## Delivery Specifications');
      expect(content).toContain('### Required Deliverables');
      expect(content).toContain('- Fixed code');
      expect(content).toContain('### Format Requirements');
      expect(content).toContain('- TypeScript');
      expect(content).toContain('### Constraints');
      expect(content).toContain('- No breaking changes');
      expect(content).toContain('## Quality Criteria');
      expect(content).toContain('- All tests pass');
      expect(content).toContain('Task definition generated by Pilot');
    });

    it('should handle empty optional arrays', async () => {
      const taskPath = await tracker.createDialogueTask('msg-def-2', {
        chatId: 'chat-def',
        text: 'Minimal definition',
      });

      const details: TaskDefinitionDetails = {
        primary_goal: 'Simple goal',
        success_criteria: ['Criterion 1'],
        expected_outcome: 'Expected result',
        deliverables: ['Deliverable 1'],
        format_requirements: [],
        constraints: [],
        quality_criteria: ['Quality 1'],
      };

      await tracker.appendTaskDefinition(taskPath, details);

      const content = await fs.readFile(taskPath, 'utf-8');

      expect(content).toContain('Simple goal');
      // Should not have empty sections for format requirements or constraints
      expect(content).not.toContain('### Format Requirements\n\n###');
    });
  });
});
