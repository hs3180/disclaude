/**
 * Comprehensive tests for TaskTracker.
 *
 * Tests task record creation, dialogue task workflow,
 * and edge cases for the task tracking system.
 * @module task/task-tracker.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TaskTracker } from './task-tracker.js';

describe('TaskTracker', () => {
  let workspaceDir: string;
  let tracker: TaskTracker;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'task-tracker-test-'));
    tracker = new TaskTracker(workspaceDir);
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should create tracker with workspace dir', () => {
      expect(tracker).toBeDefined();
    });
  });

  describe('path generation', () => {
    it('should sanitize message IDs for file paths', () => {
      const path = tracker.getTaskFilePath('oc_abc@#%$');
      expect(path).not.toContain('@');
      expect(path).not.toContain('#');
      expect(path).not.toContain('%');
      expect(path).toMatch(/task\.md$/);
    });

    it('should preserve valid characters in message ID', () => {
      const path = tracker.getTaskFilePath('msg-123_abc');
      expect(path).toContain('msg-123_abc');
    });

    it('should return correct dialogue task path', () => {
      const path = tracker.getDialogueTaskPath('msg-1');
      expect(path).toMatch(/msg-1[\/\\]task\.md$/);
    });
  });

  describe('ensureTasksDir', () => {
    it('should create tasks directory', async () => {
      await tracker.ensureTasksDir();
      expect(existsSync(join(workspaceDir, 'tasks'))).toBe(true);
    });

    it('should be idempotent', async () => {
      await tracker.ensureTasksDir();
      await tracker.ensureTasksDir();
      expect(existsSync(join(workspaceDir, 'tasks'))).toBe(true);
    });
  });

  describe('saveTaskRecord (async)', () => {
    it('should save task record to disk', async () => {
      await tracker.saveTaskRecord(
        'msg-save-async',
        { chatId: 'oc_chat1', text: 'Fix the bug' },
        'Bot response content'
      );

      const filePath = tracker.getTaskFilePath('msg-save-async');
      expect(existsSync(filePath)).toBe(true);

      const content = await readFile(filePath, 'utf-8');
      expect(content).toContain('Fix the bug');
      expect(content).toContain('oc_chat1');
      expect(content).toContain('msg-save-async');
    });

    it('should sanitize message ID when saving', async () => {
      await tracker.saveTaskRecord(
        'oc_abc@123',
        { chatId: 'oc_chat1', text: 'Test' },
        'Response'
      );

      // The file should be in a sanitized directory
      const entries = await readdir(join(workspaceDir, 'tasks'));
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0]).not.toContain('@');
    });

    it('should use provided timestamp', async () => {
      const timestamp = '2026-01-01T00:00:00.000Z';
      await tracker.saveTaskRecord(
        'msg-ts',
        { chatId: 'oc_chat1', text: 'Test', timestamp },
        'Response'
      );

      const content = await readFile(tracker.getTaskFilePath('msg-ts'), 'utf-8');
      expect(content).toContain(timestamp);
    });

    it('should generate timestamp when not provided', async () => {
      await tracker.saveTaskRecord(
        'msg-auto-ts',
        { chatId: 'oc_chat1', text: 'Test' },
        'Response'
      );

      const content = await readFile(tracker.getTaskFilePath('msg-auto-ts'), 'utf-8');
      expect(content).toMatch(/\*\*Created\*\*: \d{4}-\d{2}-\d{2}T/);
    });

    it('should include senderType when provided', async () => {
      await tracker.saveTaskRecord(
        'msg-sender',
        { chatId: 'oc_chat1', text: 'Test', senderType: 'user', senderId: 'user_123' },
        'Response'
      );

      const content = await readFile(tracker.getTaskFilePath('msg-sender'), 'utf-8');
      expect(content).toContain('user');
      expect(content).toContain('user_123');
    });

    it('should handle multiline text', async () => {
      const multilineText = 'Line 1\nLine 2\nLine 3';
      await tracker.saveTaskRecord(
        'msg-multiline',
        { chatId: 'oc_chat1', text: multilineText },
        'Response'
      );

      const content = await readFile(tracker.getTaskFilePath('msg-multiline'), 'utf-8');
      expect(content).toContain('Line 1');
      expect(content).toContain('Line 2');
      expect(content).toContain('Line 3');
    });

    it('should truncate long text in title to 50 chars', async () => {
      const longText = 'A'.repeat(100);
      await tracker.saveTaskRecord(
        'msg-long',
        { chatId: 'oc_chat1', text: longText },
        'Response'
      );

      const content = await readFile(tracker.getTaskFilePath('msg-long'), 'utf-8');
      // Title should be truncated with ...
      expect(content).toContain(`${'A'.repeat(50)  }...`);
    });

    it('should not truncate short text in title', async () => {
      const shortText = 'Short text';
      await tracker.saveTaskRecord(
        'msg-short',
        { chatId: 'oc_chat1', text: shortText },
        'Response'
      );

      const content = await readFile(tracker.getTaskFilePath('msg-short'), 'utf-8');
      expect(content).toContain('Short text');
      expect(content).not.toContain('...');
    });
  });

  describe('saveTaskRecordSync (synchronous)', () => {
    it('should save task record synchronously', () => {
      tracker.saveTaskRecordSync(
        'msg-sync',
        { chatId: 'oc_chat1', text: 'Sync test' },
        'Response'
      );

      const filePath = tracker.getTaskFilePath('msg-sync');
      expect(existsSync(filePath)).toBe(true);

      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('Sync test');
    });

    it('should use provided timestamp', () => {
      const timestamp = '2026-03-25T00:00:00.000Z';
      tracker.saveTaskRecordSync(
        'msg-sync-ts',
        { chatId: 'oc_chat1', text: 'Test', timestamp },
        'Response'
      );

      const content = readFileSync(tracker.getTaskFilePath('msg-sync-ts'), 'utf-8');
      expect(content).toContain(timestamp);
    });

    it('should sanitize message ID', () => {
      tracker.saveTaskRecordSync(
        'msg@sync#special',
        { chatId: 'oc_chat1', text: 'Test' },
        'Response'
      );

      const filePath = tracker.getTaskFilePath('msg@sync#special');
      expect(existsSync(filePath)).toBe(true);
    });

    it('should include sender info', () => {
      tracker.saveTaskRecordSync(
        'msg-sync-sender',
        { chatId: 'oc_chat1', text: 'Test', senderType: 'group', senderId: 'grp_1' },
        'Response'
      );

      const content = readFileSync(tracker.getTaskFilePath('msg-sync-sender'), 'utf-8');
      expect(content).toContain('group');
      expect(content).toContain('grp_1');
    });
  });

  describe('createDialogueTask', () => {
    it('should create dialogue task file', async () => {
      const taskPath = await tracker.createDialogueTask('msg-dialogue', {
        chatId: 'oc_chat1',
        text: 'Implement feature X',
      });

      expect(existsSync(taskPath)).toBe(true);

      const content = await readFile(taskPath, 'utf-8');
      expect(content).toContain('Implement feature X');
      expect(content).toContain('msg-dialogue');
      expect(content).toContain('oc_chat1');
    });

    it('should include userId when provided', async () => {
      await tracker.createDialogueTask('msg-dialogue-user', {
        chatId: 'oc_chat1',
        userId: 'user_123',
        text: 'Task',
      });

      const content = await readFile(tracker.getDialogueTaskPath('msg-dialogue-user'), 'utf-8');
      expect(content).toContain('user_123');
    });

    it('should use N/A for userId when not provided', async () => {
      await tracker.createDialogueTask('msg-dialogue-nouser', {
        chatId: 'oc_chat1',
        text: 'Task',
      });

      const content = await readFile(tracker.getDialogueTaskPath('msg-dialogue-nouser'), 'utf-8');
      expect(content).toContain('N/A');
    });

    it('should use provided timestamp', async () => {
      const timestamp = '2026-06-15T12:00:00.000Z';
      await tracker.createDialogueTask('msg-dialogue-ts', {
        chatId: 'oc_chat1',
        text: 'Task',
        timestamp,
      });

      const content = await readFile(tracker.getDialogueTaskPath('msg-dialogue-ts'), 'utf-8');
      expect(content).toContain(timestamp);
    });

    it('should return the task file path', async () => {
      const taskPath = await tracker.createDialogueTask('msg-dialogue-path', {
        chatId: 'oc_chat1',
        text: 'Task',
      });

      expect(taskPath).toMatch(/msg-dialogue-path[\/\\]task\.md$/);
    });
  });

  describe('appendTaskDefinition', () => {
    it('should append task definition to existing task file', async () => {
      const taskPath = await tracker.createDialogueTask('msg-append', {
        chatId: 'oc_chat1',
        text: 'Original task',
      });

      const originalContent = await readFile(taskPath, 'utf-8');

      await tracker.appendTaskDefinition(taskPath, {
        primary_goal: 'Fix the authentication bug',
        success_criteria: ['Tests pass', 'No regressions'],
        expected_outcome: 'Authentication works correctly',
        deliverables: ['Bug fix', 'Unit tests'],
        format_requirements: ['TypeScript'],
        constraints: ['No breaking changes'],
        quality_criteria: ['All tests pass'],
      });

      const appendedContent = await readFile(taskPath, 'utf-8');
      expect(appendedContent.length).toBeGreaterThan(originalContent.length);
      expect(appendedContent).toContain('Fix the authentication bug');
      expect(appendedContent).toContain('Tests pass');
      expect(appendedContent).toContain('No regressions');
      expect(appendedContent).toContain('Task Objectives');
      expect(appendedContent).toContain('Quality Criteria');
      expect(appendedContent).toContain('Delivery Specifications');
    });

    it('should preserve original content', async () => {
      const taskPath = await tracker.createDialogueTask('msg-preserve', {
        chatId: 'oc_chat1',
        text: 'Original task content',
      });

      await tracker.appendTaskDefinition(taskPath, {
        primary_goal: 'Goal',
        success_criteria: ['SC1'],
        expected_outcome: 'Outcome',
        deliverables: ['D1'],
        format_requirements: [],
        constraints: [],
        quality_criteria: ['QC1'],
      });

      const content = await readFile(taskPath, 'utf-8');
      expect(content).toContain('Original task content');
    });

    it('should handle empty arrays in definition details', async () => {
      const taskPath = await tracker.createDialogueTask('msg-empty', {
        chatId: 'oc_chat1',
        text: 'Task',
      });

      await tracker.appendTaskDefinition(taskPath, {
        primary_goal: 'Goal',
        success_criteria: [],
        expected_outcome: 'Outcome',
        deliverables: [],
        format_requirements: [],
        constraints: [],
        quality_criteria: [],
      });

      const content = await readFile(taskPath, 'utf-8');
      expect(content).toContain('Goal');
      expect(content).toContain('Outcome');
    });

    it('should throw when task file does not exist', async () => {
      await expect(
        tracker.appendTaskDefinition('/nonexistent/path/task.md', {
          primary_goal: 'Goal',
          success_criteria: [],
          expected_outcome: 'Outcome',
          deliverables: [],
          format_requirements: [],
          constraints: [],
          quality_criteria: [],
        })
      ).rejects.toThrow();
    });
  });

  describe('end-to-end workflow', () => {
    it('should support full dialogue task workflow', async () => {
      const messageId = 'msg-e2e-workflow';

      // Create dialogue task
      const taskPath = await tracker.createDialogueTask(messageId, {
        chatId: 'oc_chat1',
        userId: 'user_123',
        text: 'Implement user authentication',
      });

      // Verify initial content
      const initial = await readFile(taskPath, 'utf-8');
      expect(initial).toContain('Implement user authentication');
      expect(initial).toContain('user_123');

      // Append task definition
      await tracker.appendTaskDefinition(taskPath, {
        primary_goal: 'Add JWT-based authentication',
        success_criteria: ['Login works', 'Token refresh works'],
        expected_outcome: 'Users can authenticate',
        deliverables: ['Auth module', 'Tests'],
        format_requirements: ['TypeScript'],
        constraints: ['Backward compatible'],
        quality_criteria: ['100% test coverage on auth module'],
      });

      // Verify final content
      const final = await readFile(taskPath, 'utf-8');
      expect(final).toContain('Add JWT-based authentication');
      expect(final).toContain('Login works');
      expect(final).toContain('Auth module');
      expect(final).toContain('Task definition generated by Pilot');
    });
  });
});
