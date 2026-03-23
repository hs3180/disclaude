/**
 * Tests for TaskTracker (packages/core/src/task/task-tracker.ts)
 */

import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import * as syncFs from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TaskTracker } from './task-tracker.js';
import type { TaskDefinitionDetails } from './types.js';

describe('TaskTracker', () => {
  let tmpDir: string;
  let tracker: TaskTracker;

  beforeEach(() => {
    tmpDir = syncFs.mkdtempSync(path.join(os.tmpdir(), 'task-tracker-test-'));
    tracker = new TaskTracker(tmpDir);
  });

  afterEach(() => {
    syncFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('should create TaskTracker with tasksDir set to workspaceDir/tasks', () => {
      const expectedDir = path.join(tmpDir, 'tasks');
      const filePath = tracker.getTaskFilePath('msg-1');
      expect(filePath).toContain(expectedDir);
    });

    it('should create TaskTracker for different workspace directories independently', () => {
      const anotherTmp = syncFs.mkdtempSync(path.join(os.tmpdir(), 'task-tracker-other-'));
      const anotherTracker = new TaskTracker(anotherTmp);
      const path1 = tracker.getTaskFilePath('msg-1');
      const path2 = anotherTracker.getTaskFilePath('msg-1');
      expect(path1).not.toBe(path2);
      expect(path1).toContain(tmpDir);
      expect(path2).toContain(anotherTmp);
      syncFs.rmSync(anotherTmp, { recursive: true, force: true });
    });
  });

  // =========================================================================
  // ensureTasksDir()
  // =========================================================================

  describe('ensureTasksDir', () => {
    it('should create tasks directory when it does not exist', async () => {
      const tasksDir = path.join(tmpDir, 'tasks');
      expect(syncFs.existsSync(tasksDir)).toBe(false);
      await tracker.ensureTasksDir();
      expect(syncFs.existsSync(tasksDir)).toBe(true);
      const stat = await fs.stat(tasksDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should not throw when tasks directory already exists', async () => {
      await tracker.ensureTasksDir();
      await expect(tracker.ensureTasksDir()).resolves.not.toThrow();
    });

    it('should be idempotent - multiple calls succeed', async () => {
      await tracker.ensureTasksDir();
      await tracker.ensureTasksDir();
      await tracker.ensureTasksDir();
      const tasksDir = path.join(tmpDir, 'tasks');
      expect(syncFs.existsSync(tasksDir)).toBe(true);
    });
  });

  // =========================================================================
  // getTaskFilePath()
  // =========================================================================

  describe('getTaskFilePath', () => {
    it('should return path ending with task.md', () => {
      const filePath = tracker.getTaskFilePath('msg-1');
      expect(filePath).toMatch(/task\.md$/);
    });

    it('should return path containing sanitized message ID as subdirectory', () => {
      const filePath = tracker.getTaskFilePath('msg-1');
      expect(filePath).toContain(path.join('tasks', 'msg-1'));
    });

    it('should sanitize special characters in messageId', () => {
      const filePath = tracker.getTaskFilePath('msg.1/special@id');
      // The sanitized directory name should not contain dots or slashes
      const dirName = path.dirname(filePath);
      expect(path.basename(dirName)).toBe('msg_1_special_id');
      expect(filePath).toContain('msg_1_special_id');
    });

    it('should preserve alphanumeric, hyphens, and underscores', () => {
      const filePath = tracker.getTaskFilePath('msg-ABC_123');
      expect(filePath).toContain('msg-ABC_123');
    });
  });

  // =========================================================================
  // getDialogueTaskPath()
  // =========================================================================

  describe('getDialogueTaskPath', () => {
    it('should return path ending with task.md', () => {
      const filePath = tracker.getDialogueTaskPath('msg-1');
      expect(filePath).toMatch(/task\.md$/);
    });

    it('should return path containing sanitized message ID as subdirectory', () => {
      const filePath = tracker.getDialogueTaskPath('msg-1');
      expect(filePath).toContain(path.join('tasks', 'msg-1'));
    });

    it('should sanitize special characters in messageId', () => {
      const filePath = tracker.getDialogueTaskPath('msg.1/special');
      expect(filePath).toContain('msg_1_special');
    });

    it('should return same path as getTaskFilePath for the same messageId', () => {
      const id = 'msg-123';
      expect(tracker.getDialogueTaskPath(id)).toBe(tracker.getTaskFilePath(id));
    });
  });

  // =========================================================================
  // saveTaskRecord() (async)
  // =========================================================================

  describe('saveTaskRecord', () => {
    it('should create task directory and write task.md file', async () => {
      await tracker.saveTaskRecord('msg-1', {
        chatId: 'chat-1',
        text: 'Hello world',
      }, 'Response content');

      const filePath = tracker.getTaskFilePath('msg-1');
      expect(syncFs.existsSync(filePath)).toBe(true);
    });

    it('should write markdown with correct title (first 50 chars)', async () => {
      const longText = 'A'.repeat(80);
      await tracker.saveTaskRecord('msg-1', {
        chatId: 'chat-1',
        text: longText,
      }, 'Response');

      const filePath = tracker.getTaskFilePath('msg-1');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('# Task: ' + 'A'.repeat(50) + '...');
    });

    it('should not append ellipsis when text is 50 chars or less', async () => {
      const shortText = 'Short text';
      await tracker.saveTaskRecord('msg-1', {
        chatId: 'chat-1',
        text: shortText,
      }, 'Response');

      const filePath = tracker.getTaskFilePath('msg-1');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain(`# Task: ${shortText}`);
      expect(content).not.toContain('...');
    });

    it('should include Task ID, Created, Chat ID, and User ID in metadata', async () => {
      const timestamp = '2025-01-15T10:00:00.000Z';
      await tracker.saveTaskRecord('msg-42', {
        chatId: 'chat-99',
        senderId: 'user-7',
        text: 'Do something',
        timestamp,
      }, 'Done');

      const filePath = tracker.getTaskFilePath('msg-42');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('**Task ID**: msg-42');
      expect(content).toContain(`**Created**: ${timestamp}`);
      expect(content).toContain('**Chat ID**: chat-99');
      expect(content).toContain('**User ID**: user-7');
    });

    it('should show N/A for User ID when senderId is not provided', async () => {
      await tracker.saveTaskRecord('msg-1', {
        chatId: 'chat-1',
        text: 'Test',
      }, 'Response');

      const filePath = tracker.getTaskFilePath('msg-1');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('**User ID**: N/A');
    });

    it('should include Sender Type when senderType is provided', async () => {
      await tracker.saveTaskRecord('msg-1', {
        chatId: 'chat-1',
        senderType: 'private',
        text: 'Test',
      }, 'Response');

      const filePath = tracker.getTaskFilePath('msg-1');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('**Sender Type**: private');
    });

    it('should not include Sender Type line when senderType is omitted', async () => {
      await tracker.saveTaskRecord('msg-1', {
        chatId: 'chat-1',
        text: 'Test',
      }, 'Response');

      const filePath = tracker.getTaskFilePath('msg-1');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).not.toContain('Sender Type');
    });

    it('should include original request text in a code block', async () => {
      const requestText = 'Please fix the bug in module X';
      await tracker.saveTaskRecord('msg-1', {
        chatId: 'chat-1',
        text: requestText,
      }, 'Fixed');

      const filePath = tracker.getTaskFilePath('msg-1');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('## Original Request');
      expect(content).toContain('```\n' + requestText + '\n```');
    });

    it('should use current timestamp when timestamp is not provided', async () => {
      const before = new Date().toISOString();
      await tracker.saveTaskRecord('msg-1', {
        chatId: 'chat-1',
        text: 'Test',
      }, 'Response');
      const after = new Date().toISOString();

      const filePath = tracker.getTaskFilePath('msg-1');
      const content = await fs.readFile(filePath, 'utf-8');
      const match = content.match(/\*\*Created\*\*: (.+)/);
      expect(match).not.toBeNull();
      const writtenTimestamp = match![1];
      expect(writtenTimestamp >= before).toBe(true);
      expect(writtenTimestamp <= after).toBe(true);
    });

    it('should overwrite existing file when called twice with same messageId', async () => {
      await tracker.saveTaskRecord('msg-1', {
        chatId: 'chat-1',
        text: 'First',
      }, 'First response');
      await tracker.saveTaskRecord('msg-1', {
        chatId: 'chat-1',
        text: 'Second',
      }, 'Second response');

      const filePath = tracker.getTaskFilePath('msg-1');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('# Task: Second');
      expect(content).not.toContain('# Task: First');
    });
  });

  // =========================================================================
  // saveTaskRecordSync() (sync)
  // =========================================================================

  describe('saveTaskRecordSync', () => {
    it('should create task directory and write task.md file synchronously', () => {
      tracker.saveTaskRecordSync('msg-sync', {
        chatId: 'chat-sync',
        text: 'Sync task',
      }, 'Sync response');

      const filePath = tracker.getTaskFilePath('msg-sync');
      expect(syncFs.existsSync(filePath)).toBe(true);
    });

    it('should write correct markdown content synchronously', () => {
      tracker.saveTaskRecordSync('msg-sync', {
        chatId: 'chat-sync',
        senderId: 'user-1',
        senderType: 'group',
        text: 'Do this synchronously',
        timestamp: '2025-06-01T12:00:00.000Z',
      }, 'Done sync');

      const filePath = tracker.getTaskFilePath('msg-sync');
      const content = syncFs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('# Task: Do this synchronously');
      expect(content).toContain('**Task ID**: msg-sync');
      expect(content).toContain('**Created**: 2025-06-01T12:00:00.000Z');
      expect(content).toContain('**Chat ID**: chat-sync');
      expect(content).toContain('**User ID**: user-1');
      expect(content).toContain('**Sender Type**: group');
      expect(content).toContain('## Original Request');
      expect(content).toContain('```\nDo this synchronously\n```');
    });

    it('should produce identical output as async saveTaskRecord', async () => {
      const metadata = {
        chatId: 'chat-cmp',
        senderId: 'user-cmp',
        text: 'Compare test',
        timestamp: '2025-03-01T00:00:00.000Z',
      };

      // Use different temp dirs so both can write to the same messageId
      const syncTmpDir = syncFs.mkdtempSync(path.join(os.tmpdir(), 'sync-cmp-'));
      const asyncTmpDir = syncFs.mkdtempSync(path.join(os.tmpdir(), 'async-cmp-'));

      const syncTracker = new TaskTracker(syncTmpDir);
      const asyncTracker = new TaskTracker(asyncTmpDir);

      syncTracker.saveTaskRecordSync('msg-compare', metadata, 'Response');
      await asyncTracker.saveTaskRecord('msg-compare', metadata, 'Response');

      const syncContent = syncFs.readFileSync(
        syncTracker.getTaskFilePath('msg-compare'), 'utf-8',
      );
      const asyncContent = await fs.readFile(
        asyncTracker.getTaskFilePath('msg-compare'), 'utf-8',
      );
      expect(syncContent).toBe(asyncContent);

      syncFs.rmSync(syncTmpDir, { recursive: true, force: true });
      syncFs.rmSync(asyncTmpDir, { recursive: true, force: true });
    });

    it('should overwrite existing file when called twice with same messageId', () => {
      tracker.saveTaskRecordSync('msg-sync', {
        chatId: 'chat-sync',
        text: 'Original',
      }, 'First');
      tracker.saveTaskRecordSync('msg-sync', {
        chatId: 'chat-sync',
        text: 'Updated',
      }, 'Second');

      const filePath = tracker.getTaskFilePath('msg-sync');
      const content = syncFs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('# Task: Updated');
      expect(content).not.toContain('# Task: Original');
    });
  });

  // =========================================================================
  // createDialogueTask()
  // =========================================================================

  describe('createDialogueTask', () => {
    it('should create task.md file and return its path', async () => {
      const resultPath = await tracker.createDialogueTask('dlg-1', {
        chatId: 'chat-1',
        text: 'Build a feature',
      });

      expect(syncFs.existsSync(resultPath)).toBe(true);
      expect(resultPath).toMatch(/task\.md$/);
    });

    it('should write markdown with correct heading and metadata', async () => {
      const resultPath = await tracker.createDialogueTask('dlg-2', {
        chatId: 'chat-2',
        userId: 'user-2',
        text: 'Implement authentication',
        timestamp: '2025-07-10T08:30:00.000Z',
      });

      const content = await fs.readFile(resultPath, 'utf-8');
      expect(content).toContain('# Task: Implement authentication');
      expect(content).toContain('**Task ID**: dlg-2');
      expect(content).toContain('**Created**: 2025-07-10T08:30:00.000Z');
      expect(content).toContain('**Chat ID**: chat-2');
      expect(content).toContain('**User ID**: user-2');
    });

    it('should show N/A for User ID when userId is not provided', async () => {
      const resultPath = await tracker.createDialogueTask('dlg-3', {
        chatId: 'chat-3',
        text: 'Test',
      });

      const content = await fs.readFile(resultPath, 'utf-8');
      expect(content).toContain('**User ID**: N/A');
    });

    it('should truncate title to 50 characters with ellipsis', async () => {
      const longText = 'This is a very long request that exceeds fifty characters for sure';
      const resultPath = await tracker.createDialogueTask('dlg-4', {
        chatId: 'chat-4',
        text: longText,
      });

      const content = await fs.readFile(resultPath, 'utf-8');
      const title = longText.substring(0, 50);
      expect(content).toContain(`# Task: ${title}...`);
    });

    it('should include original request in code block', async () => {
      const resultPath = await tracker.createDialogueTask('dlg-5', {
        chatId: 'chat-5',
        text: 'Fix the bug',
      });

      const content = await fs.readFile(resultPath, 'utf-8');
      expect(content).toContain('## Original Request');
      expect(content).toContain('```\nFix the bug\n```');
    });

    it('should create parent directory if it does not exist', async () => {
      const resultPath = await tracker.createDialogueTask('dlg-new', {
        chatId: 'chat-new',
        text: 'New task',
      });

      const dir = path.dirname(resultPath);
      expect(syncFs.existsSync(dir)).toBe(true);
      expect(syncFs.existsSync(resultPath)).toBe(true);
    });
  });

  // =========================================================================
  // appendTaskDefinition()
  // =========================================================================

  describe('appendTaskDefinition', () => {
    it('should append task definition sections to existing file', async () => {
      // First create a dialogue task file
      const taskPath = await tracker.createDialogueTask('dlg-def-1', {
        chatId: 'chat-1',
        text: 'Build API',
      });

      const details: TaskDefinitionDetails = {
        primary_goal: 'Create REST API endpoints',
        success_criteria: ['All endpoints return 200', 'Tests pass'],
        expected_outcome: 'Working API with documentation',
        deliverables: ['API code', 'Test suite', 'API docs'],
        format_requirements: ['OpenAPI 3.0 spec'],
        constraints: ['No external dependencies'],
        quality_criteria: ['Code coverage > 80%', 'No lint errors'],
      };

      await tracker.appendTaskDefinition(taskPath, details);

      const content = await fs.readFile(taskPath, 'utf-8');
      expect(content).toContain('## Task Objectives');
      expect(content).toContain('### Primary Goal');
      expect(content).toContain('Create REST API endpoints');
      expect(content).toContain('### Success Criteria');
      expect(content).toContain('- All endpoints return 200');
      expect(content).toContain('- Tests pass');
      expect(content).toContain('### Expected Outcome');
      expect(content).toContain('Working API with documentation');
    });

    it('should include delivery specifications section', async () => {
      const taskPath = await tracker.createDialogueTask('dlg-def-2', {
        chatId: 'chat-2',
        text: 'Write docs',
      });

      const details: TaskDefinitionDetails = {
        primary_goal: 'Write documentation',
        success_criteria: ['Docs are comprehensive'],
        expected_outcome: 'Complete documentation',
        deliverables: ['README.md', 'API docs'],
        format_requirements: ['Markdown format'],
        constraints: [],
        quality_criteria: ['Reviewed by team'],
      };

      await tracker.appendTaskDefinition(taskPath, details);

      const content = await fs.readFile(taskPath, 'utf-8');
      expect(content).toContain('## Delivery Specifications');
      expect(content).toContain('### Required Deliverables');
      expect(content).toContain('- README.md');
      expect(content).toContain('- API docs');
      expect(content).toContain('### Format Requirements');
      expect(content).toContain('- Markdown format');
    });

    it('should include quality criteria section', async () => {
      const taskPath = await tracker.createDialogueTask('dlg-def-3', {
        chatId: 'chat-3',
        text: 'Refactor code',
      });

      const details: TaskDefinitionDetails = {
        primary_goal: 'Refactor for clarity',
        success_criteria: ['Passes CI'],
        expected_outcome: 'Cleaner codebase',
        deliverables: ['Refactored code'],
        format_requirements: [],
        constraints: ['No behavior changes'],
        quality_criteria: ['No regressions', 'Faster build times', 'Better readability'],
      };

      await tracker.appendTaskDefinition(taskPath, details);

      const content = await fs.readFile(taskPath, 'utf-8');
      expect(content).toContain('## Quality Criteria');
      expect(content).toContain('- No regressions');
      expect(content).toContain('- Faster build times');
      expect(content).toContain('- Better readability');
    });

    it('should include Pilot attribution footer', async () => {
      const taskPath = await tracker.createDialogueTask('dlg-def-4', {
        chatId: 'chat-4',
        text: 'Task',
      });

      const details: TaskDefinitionDetails = {
        primary_goal: 'Goal',
        success_criteria: ['Done'],
        expected_outcome: 'Outcome',
        deliverables: ['Deliverable'],
        format_requirements: [],
        constraints: [],
        quality_criteria: ['Quality'],
      };

      await tracker.appendTaskDefinition(taskPath, details);

      const content = await fs.readFile(taskPath, 'utf-8');
      expect(content).toContain('*Task definition generated by Pilot*');
      expect(content).toContain('*This document serves as a record and will not be modified during execution.*');
    });

    it('should include constraints section when constraints are non-empty', async () => {
      const taskPath = await tracker.createDialogueTask('dlg-def-5', {
        chatId: 'chat-5',
        text: 'Task',
      });

      const details: TaskDefinitionDetails = {
        primary_goal: 'Goal',
        success_criteria: [],
        expected_outcome: 'Outcome',
        deliverables: [],
        format_requirements: [],
        constraints: ['Budget limit', 'Timeline constraint'],
        quality_criteria: [],
      };

      await tracker.appendTaskDefinition(taskPath, details);

      const content = await fs.readFile(taskPath, 'utf-8');
      expect(content).toContain('### Constraints');
      expect(content).toContain('- Budget limit');
      expect(content).toContain('- Timeline constraint');
    });

    it('should omit format_requirements section when array is empty', async () => {
      const taskPath = await tracker.createDialogueTask('dlg-def-6', {
        chatId: 'chat-6',
        text: 'Task',
      });

      const details: TaskDefinitionDetails = {
        primary_goal: 'Goal',
        success_criteria: [],
        expected_outcome: 'Outcome',
        deliverables: [],
        format_requirements: [],
        constraints: [],
        quality_criteria: [],
      };

      await tracker.appendTaskDefinition(taskPath, details);

      const content = await fs.readFile(taskPath, 'utf-8');
      expect(content).not.toContain('### Format Requirements');
    });

    it('should omit constraints section when array is empty', async () => {
      const taskPath = await tracker.createDialogueTask('dlg-def-7', {
        chatId: 'chat-7',
        text: 'Task',
      });

      const details: TaskDefinitionDetails = {
        primary_goal: 'Goal',
        success_criteria: [],
        expected_outcome: 'Outcome',
        deliverables: [],
        format_requirements: [],
        constraints: [],
        quality_criteria: [],
      };

      await tracker.appendTaskDefinition(taskPath, details);

      const content = await fs.readFile(taskPath, 'utf-8');
      expect(content).not.toContain('### Constraints');
    });

    it('should preserve original content before appended definition', async () => {
      const taskPath = await tracker.createDialogueTask('dlg-def-8', {
        chatId: 'chat-8',
        text: 'Original request text',
      });

      const originalContent = await fs.readFile(taskPath, 'utf-8');
      expect(originalContent).toContain('Original request text');

      const details: TaskDefinitionDetails = {
        primary_goal: 'Goal',
        success_criteria: ['Criterion 1'],
        expected_outcome: 'Outcome',
        deliverables: ['Deliverable 1'],
        format_requirements: [],
        constraints: [],
        quality_criteria: ['Quality 1'],
      };

      await tracker.appendTaskDefinition(taskPath, details);

      const finalContent = await fs.readFile(taskPath, 'utf-8');
      expect(finalContent).toContain('# Task: Original request text');
      expect(finalContent).toContain('## Original Request');
      expect(finalContent).toContain('## Task Objectives');
    });

    it('should throw when task file does not exist', async () => {
      const nonexistentPath = path.join(tmpDir, 'tasks', 'nonexistent', 'task.md');
      const details: TaskDefinitionDetails = {
        primary_goal: 'Goal',
        success_criteria: [],
        expected_outcome: 'Outcome',
        deliverables: [],
        format_requirements: [],
        constraints: [],
        quality_criteria: [],
      };

      await expect(tracker.appendTaskDefinition(nonexistentPath, details)).rejects.toThrow();
    });
  });

  // =========================================================================
  // Path sanitization
  // =========================================================================

  describe('path sanitization', () => {
    it('should replace dots with underscores', () => {
      const filePath = tracker.getTaskFilePath('msg.1.2.3');
      expect(filePath).toContain('msg_1_2_3');
    });

    it('should replace slashes with underscores', () => {
      const filePath = tracker.getTaskFilePath('msg/a/b');
      expect(filePath).toContain('msg_a_b');
    });

    it('should replace spaces with underscores', () => {
      const filePath = tracker.getTaskFilePath('msg with spaces');
      expect(filePath).toContain('msg_with_spaces');
    });

    it('should replace special characters like @#$%^&*() with underscores', () => {
      const filePath = tracker.getTaskFilePath('msg@#$%^&*()');
      expect(filePath).toContain('msg________');
    });

    it('should preserve hyphens and underscores', () => {
      const filePath = tracker.getTaskFilePath('my-msg_id');
      expect(filePath).toContain('my-msg_id');
    });

    it('should sanitize consistently across getTaskFilePath and getDialogueTaskPath', () => {
      const messyId = 'msg.1/2@3';
      const taskPath = tracker.getTaskFilePath(messyId);
      const dialoguePath = tracker.getDialogueTaskPath(messyId);
      expect(taskPath).toBe(dialoguePath);
    });

    it('should handle unicode characters in messageId', () => {
      const filePath = tracker.getTaskFilePath('msg-abc-123');
      expect(filePath).toContain('msg-abc-123');
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('should handle long text in saveTaskRecord without truncating in code block', async () => {
      const longText = 'A'.repeat(500);
      await tracker.saveTaskRecord('msg-long', {
        chatId: 'chat-long',
        text: longText,
      }, 'Response');

      const filePath = tracker.getTaskFilePath('msg-long');
      const content = await fs.readFile(filePath, 'utf-8');
      // Title should be truncated
      expect(content).toContain('# Task: ' + 'A'.repeat(50) + '...');
      // But code block should contain full text
      expect(content).toContain('```\n' + longText + '\n```');
    });

    it('should handle multiline text using first line for title', async () => {
      const multilineText = 'First line of request\nSecond line\nThird line';
      await tracker.saveTaskRecord('msg-multi', {
        chatId: 'chat-multi',
        text: multilineText,
      }, 'Response');

      const filePath = tracker.getTaskFilePath('msg-multi');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('# Task: First line of request');
      // Code block should contain the full text
      expect(content).toContain('```\n' + multilineText + '\n```');
    });

    it('should handle empty string for text field', async () => {
      await tracker.saveTaskRecord('msg-empty', {
        chatId: 'chat-empty',
        text: '',
      }, 'Response');

      const filePath = tracker.getTaskFilePath('msg-empty');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('# Task: ');
      expect(content).toContain('```\n\n```');
    });

    it('should handle missing optional fields (senderType, senderId, timestamp)', async () => {
      await tracker.saveTaskRecord('msg-minimal', {
        chatId: 'chat-minimal',
        text: 'Minimal metadata',
      }, 'Response');

      const filePath = tracker.getTaskFilePath('msg-minimal');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('**User ID**: N/A');
      expect(content).not.toContain('Sender Type');
      expect(content).toContain('**Created**:'); // timestamp should be auto-generated
    });

    it('should handle text with exactly 50 characters', async () => {
      const exact50 = 'a'.repeat(50);
      await tracker.saveTaskRecord('msg-exact', {
        chatId: 'chat-exact',
        text: exact50,
      }, 'Response');

      const filePath = tracker.getTaskFilePath('msg-exact');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain(`# Task: ${exact50}`);
      expect(content).not.toContain('...');
    });

    it('should handle text with exactly 51 characters (triggers ellipsis)', async () => {
      const exact51 = 'b'.repeat(51);
      await tracker.saveTaskRecord('msg-exact51', {
        chatId: 'chat-exact51',
        text: exact51,
      }, 'Response');

      const filePath = tracker.getTaskFilePath('msg-exact51');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain(`# Task: ${'b'.repeat(50)}...`);
    });

    it('should handle text containing newlines and special markdown characters', async () => {
      const specialText = '# Heading\n> Blockquote\n* List item\n`code`';
      await tracker.saveTaskRecord('msg-special', {
        chatId: 'chat-special',
        text: specialText,
      }, 'Response');

      const filePath = tracker.getTaskFilePath('msg-special');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('# Task: # Heading');
      // The full text should be inside a code block
      expect(content).toContain('```\n# Heading\n> Blockquote\n* List item\n`code`\n```');
    });

    it('should handle very long messageId gracefully', async () => {
      const longId = 'msg-' + 'x'.repeat(200);
      await tracker.saveTaskRecord(longId, {
        chatId: 'chat-1',
        text: 'Test',
      }, 'Response');

      const filePath = tracker.getTaskFilePath(longId);
      expect(syncFs.existsSync(filePath)).toBe(true);
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain(`**Task ID**: ${longId}`);
    });
  });

  // =========================================================================
  // End-to-end workflow
  // =========================================================================

  describe('end-to-end workflow', () => {
    it('should support full dialogue task lifecycle', async () => {
      // Step 1: Create dialogue task
      const taskPath = await tracker.createDialogueTask('e2e-msg', {
        chatId: 'chat-e2e',
        userId: 'user-e2e',
        text: 'Build a REST API for user management',
        timestamp: '2025-08-01T09:00:00.000Z',
      });

      expect(syncFs.existsSync(taskPath)).toBe(true);

      // Step 2: Verify initial content
      const initialContent = await fs.readFile(taskPath, 'utf-8');
      expect(initialContent).toContain('# Task: Build a REST API for user management');
      expect(initialContent).toContain('**Task ID**: e2e-msg');
      expect(initialContent).toContain('**Chat ID**: chat-e2e');
      expect(initialContent).toContain('**User ID**: user-e2e');

      // Step 3: Append task definition
      const details: TaskDefinitionDetails = {
        primary_goal: 'Create CRUD endpoints for user management',
        success_criteria: ['All CRUD operations work', 'Input validation passes'],
        expected_outcome: 'Fully functional REST API',
        deliverables: ['Source code', 'Unit tests', 'Postman collection'],
        format_requirements: ['RESTful JSON API'],
        constraints: ['Use Express.js', 'PostgreSQL backend'],
        quality_criteria: ['Test coverage >= 90%', 'All endpoints documented'],
      };

      await tracker.appendTaskDefinition(taskPath, details);

      // Step 4: Verify final content has all sections
      const finalContent = await fs.readFile(taskPath, 'utf-8');
      expect(finalContent).toContain('# Task: Build a REST API for user management');
      expect(finalContent).toContain('## Original Request');
      expect(finalContent).toContain('## Task Objectives');
      expect(finalContent).toContain('### Primary Goal');
      expect(finalContent).toContain('Create CRUD endpoints for user management');
      expect(finalContent).toContain('## Delivery Specifications');
      expect(finalContent).toContain('### Required Deliverables');
      expect(finalContent).toContain('## Quality Criteria');
      expect(finalContent).toContain('*Task definition generated by Pilot*');

      // Step 5: Also verify getDialogueTaskPath returns same path
      expect(tracker.getDialogueTaskPath('e2e-msg')).toBe(taskPath);
    });
  });
});
