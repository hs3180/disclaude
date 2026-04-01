/**
 * Tests for TaskTracker - dialogue task workflow management.
 *
 * Issue #1617 Phase 2/3: Tests for TaskTracker covering
 * path resolution, task record saving (async and sync), and dialogue task creation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as syncFs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TaskTracker } from './task-tracker.js';

// Suppress console.log/error in tests
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

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
      expect(tracker).toBeDefined();
    });
  });

  describe('getTaskFilePath', () => {
    it('should return path with sanitized message ID', () => {
      const result = tracker.getTaskFilePath('msg@123.abc');
      expect(result).toContain('msg_123_abc');
      expect(result).toContain('task.md');
    });

    it('should handle simple message IDs', () => {
      const result = tracker.getTaskFilePath('simple-id');
      expect(result).toContain('simple-id');
      expect(result).toContain('task.md');
    });
  });

  describe('getDialogueTaskPath', () => {
    it('should return path matching getTaskFilePath', () => {
      const id = 'test-message-id';
      expect(tracker.getDialogueTaskPath(id)).toBe(tracker.getTaskFilePath(id));
    });

    it('should sanitize message ID in path', () => {
      const result = tracker.getDialogueTaskPath('msg@special.chars');
      expect(result).toContain('msg_special_chars');
    });
  });

  describe('ensureTasksDir', () => {
    it('should create tasks directory', async () => {
      await tracker.ensureTasksDir();
      const tasksDir = path.join(tmpDir, 'tasks');
      const stat = await fs.stat(tasksDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should be idempotent', async () => {
      await tracker.ensureTasksDir();
      await tracker.ensureTasksDir();
      const tasksDir = path.join(tmpDir, 'tasks');
      const stat = await fs.stat(tasksDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('saveTaskRecord', () => {
    it('should save task record as markdown file', async () => {
      await tracker.saveTaskRecord(
        'msg-001',
        {
          chatId: 'oc_test',
          senderId: 'user_1',
          senderType: 'user',
          text: 'Hello world',
        },
        'Response content'
      );

      const filePath = tracker.getTaskFilePath('msg-001');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('# Task: Hello world');
      expect(content).toContain('**Task ID**: msg-001');
      expect(content).toContain('**Chat ID**: oc_test');
      expect(content).toContain('**User ID**: user_1');
      expect(content).toContain('**Sender Type**: user');
      expect(content).toContain('Hello world');
    });

    it('should truncate long text in title', async () => {
      const longText = 'A'.repeat(100);
      await tracker.saveTaskRecord('msg-002', {
        chatId: 'oc_test',
        text: longText,
      }, 'response');

      const filePath = tracker.getTaskFilePath('msg-002');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('# Task: ' + 'A'.repeat(50) + '...');
    });

    it('should use provided timestamp', async () => {
      await tracker.saveTaskRecord(
        'msg-003',
        {
          chatId: 'oc_test',
          text: 'test',
          timestamp: '2025-06-15T12:00:00Z',
        },
        'response'
      );

      const content = await fs.readFile(tracker.getTaskFilePath('msg-003'), 'utf-8');
      expect(content).toContain('**Created**: 2025-06-15T12:00:00Z');
    });

    it('should handle multiline text in original request', async () => {
      await tracker.saveTaskRecord(
        'msg-004',
        {
          chatId: 'oc_test',
          text: 'Line 1\nLine 2\nLine 3',
        },
        'response'
      );

      const content = await fs.readFile(tracker.getTaskFilePath('msg-004'), 'utf-8');
      expect(content).toContain('Line 1\nLine 2\nLine 3');
    });

    it('should sanitize message ID for directory name', async () => {
      await tracker.saveTaskRecord(
        'msg@123.abc/def',
        { chatId: 'oc_test', text: 'test' },
        'response'
      );

      const filePath = tracker.getTaskFilePath('msg@123.abc/def');
      expect(filePath).toContain('msg_123_abc_def');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('**Task ID**: msg@123.abc/def');
    });
  });

  describe('saveTaskRecordSync', () => {
    it('should save task record synchronously', () => {
      tracker.saveTaskRecordSync(
        'msg-sync-001',
        {
          chatId: 'oc_test',
          senderId: 'user_1',
          text: 'Sync test',
        },
        'Sync response'
      );

      const filePath = tracker.getTaskFilePath('msg-sync-001');
      const content = syncFs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('# Task: Sync test');
      expect(content).toContain('**Task ID**: msg-sync-001');
      expect(content).toContain('**Chat ID**: oc_test');
    });

    it('should use provided timestamp', () => {
      tracker.saveTaskRecordSync(
        'msg-sync-002',
        {
          chatId: 'oc_test',
          text: 'test',
          timestamp: '2025-06-15T12:00:00Z',
        },
        'response'
      );

      const content = syncFs.readFileSync(tracker.getTaskFilePath('msg-sync-002'), 'utf-8');
      expect(content).toContain('**Created**: 2025-06-15T12:00:00Z');
    });
  });

  describe('createDialogueTask', () => {
    it('should create initial Task.md file and return path', async () => {
      const taskPath = await tracker.createDialogueTask('msg-dialogue-001', {
        chatId: 'oc_test',
        userId: 'user_1',
        text: 'Build a feature',
      });

      expect(taskPath).toContain('task.md');
      const content = await fs.readFile(taskPath, 'utf-8');
      expect(content).toContain('# Task: Build a feature');
      expect(content).toContain('**Task ID**: msg-dialogue-001');
      expect(content).toContain('**Chat ID**: oc_test');
      expect(content).toContain('**User ID**: user_1');
      expect(content).toContain('## Original Request');
      expect(content).toContain('Build a feature');
    });

    it('should handle text without userId', async () => {
      const taskPath = await tracker.createDialogueTask('msg-dialogue-002', {
        chatId: 'oc_test',
        text: 'Simple task',
      });

      const content = await fs.readFile(taskPath, 'utf-8');
      expect(content).toContain('**User ID**: N/A');
    });

    it('should truncate long text in title', async () => {
      const longText = 'X'.repeat(100);
      const taskPath = await tracker.createDialogueTask('msg-dialogue-003', {
        chatId: 'oc_test',
        text: longText,
      });

      const content = await fs.readFile(taskPath, 'utf-8');
      expect(content).toContain('# Task: ' + 'X'.repeat(50) + '...');
    });
  });

  describe('appendTaskDefinition', () => {
    it('should append task definition details to existing Task.md', async () => {
      const taskPath = await tracker.createDialogueTask('msg-def-001', {
        chatId: 'oc_test',
        text: 'Build feature',
      });

      await tracker.appendTaskDefinition(taskPath, {
        primary_goal: 'Implement user authentication',
        success_criteria: ['Users can log in', 'Sessions are managed'],
        expected_outcome: 'Working auth system',
        deliverables: ['Login page', 'Session manager'],
        format_requirements: ['TypeScript', 'Tests included'],
        constraints: ['No external auth services'],
        quality_criteria: ['Code review passed', 'Tests pass'],
      });

      const content = await fs.readFile(taskPath, 'utf-8');
      expect(content).toContain('## Task Objectives');
      expect(content).toContain('### Primary Goal');
      expect(content).toContain('Implement user authentication');
      expect(content).toContain('### Success Criteria');
      expect(content).toContain('- Users can log in');
      expect(content).toContain('- Sessions are managed');
      expect(content).toContain('### Expected Outcome');
      expect(content).toContain('Working auth system');
      expect(content).toContain('### Required Deliverables');
      expect(content).toContain('- Login page');
      expect(content).toContain('### Format Requirements');
      expect(content).toContain('- TypeScript');
      expect(content).toContain('### Constraints');
      expect(content).toContain('- No external auth services');
      expect(content).toContain('## Quality Criteria');
      expect(content).toContain('- Code review passed');
      expect(content).toContain('*Task definition generated by Pilot*');
    });

    it('should omit optional sections when empty', async () => {
      const taskPath = await tracker.createDialogueTask('msg-def-002', {
        chatId: 'oc_test',
        text: 'Simple task',
      });

      await tracker.appendTaskDefinition(taskPath, {
        primary_goal: 'Do something',
        success_criteria: ['Done'],
        expected_outcome: 'Result',
        deliverables: ['Output'],
        format_requirements: [],
        constraints: [],
        quality_criteria: ['Good'],
      });

      const content = await fs.readFile(taskPath, 'utf-8');
      expect(content).not.toContain('### Format Requirements');
      expect(content).not.toContain('### Constraints');
    });

    it('should throw when task file does not exist', async () => {
      await expect(
        tracker.appendTaskDefinition('/nonexistent/path/task.md', {
          primary_goal: 'goal',
          success_criteria: [],
          expected_outcome: 'outcome',
          deliverables: [],
          format_requirements: [],
          constraints: [],
          quality_criteria: [],
        })
      ).rejects.toThrow();
    });
  });
});
