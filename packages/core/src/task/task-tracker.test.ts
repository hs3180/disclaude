/**
 * Tests for TaskTracker (packages/core/src/task/task-tracker.ts)
 *
 * Tests the TaskTracker class which handles task file management on disk,
 * including path generation, saving task records, and dialogue task creation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Use vi.hoisted to define mock functions that can be referenced in vi.mock factory
const {
  mockMkdir,
  mockWriteFile,
  mockReadFile,
  mockMkdirSync,
  mockWriteFileSync,
  mockExistsSync,
} = vi.hoisted(() => ({
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockReadFile: vi.fn().mockResolvedValue(''),
  mockMkdirSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockExistsSync: vi.fn().mockReturnValue(true),
}));

vi.mock('fs/promises', () => ({
  default: {
    mkdir: mockMkdir,
    writeFile: mockWriteFile,
    readFile: mockReadFile,
  },
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
  readFile: mockReadFile,
}));

vi.mock('fs', () => ({
  default: {
    mkdirSync: mockMkdirSync,
    writeFileSync: mockWriteFileSync,
    existsSync: mockExistsSync,
  },
  mkdirSync: mockMkdirSync,
  writeFileSync: mockWriteFileSync,
  existsSync: mockExistsSync,
}));

import { TaskTracker } from './task-tracker.js';

// ============================================================================
// Helpers
// ============================================================================

const WORKSPACE_DIR = '/test-workspace';
const TASKS_DIR = '/test-workspace/tasks';

// ============================================================================
// TaskTracker Tests
// ============================================================================

describe('TaskTracker', () => {
  let tracker: TaskTracker;

  beforeEach(() => {
    vi.resetAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue('');
    mockMkdirSync.mockReturnValue(undefined);
    mockWriteFileSync.mockReturnValue(undefined);
    mockExistsSync.mockReturnValue(true);
    tracker = new TaskTracker(WORKSPACE_DIR);
  });

  // -------------------------------------------------------------------------
  // Path generation with sanitization
  // -------------------------------------------------------------------------
  describe('path generation', () => {
    it('should generate correct task file path', () => {
      const filePath = tracker.getTaskFilePath('msg_123');
      expect(filePath).toBe(`${TASKS_DIR}/msg_123/task.md`);
    });

    it('should sanitize special characters in message ID', () => {
      const filePath = tracker.getTaskFilePath('msg/123:456@abc');
      expect(filePath).toBe(`${TASKS_DIR}/msg_123_456_abc/task.md`);
    });

    it('should sanitize spaces in message ID', () => {
      const filePath = tracker.getTaskFilePath('msg 123 456');
      expect(filePath).toBe(`${TASKS_DIR}/msg_123_456/task.md`);
    });

    it('should preserve allowed characters (letters, numbers, underscore, hyphen)', () => {
      const filePath = tracker.getTaskFilePath('msg_ABC-123_def');
      expect(filePath).toBe(`${TASKS_DIR}/msg_ABC-123_def/task.md`);
    });

    it('should sanitize dots in message ID', () => {
      const filePath = tracker.getTaskFilePath('msg.123.456');
      expect(filePath).toBe(`${TASKS_DIR}/msg_123_456/task.md`);
    });

    it('should generate correct dialogue task path', () => {
      const filePath = tracker.getDialogueTaskPath('msg_123');
      expect(filePath).toBe(`${TASKS_DIR}/msg_123/task.md`);
    });

    it('should sanitize special chars in dialogue task path', () => {
      const filePath = tracker.getDialogueTaskPath('msg/123:456');
      expect(filePath).toBe(`${TASKS_DIR}/msg_123_456/task.md`);
    });
  });

  // -------------------------------------------------------------------------
  // ensureTasksDir
  // -------------------------------------------------------------------------
  describe('ensureTasksDir', () => {
    it('should create tasks directory', async () => {
      await tracker.ensureTasksDir();
      expect(mockMkdir).toHaveBeenCalledWith(TASKS_DIR, { recursive: true });
    });

    it('should handle mkdir errors gracefully', async () => {
      mockMkdir.mockRejectedValue(new Error('Permission denied'));
      // Should not throw
      await tracker.ensureTasksDir();
      // The error is caught and logged via console.error
    });
  });

  // -------------------------------------------------------------------------
  // saveTaskRecord (async)
  // -------------------------------------------------------------------------
  describe('saveTaskRecord', () => {
    it('should write a markdown file with correct format', async () => {
      await tracker.saveTaskRecord('msg_123', {
        chatId: 'oc_chat1',
        senderType: 'user',
        senderId: 'ou_user1',
        text: 'Build a feature',
        timestamp: '2026-03-01T00:00:00.000Z',
      }, 'Response content');

      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      const [filePath, content] = mockWriteFile.mock.calls[0];
      expect(filePath).toBe(`${TASKS_DIR}/msg_123/task.md`);
      const md = content as string;
      expect(md).toContain('# Task: Build a feature');
      expect(md).toContain('**Task ID**: msg_123');
      expect(md).toContain('**Created**: 2026-03-01T00:00:00.000Z');
      expect(md).toContain('**Chat ID**: oc_chat1');
      expect(md).toContain('**User ID**: ou_user1');
      expect(md).toContain('**Sender Type**: user');
      expect(md).toContain('## Original Request');
      expect(md).toContain('Build a feature');
    });

    it('should use default timestamp when not provided', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));

      await tracker.saveTaskRecord('msg_456', {
        chatId: 'oc_chat2',
        text: 'Do something',
      }, 'Response');

      const [, content] = mockWriteFile.mock.calls[0];
      expect(content as string).toContain('**Created**: 2026-06-15T12:00:00.000Z');

      vi.useRealTimers();
    });

    it('should truncate title to 50 characters', async () => {
      const longText = 'A'.repeat(100);
      await tracker.saveTaskRecord('msg_789', {
        chatId: 'oc_chat3',
        text: longText,
      }, 'Response');

      const [, content] = mockWriteFile.mock.calls[0];
      const md = content as string;
      // Title should be 50 chars + '...'
      const titleMatch = md.match(/^# Task: (.+)$/m);
      expect(titleMatch).not.toBeNull();
      expect(titleMatch![1].length).toBe(53); // 50 chars + '...'
    });

    it('should not add ellipsis when text is 50 chars or less', async () => {
      const shortText = 'A'.repeat(50);
      await tracker.saveTaskRecord('msg_100', {
        chatId: 'oc_chat4',
        text: shortText,
      }, 'Response');

      const [, content] = mockWriteFile.mock.calls[0];
      const md = content as string;
      const titleMatch = md.match(/^# Task: (.+)$/m);
      expect(titleMatch).not.toBeNull();
      expect(titleMatch![1].length).toBe(50);
      expect(titleMatch![1]).not.toContain('...');
    });

    it('should use first line as title when text has newlines', async () => {
      await tracker.saveTaskRecord('msg_200', {
        chatId: 'oc_chat5',
        text: 'First line\nSecond line\nThird line',
      }, 'Response');

      const [, content] = mockWriteFile.mock.calls[0];
      const md = content as string;
      expect(md).toContain('# Task: First line');
      // Full text should be in the Original Request section
      expect(md).toContain('Second line');
      expect(md).toContain('Third line');
    });

    it('should handle writeFile errors gracefully', async () => {
      mockWriteFile.mockRejectedValue(new Error('Disk full'));
      // Should not throw
      await tracker.saveTaskRecord('msg_300', {
        chatId: 'oc_chat6',
        text: 'test',
      }, 'Response');
    });

    it('should show N/A for missing senderId', async () => {
      await tracker.saveTaskRecord('msg_400', {
        chatId: 'oc_chat7',
        text: 'test',
      }, 'Response');

      const [, content] = mockWriteFile.mock.calls[0];
      expect(content as string).toContain('**User ID**: N/A');
    });

    it('should not include Sender Type line when not provided', async () => {
      await tracker.saveTaskRecord('msg_500', {
        chatId: 'oc_chat8',
        text: 'test',
      }, 'Response');

      const [, content] = mockWriteFile.mock.calls[0];
      expect(content as string).not.toContain('**Sender Type**');
    });

    it('should ensure task directory exists before writing', async () => {
      await tracker.saveTaskRecord('msg_600', {
        chatId: 'oc_chat9',
        text: 'test',
      }, 'Response');

      expect(mockMkdir).toHaveBeenCalledWith(TASKS_DIR, { recursive: true });
      expect(mockMkdir).toHaveBeenCalledWith(`${TASKS_DIR}/msg_600`, { recursive: true });
    });
  });

  // -------------------------------------------------------------------------
  // saveTaskRecordSync (sync)
  // -------------------------------------------------------------------------
  describe('saveTaskRecordSync', () => {
    it('should write a markdown file synchronously', () => {
      tracker.saveTaskRecordSync('msg_sync1', {
        chatId: 'oc_chat_sync1',
        senderType: 'user',
        senderId: 'ou_user_sync',
        text: 'Sync task',
        timestamp: '2026-03-01T00:00:00.000Z',
      }, 'Sync response');

      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const [filePath, content] = mockWriteFileSync.mock.calls[0];
      expect(filePath).toBe(`${TASKS_DIR}/msg_sync1/task.md`);
      const md = content as string;
      expect(md).toContain('# Task: Sync task');
      expect(md).toContain('**Task ID**: msg_sync1');
      expect(md).toContain('**Created**: 2026-03-01T00:00:00.000Z');
      expect(md).toContain('**Chat ID**: oc_chat_sync1');
      expect(md).toContain('**User ID**: ou_user_sync');
    });

    it('should use default timestamp when not provided (sync)', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-20T10:30:00.000Z'));

      tracker.saveTaskRecordSync('msg_sync2', {
        chatId: 'oc_chat_sync2',
        text: 'No timestamp',
      }, 'Response');

      const [, content] = mockWriteFileSync.mock.calls[0];
      expect(content as string).toContain('**Created**: 2026-07-20T10:30:00.000Z');

      vi.useRealTimers();
    });

    it('should handle writeFileSync errors gracefully', () => {
      mockWriteFileSync.mockImplementation(() => {
        throw new Error('Sync write failed');
      });
      // Should not throw
      tracker.saveTaskRecordSync('msg_sync3', {
        chatId: 'oc_chat_sync3',
        text: 'test',
      }, 'Response');
    });

    it('should ensure task directory exists synchronously', () => {
      mockExistsSync.mockReturnValue(false);
      tracker.saveTaskRecordSync('msg_sync4', {
        chatId: 'oc_chat_sync4',
        text: 'test',
      }, 'Response');

      expect(mockMkdirSync).toHaveBeenCalledWith(TASKS_DIR, { recursive: true });
      expect(mockMkdirSync).toHaveBeenCalledWith(`${TASKS_DIR}/msg_sync4`, { recursive: true });
    });

    it('should not create directory if it already exists (sync)', () => {
      mockExistsSync.mockReturnValue(true);
      tracker.saveTaskRecordSync('msg_sync5', {
        chatId: 'oc_chat_sync5',
        text: 'test',
      }, 'Response');

      // existsSync returns true for both tasksDir and task-specific dir,
      // so mkdirSync should not be called at all
      expect(mockMkdirSync).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // createDialogueTask
  // -------------------------------------------------------------------------
  describe('createDialogueTask', () => {
    it('should create task.md with correct format', async () => {
      const taskPath = await tracker.createDialogueTask('msg_dlg1', {
        chatId: 'oc_dlg1',
        userId: 'ou_dlg1',
        text: 'Dialogue task prompt',
        timestamp: '2026-03-15T08:00:00.000Z',
      });

      expect(taskPath).toBe(`${TASKS_DIR}/msg_dlg1/task.md`);
      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      const [filePath, content] = mockWriteFile.mock.calls[0];
      expect(filePath).toBe(taskPath);
      const md = content as string;
      expect(md).toContain('# Task: Dialogue task prompt');
      expect(md).toContain('**Task ID**: msg_dlg1');
      expect(md).toContain('**Created**: 2026-03-15T08:00:00.000Z');
      expect(md).toContain('**Chat ID**: oc_dlg1');
      expect(md).toContain('**User ID**: ou_dlg1');
      expect(md).toContain('## Original Request');
      expect(md).toContain('Dialogue task prompt');
    });

    it('should use default timestamp when not provided', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));

      await tracker.createDialogueTask('msg_dlg2', {
        chatId: 'oc_dlg2',
        text: 'No timestamp',
      });

      const [, content] = mockWriteFile.mock.calls[0];
      expect(content as string).toContain('**Created**: 2026-08-01T00:00:00.000Z');

      vi.useRealTimers();
    });

    it('should show N/A for missing userId', async () => {
      await tracker.createDialogueTask('msg_dlg3', {
        chatId: 'oc_dlg3',
        text: 'test',
      });

      const [, content] = mockWriteFile.mock.calls[0];
      expect(content as string).toContain('**User ID**: N/A');
    });

    it('should truncate title to 50 characters', async () => {
      const longText = 'B'.repeat(100);
      await tracker.createDialogueTask('msg_dlg4', {
        chatId: 'oc_dlg4',
        text: longText,
      });

      const [, content] = mockWriteFile.mock.calls[0];
      const md = content as string;
      const titleMatch = md.match(/^# Task: (.+)$/m);
      expect(titleMatch).not.toBeNull();
      expect(titleMatch![1].length).toBe(53); // 50 + '...'
    });

    it('should ensure task directory exists before creating', async () => {
      await tracker.createDialogueTask('msg_dlg5', {
        chatId: 'oc_dlg5',
        text: 'test',
      });

      expect(mockMkdir).toHaveBeenCalledWith(TASKS_DIR, { recursive: true });
      expect(mockMkdir).toHaveBeenCalledWith(`${TASKS_DIR}/msg_dlg5`, { recursive: true });
    });

    it('should throw on writeFile failure', async () => {
      mockWriteFile.mockRejectedValue(new Error('Write failed'));

      await expect(
        tracker.createDialogueTask('msg_dlg6', {
          chatId: 'oc_dlg6',
          text: 'test',
        }),
      ).rejects.toThrow('Write failed');
    });
  });

  // -------------------------------------------------------------------------
  // appendTaskDefinition
  // -------------------------------------------------------------------------
  describe('appendTaskDefinition', () => {
    it('should append task objectives section to existing content', async () => {
      mockReadFile.mockResolvedValue('# Task: Test\n\nExisting content');

      const details = {
        primary_goal: 'Achieve the goal',
        success_criteria: ['Criterion 1', 'Criterion 2'],
        expected_outcome: 'Expected result',
        deliverables: ['Deliverable 1', 'Deliverable 2'],
        format_requirements: ['Format req 1'],
        constraints: ['Constraint 1'],
        quality_criteria: ['Quality 1', 'Quality 2'],
      };

      await tracker.appendTaskDefinition('/path/to/task.md', details);

      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      const [filePath, content] = mockWriteFile.mock.calls[0];
      expect(filePath).toBe('/path/to/task.md');
      const md = content as string;

      // Should contain original content
      expect(md).toContain('# Task: Test');
      expect(md).toContain('Existing content');

      // Should contain appended sections
      expect(md).toContain('## Task Objectives');
      expect(md).toContain('### Primary Goal');
      expect(md).toContain('Achieve the goal');
      expect(md).toContain('### Success Criteria');
      expect(md).toContain('- Criterion 1');
      expect(md).toContain('- Criterion 2');
      expect(md).toContain('### Expected Outcome');
      expect(md).toContain('Expected result');
      expect(md).toContain('## Delivery Specifications');
      expect(md).toContain('### Required Deliverables');
      expect(md).toContain('- Deliverable 1');
      expect(md).toContain('- Deliverable 2');
      expect(md).toContain('### Format Requirements');
      expect(md).toContain('- Format req 1');
      expect(md).toContain('### Constraints');
      expect(md).toContain('- Constraint 1');
      expect(md).toContain('## Quality Criteria');
      expect(md).toContain('- Quality 1');
      expect(md).toContain('- Quality 2');
      expect(md).toContain('Task definition generated by Pilot');
    });

    it('should omit format requirements section when empty', async () => {
      mockReadFile.mockResolvedValue('# Task: Test\n\nContent');

      const details = {
        primary_goal: 'Goal',
        success_criteria: ['C1'],
        expected_outcome: 'Outcome',
        deliverables: ['D1'],
        format_requirements: [],
        constraints: [],
        quality_criteria: ['Q1'],
      };

      await tracker.appendTaskDefinition('/path/to/task.md', details);

      const [, content] = mockWriteFile.mock.calls[0];
      const md = content as string;
      expect(md).not.toContain('### Format Requirements');
      expect(md).not.toContain('### Constraints');
    });

    it('should include format requirements and constraints when present', async () => {
      mockReadFile.mockResolvedValue('# Task: Test\n\nContent');

      const details = {
        primary_goal: 'Goal',
        success_criteria: ['C1'],
        expected_outcome: 'Outcome',
        deliverables: ['D1'],
        format_requirements: ['Must be JSON'],
        constraints: ['No external APIs'],
        quality_criteria: ['Q1'],
      };

      await tracker.appendTaskDefinition('/path/to/task.md', details);

      const [, content] = mockWriteFile.mock.calls[0];
      const md = content as string;
      expect(md).toContain('### Format Requirements');
      expect(md).toContain('- Must be JSON');
      expect(md).toContain('### Constraints');
      expect(md).toContain('- No external APIs');
    });

    it('should throw on readFile failure', async () => {
      mockReadFile.mockRejectedValue(new Error('File not found'));

      await expect(
        tracker.appendTaskDefinition('/path/to/task.md', {
          primary_goal: 'Goal',
          success_criteria: [],
          expected_outcome: 'Outcome',
          deliverables: [],
          format_requirements: [],
          constraints: [],
          quality_criteria: [],
        }),
      ).rejects.toThrow('File not found');
    });

    it('should throw on writeFile failure', async () => {
      mockReadFile.mockResolvedValue('# Task: Test\n\nContent');
      mockWriteFile.mockRejectedValue(new Error('Write failed'));

      await expect(
        tracker.appendTaskDefinition('/path/to/task.md', {
          primary_goal: 'Goal',
          success_criteria: [],
          expected_outcome: 'Outcome',
          deliverables: [],
          format_requirements: [],
          constraints: [],
          quality_criteria: [],
        }),
      ).rejects.toThrow('Write failed');
    });

    it('should preserve all existing content', async () => {
      const existing = `# Task: Original Title

**Task ID**: msg_123
**Created**: 2026-01-01T00:00:00.000Z

## Original Request

\`\`\`
Original request text
\`\`\`
`;
      mockReadFile.mockResolvedValue(existing);

      await tracker.appendTaskDefinition('/path/to/task.md', {
        primary_goal: 'Goal',
        success_criteria: ['SC1'],
        expected_outcome: 'Outcome',
        deliverables: ['D1'],
        format_requirements: [],
        constraints: [],
        quality_criteria: ['Q1'],
      });

      const [, content] = mockWriteFile.mock.calls[0];
      expect(content as string).toContain('# Task: Original Title');
      expect(content as string).toContain('Original request text');
    });
  });
});
