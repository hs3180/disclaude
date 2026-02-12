/**
 * Tests for task tracker (src/utils/task-tracker.ts)
 *
 * Tests the following functionality:
 * - Creating and managing task directories
 * - Saving task records (async and sync)
 * - Dialogue task management
 * - File path generation and sanitization
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as syncFs from 'fs';
import * as path from 'path';
import { TaskTracker } from './task-tracker.js';

// Mock fs modules
vi.mock('fs/promises');
vi.mock('fs');

const mockedFs = vi.mocked(fs);
const mockedSyncFs = vi.mocked(syncFs);

// Mock Config
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: () => '/mock/workspace',
  },
}));

describe('TaskTracker', () => {
  let taskTracker: TaskTracker;

  beforeEach(() => {
    taskTracker = new TaskTracker('/mock/workspace');
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should use default workspace directory when not provided', () => {
      const tracker = new TaskTracker();
      expect(tracker).toBeInstanceOf(TaskTracker);
    });

    it('should use provided base directory', () => {
      const tracker = new TaskTracker('/custom/workspace');
      expect(tracker).toBeInstanceOf(TaskTracker);
    });
  });

  describe('ensureTasksDir', () => {
    it('should create tasks directory', async () => {
      await taskTracker.ensureTasksDir();

      expect(mockedFs.mkdir).toHaveBeenCalledWith(
        path.join('/mock/workspace', 'tasks'),
        { recursive: true }
      );
    });

    it('should handle mkdir errors gracefully', async () => {
      mockedFs.mkdir.mockRejectedValueOnce(new Error('Permission denied'));

      await expect(taskTracker.ensureTasksDir()).resolves.not.toThrow();
    });
  });

  describe('getTaskFilePath', () => {
    it('should return correct file path for valid message ID', () => {
      const filePath = taskTracker.getTaskFilePath('om_msg123');

      expect(filePath).toContain('om_msg123');
      expect(filePath).toContain('task.md');
    });

    it('should sanitize message ID with special characters', () => {
      const filePath = taskTracker.getTaskFilePath('om/msg-123.456_test');

      // The regex keeps alphanumeric, underscore, and hyphen
      expect(filePath).toContain('om_msg-123_456_test');
    });
  });

  // Note: hasTaskRecord removed - deduplication now handled by MessageLogger
  // This test suite removed as the method no longer exists

  describe('saveTaskRecord', () => {
    it('should save task record with metadata', async () => {
      const metadata = {
        chatId: 'oc_chat123',
        senderType: 'user',
        senderId: 'ou_user456',
        text: 'Test request',
        timestamp: '2024-01-01T00:00:00Z',
      };
      const content = 'Test response';

      await taskTracker.saveTaskRecord('om_msg123', metadata, content);

      expect(mockedFs.mkdir).toHaveBeenCalled();
      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('task.md'),
        expect.stringContaining('Test request'),
        'utf-8'
      );
    });

    it('should generate timestamp when not provided', async () => {
      const metadata = {
        chatId: 'oc_chat123',
        text: 'Test request',
      };

      await taskTracker.saveTaskRecord('om_msg123', metadata, 'Response');

      expect(mockedFs.writeFile).toHaveBeenCalled();
    });

    it('should handle write errors', async () => {
      mockedFs.mkdir.mockResolvedValueOnce(undefined);
      mockedFs.writeFile.mockRejectedValueOnce(new Error('Write failed'));

      await expect(
        taskTracker.saveTaskRecord('om_msg123', {
          chatId: 'oc_test',
          text: 'Test',
        }, 'Response')
      ).resolves.not.toThrow();
    });
  });

  describe('saveTaskRecordSync', () => {
    it('should save task record synchronously', () => {
      const metadata = {
        chatId: 'oc_chat123',
        text: 'Test request',
        timestamp: '2024-01-01T00:00:00Z',
      };

      taskTracker.saveTaskRecordSync('om_msg123', metadata, 'Response');

      expect(mockedSyncFs.mkdirSync).toHaveBeenCalled();
      expect(mockedSyncFs.writeFileSync).toHaveBeenCalled();
    });

    it('should sanitize message ID in sync mode', () => {
      taskTracker.saveTaskRecordSync('om/msg-123', {
        chatId: 'oc_test',
        text: 'Test',
      }, 'Response');

      // Should call mkdirSync twice: once for regular dir, once for task dir
      expect(mockedSyncFs.mkdirSync).toHaveBeenCalledTimes(2);
      // The second call should be for the sanitized task directory
      expect(mockedSyncFs.mkdirSync).toHaveBeenNthCalledWith(2,
        expect.stringContaining('om_msg-123'),
        expect.any(Object)
      );
    });
  });

  describe('getDialogueTaskPath', () => {
    it('should return correct dialogue task path', () => {
      const taskPath = taskTracker.getDialogueTaskPath('om_msg123');

      expect(taskPath).toContain('om_msg123');
      expect(taskPath).toContain('task.md');
    });

    it('should sanitize message ID', () => {
      const taskPath = taskTracker.getDialogueTaskPath('om/msg.123');

      expect(taskPath).toContain('om_msg_123');
    });
  });

  describe('createDialogueTask', () => {
    it('should create dialogue task file', async () => {
      const metadata = {
        chatId: 'oc_chat123',
        userId: 'ou_user456',
        text: 'Test request for dialogue task',
        timestamp: '2024-01-01T00:00:00Z',
      };

      const taskPath = await taskTracker.createDialogueTask('om_msg123', metadata);

      expect(taskPath).toContain('om_msg123');
      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        taskPath,
        expect.stringContaining('Test request for dialogue task'),
        'utf-8'
      );
    });

    it('should generate timestamp when not provided', async () => {
      const metadata = {
        chatId: 'oc_chat123',
        text: 'Test request',
      };

      await taskTracker.createDialogueTask('om_msg123', metadata);

      expect(mockedFs.writeFile).toHaveBeenCalled();
    });

    it('should handle write errors', async () => {
      mockedFs.mkdir.mockResolvedValueOnce(undefined);
      mockedFs.writeFile.mockRejectedValueOnce(new Error('Write failed'));

      await expect(
        taskTracker.createDialogueTask('om_msg123', {
          chatId: 'oc_test',
          text: 'Test',
        })
      ).rejects.toThrow();
    });
  });

  describe('appendTaskDefinition', () => {
    it('should append task definition to existing file', async () => {
      mockedFs.readFile.mockResolvedValueOnce('# Existing Content\n');
      mockedFs.writeFile.mockResolvedValueOnce(undefined);

      const details = {
        primary_goal: 'Test goal',
        success_criteria: ['criteria 1', 'criteria 2'],
        expected_outcome: 'Expected outcome',
        deliverables: ['deliverable 1', 'deliverable 2'],
        format_requirements: ['format 1'],
        constraints: ['constraint 1'],
        quality_criteria: ['quality 1', 'quality 2'],
      };

      await taskTracker.appendTaskDefinition('/path/to/task.md', details);

      expect(mockedFs.readFile).toHaveBeenCalledWith('/path/to/task.md', 'utf-8');
      expect(mockedFs.writeFile).toHaveBeenCalled();
    });

    it('should handle missing optional arrays', async () => {
      mockedFs.readFile.mockResolvedValueOnce('# Existing\n');
      mockedFs.writeFile.mockResolvedValueOnce(undefined);

      const details = {
        primary_goal: 'Goal',
        success_criteria: ['criteria'],
        expected_outcome: 'Outcome',
        deliverables: ['deliverable'],
        format_requirements: [],
        constraints: [],
        quality_criteria: ['quality'],
      };

      await taskTracker.appendTaskDefinition('/path/to/task.md', details);

      expect(mockedFs.writeFile).toHaveBeenCalled();
    });
  });

  describe('file path sanitization', () => {
    it('should replace special characters but keep valid ones', () => {
      const filePath1 = taskTracker.getTaskFilePath('om/msg-123.456_test');
      // Keeps alphanumeric, underscore, hyphen
      expect(filePath1).toContain('om_msg-123_456_test');
    });

    it('should preserve valid characters', () => {
      const filePath = taskTracker.getTaskFilePath('om_msg-123_Test');
      expect(filePath).toContain('om_msg-123_Test');
    });
  });
});
