/**
 * Unit tests for TaskTracker
 *
 * Tests task record persistence, directory management,
 * dialogue task creation, and task definition appending.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as syncFs from 'fs';
import * as path from 'path';
import { TaskTracker } from './task-tracker.js';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
}));

// Mock fs (sync)
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

describe('TaskTracker', () => {
  let tracker: TaskTracker;
  const workspaceDir = '/test/workspace';

  beforeEach(() => {
    vi.clearAllMocks();
    tracker = new TaskTracker(workspaceDir);
  });

  describe('constructor', () => {
    it('should set tasks directory to workspace/tasks', () => {
      expect(tracker.getTaskFilePath('msg-1')).toContain(path.join(workspaceDir, 'tasks'));
    });
  });

  describe('ensureTasksDir', () => {
    it('should create tasks directory recursively', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      await tracker.ensureTasksDir();
      expect(fs.mkdir).toHaveBeenCalledWith(path.join(workspaceDir, 'tasks'), { recursive: true });
    });

    it('should handle mkdir failure gracefully', async () => {
      const error = new Error('Permission denied');
      vi.mocked(fs.mkdir).mockRejectedValue(error);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await tracker.ensureTasksDir();
      expect(consoleSpy).toHaveBeenCalledWith('Failed to create tasks directory:', error);
      consoleSpy.mockRestore();
    });
  });

  describe('getTaskFilePath', () => {
    it('should sanitize message ID and return task.md path', () => {
      const result = tracker.getTaskFilePath('msg-123');
      expect(result).toBe(path.join(workspaceDir, 'tasks', 'msg-123', 'task.md'));
    });

    it('should replace special characters with underscores', () => {
      const result = tracker.getTaskFilePath('msg/with@special#chars');
      // The taskId part (after /tasks/) should be sanitized
      const taskIdPart = result.split('/tasks/')[1];
      expect(taskIdPart).toContain('msg_with_special_chars');
      expect(taskIdPart).not.toContain('@');
      expect(taskIdPart).not.toContain('#');
    });
  });

  describe('getDialogueTaskPath', () => {
    it('should return same path as getTaskFilePath', () => {
      const msgId = 'dialogue-msg-1';
      expect(tracker.getDialogueTaskPath(msgId)).toBe(tracker.getTaskFilePath(msgId));
    });

    it('should sanitize message ID', () => {
      const result = tracker.getDialogueTaskPath('msg@123');
      expect(result).toContain('msg_123');
    });
  });

  describe('saveTaskRecord', () => {
    it('should create task directory and write markdown file', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const metadata = {
        chatId: 'chat-1',
        senderType: 'user',
        senderId: 'user-1',
        text: 'Hello world',
      };
      await tracker.saveTaskRecord('msg-1', metadata, 'Response text');

      expect(fs.mkdir).toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalled();
      const [filePath, content] = vi.mocked(fs.writeFile).mock.calls[0];
      expect(filePath).toContain('task.md');
      expect(content).toContain('# Task: Hello world');
      expect(content).toContain('**Task ID**: msg-1');
      expect(content).toContain('**Chat ID**: chat-1');
      expect(content).toContain('**User ID**: user-1');
      expect(content).toContain('**Sender Type**: user');
      expect(content).toContain('Hello world');
    });

    it('should use provided timestamp', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await tracker.saveTaskRecord(
        'msg-1',
        { chatId: 'chat-1', text: 'Test', timestamp: '2026-01-01T00:00:00Z' },
        'Response'
      );

      const [, content] = vi.mocked(fs.writeFile).mock.calls[0];
      expect(content).toContain('**Created**: 2026-01-01T00:00:00Z');
    });

    it('should truncate long titles to 50 characters', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const longText = 'A'.repeat(100);
      await tracker.saveTaskRecord('msg-1', { chatId: 'chat-1', text: longText }, 'Response');

      const [, content] = vi.mocked(fs.writeFile).mock.calls[0];
      expect(content).toContain(`# Task: ${'A'.repeat(50)}...`);
    });

    it('should default userId to N/A when not provided', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await tracker.saveTaskRecord('msg-1', { chatId: 'chat-1', text: 'Test' }, 'Response');

      const [, content] = vi.mocked(fs.writeFile).mock.calls[0];
      expect(content).toContain('**User ID**: N/A');
    });

    it('should omit sender type when not provided', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await tracker.saveTaskRecord('msg-1', { chatId: 'chat-1', text: 'Test' }, 'Response');

      const [, content] = vi.mocked(fs.writeFile).mock.calls[0];
      expect(content).not.toContain('**Sender Type**');
    });

    it('should handle writeFile failure gracefully', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockRejectedValue(new Error('Disk full'));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await tracker.saveTaskRecord('msg-1', { chatId: 'chat-1', text: 'Test' }, 'Response');
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[Task save failed]'),
        expect.anything()
      );
      consoleSpy.mockRestore();
    });

    it('should use first line of multi-line text as title', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await tracker.saveTaskRecord(
        'msg-1',
        { chatId: 'chat-1', text: 'First line\nSecond line\nThird line' },
        'Response'
      );

      const [, content] = vi.mocked(fs.writeFile).mock.calls[0];
      expect(content).toContain('# Task: First line');
    });
  });

  describe('saveTaskRecordSync', () => {
    it('should create task directory and write markdown file synchronously', () => {
      vi.mocked(syncFs.existsSync).mockReturnValue(false);
      vi.mocked(syncFs.mkdirSync).mockReturnValue(undefined);
      vi.mocked(syncFs.writeFileSync).mockReturnValue(undefined);

      const metadata = {
        chatId: 'chat-1',
        senderType: 'user',
        senderId: 'user-1',
        text: 'Sync test',
      };
      tracker.saveTaskRecordSync('msg-1', metadata, 'Response text');

      expect(syncFs.mkdirSync).toHaveBeenCalled();
      expect(syncFs.writeFileSync).toHaveBeenCalled();
      const [filePath, content] = vi.mocked(syncFs.writeFileSync).mock.calls[0];
      expect(filePath).toContain('task.md');
      expect(content).toContain('# Task: Sync test');
    });

    it('should reuse existing task directory', () => {
      vi.mocked(syncFs.existsSync).mockReturnValue(true);
      vi.mocked(syncFs.writeFileSync).mockReturnValue(undefined);

      tracker.saveTaskRecordSync('msg-1', { chatId: 'chat-1', text: 'Test' }, 'Response');

      // Should not create directory if it already exists
      expect(syncFs.mkdirSync).not.toHaveBeenCalled();
    });

    it('should handle writeFileSync failure gracefully', () => {
      vi.mocked(syncFs.existsSync).mockReturnValue(true);
      vi.mocked(syncFs.writeFileSync).mockImplementation(() => {
        throw new Error('Disk full');
      });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      tracker.saveTaskRecordSync('msg-1', { chatId: 'chat-1', text: 'Test' }, 'Response');
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[Task save failed]'),
        expect.anything()
      );
      consoleSpy.mockRestore();
    });

    it('should throw when sync mkdir fails for tasks dir', () => {
      vi.mocked(syncFs.existsSync).mockReturnValue(false);
      vi.mocked(syncFs.mkdirSync).mockImplementation(() => {
        throw new Error('Cannot create dir');
      });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() =>
        tracker.saveTaskRecordSync('msg-1', { chatId: 'chat-1', text: 'Test' }, 'Response')
      ).toThrow('Cannot create dir');
      consoleSpy.mockRestore();
    });
  });

  describe('createDialogueTask', () => {
    it('should create dialogue task directory and write task.md', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const metadata = {
        chatId: 'chat-1',
        userId: 'user-1',
        text: 'Create a feature',
      };
      const result = await tracker.createDialogueTask('msg-1', metadata);

      expect(result).toContain('task.md');
      expect(fs.writeFile).toHaveBeenCalled();

      const [, content] = vi.mocked(fs.writeFile).mock.calls[0];
      expect(content).toContain('# Task: Create a feature');
      expect(content).toContain('**Task ID**: msg-1');
      expect(content).toContain('**Chat ID**: chat-1');
      expect(content).toContain('**User ID**: user-1');
      expect(content).toContain('## Original Request');
      expect(content).toContain('Create a feature');
    });

    it('should return the task file path', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const result = await tracker.createDialogueTask('msg-1', {
        chatId: 'chat-1',
        text: 'Test',
      });
      expect(result).toBe(tracker.getDialogueTaskPath('msg-1'));
    });

    it('should throw error when writeFile fails', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockRejectedValue(new Error('Write failed'));

      await expect(
        tracker.createDialogueTask('msg-1', { chatId: 'chat-1', text: 'Test' })
      ).rejects.toThrow('Write failed');
    });

    it('should default userId to N/A', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await tracker.createDialogueTask('msg-1', { chatId: 'chat-1', text: 'Test' });

      const [, content] = vi.mocked(fs.writeFile).mock.calls[0];
      expect(content).toContain('**User ID**: N/A');
    });
  });

  describe('appendTaskDefinition', () => {
    it('should append task definition details to existing task file', async () => {
      vi.mocked(fs.readFile).mockResolvedValue('# Existing task\n');
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const details = {
        primary_goal: 'Build a REST API',
        success_criteria: ['API responds with 200', 'Returns correct data'],
        expected_outcome: 'Working REST API endpoint',
        deliverables: ['API code', 'Tests'],
        format_requirements: ['TypeScript'],
        constraints: ['No external dependencies'],
        quality_criteria: ['Passes all tests'],
      };

      await tracker.appendTaskDefinition('/path/to/task.md', details);

      const [, writtenContent] = vi.mocked(fs.writeFile).mock.calls[0];
      expect(writtenContent).toContain('# Existing task\n');
      expect(writtenContent).toContain('## Task Objectives');
      expect(writtenContent).toContain('### Primary Goal');
      expect(writtenContent).toContain('Build a REST API');
      expect(writtenContent).toContain('### Success Criteria');
      expect(writtenContent).toContain('- API responds with 200');
      expect(writtenContent).toContain('- Returns correct data');
      expect(writtenContent).toContain('### Expected Outcome');
      expect(writtenContent).toContain('### Required Deliverables');
      expect(writtenContent).toContain('- API code');
      expect(writtenContent).toContain('### Format Requirements');
      expect(writtenContent).toContain('- TypeScript');
      expect(writtenContent).toContain('### Constraints');
      expect(writtenContent).toContain('- No external dependencies');
      expect(writtenContent).toContain('## Quality Criteria');
      expect(writtenContent).toContain('- Passes all tests');
      expect(writtenContent).toContain('*Task definition generated by Pilot*');
    });

    it('should omit optional sections when arrays are empty', async () => {
      vi.mocked(fs.readFile).mockResolvedValue('# Task\n');
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const details = {
        primary_goal: 'Goal',
        success_criteria: ['Criteria 1'],
        expected_outcome: 'Outcome',
        deliverables: ['Deliverable 1'],
        format_requirements: [],
        constraints: [],
        quality_criteria: ['Quality 1'],
      };

      await tracker.appendTaskDefinition('/path/to/task.md', details);

      const [, writtenContent] = vi.mocked(fs.writeFile).mock.calls[0];
      expect(writtenContent).not.toContain('### Format Requirements');
      expect(writtenContent).not.toContain('### Constraints');
    });

    it('should throw error when writeFile fails', async () => {
      vi.mocked(fs.readFile).mockResolvedValue('# Task\n');
      vi.mocked(fs.writeFile).mockRejectedValue(new Error('Write failed'));

      await expect(
        tracker.appendTaskDefinition('/path/to/task.md', {
          primary_goal: 'Goal',
          success_criteria: [],
          expected_outcome: 'Outcome',
          deliverables: [],
          format_requirements: [],
          constraints: [],
          quality_criteria: [],
        })
      ).rejects.toThrow('Write failed');
    });

    it('should throw error when readFile fails', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error('File not found'));

      await expect(
        tracker.appendTaskDefinition('/path/to/task.md', {
          primary_goal: 'Goal',
          success_criteria: [],
          expected_outcome: 'Outcome',
          deliverables: [],
          format_requirements: [],
          constraints: [],
          quality_criteria: [],
        })
      ).rejects.toThrow('File not found');
    });
  });
});
