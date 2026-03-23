/**
 * Tests for ScheduleFileScanner (packages/core/src/scheduling/schedule-watcher.ts)
 *
 * Tests the ScheduleFileScanner class which handles parsing, writing, and
 * managing schedule markdown files with YAML frontmatter.
 *
 * Uses vi.mock for ESM module mocking since vi.spyOn doesn't work with
 * ESM namespace exports.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Use vi.hoisted to define mock functions that can be referenced in vi.mock factory
const { mockMkdir, mockWriteFile, mockReadFile, mockReaddir, mockStat, mockUnlink } = vi.hoisted(() => ({
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockReadFile: vi.fn().mockResolvedValue(''),
  mockReaddir: vi.fn().mockResolvedValue([]),
  mockStat: vi.fn().mockResolvedValue({
    mtime: new Date('2026-01-01'),
    birthtime: new Date('2026-01-01'),
  }),
  mockUnlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('fs/promises', () => ({
  default: {
    mkdir: mockMkdir,
    writeFile: mockWriteFile,
    readFile: mockReadFile,
    readdir: mockReaddir,
    stat: mockStat,
    unlink: mockUnlink,
  },
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
  readFile: mockReadFile,
  readdir: mockReaddir,
  stat: mockStat,
  unlink: mockUnlink,
}));

import { ScheduleFileScanner } from './schedule-watcher.js';
import type { ScheduledTask } from './scheduled-task.js';

// ============================================================================
// Helpers
// ============================================================================

const MOCK_DIR = '/tmp/test-schedules';

/** Create a valid schedule markdown content. */
function makeScheduleContent(overrides: Record<string, string> = {}): string {
  const defaults: Record<string, string> = {
    name: 'Daily Report',
    cron: '0 9 * * *',
    chatId: 'oc_test123',
    enabled: 'true',
    blocking: 'true',
  };
  const merged = { ...defaults, ...overrides };
  const lines = ['---'];
  for (const [key, value] of Object.entries(merged)) {
    if (value === 'true' || value === 'false' || /^\d+$/.test(value)) {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: "${value}"`);
    }
  }
  lines.push('---', '', 'Execute the daily report task.');
  return lines.join('\n');
}

// ============================================================================
// ScheduleFileScanner Tests
// ============================================================================

describe('ScheduleFileScanner', () => {
  let scanner: ScheduleFileScanner;

  beforeEach(() => {
    vi.clearAllMocks();
    scanner = new ScheduleFileScanner({ schedulesDir: MOCK_DIR });
  });

  describe('ensureDir', () => {
    it('should create the schedules directory', async () => {
      await scanner.ensureDir();
      expect(mockMkdir).toHaveBeenCalledWith(MOCK_DIR, { recursive: true });
    });
  });

  describe('parseFile', () => {
    it('should parse a valid schedule file', async () => {
      const content = makeScheduleContent();
      mockReadFile.mockResolvedValue(content);

      const task = await scanner.parseFile(`${MOCK_DIR}/daily-report.md`);

      expect(task).not.toBeNull();
      expect(task!.id).toBe('schedule-daily-report');
      expect(task!.name).toBe('Daily Report');
      expect(task!.cron).toBe('0 9 * * *');
      expect(task!.chatId).toBe('oc_test123');
      expect(task!.enabled).toBe(true);
      expect(task!.blocking).toBe(true);
      expect(task!.prompt).toContain('Execute the daily report task');
    });

    it('should return null when required fields are missing (no name)', async () => {
      const content = makeScheduleContent();
      const contentNoName = content.replace(/name: ".*"\n/, '');
      mockReadFile.mockResolvedValue(contentNoName);

      const task = await scanner.parseFile(`${MOCK_DIR}/invalid.md`);
      expect(task).toBeNull();
    });

    it('should return null when cron is missing', async () => {
      const content = makeScheduleContent();
      const contentNoCron = content.replace(/cron: ".*"\n/, '');
      mockReadFile.mockResolvedValue(contentNoCron);

      const task = await scanner.parseFile(`${MOCK_DIR}/invalid.md`);
      expect(task).toBeNull();
    });

    it('should return null when chatId is missing', async () => {
      const content = makeScheduleContent();
      const contentNoChatId = content.replace(/chatId: ".*"\n/, '');
      mockReadFile.mockResolvedValue(contentNoChatId);

      const task = await scanner.parseFile(`${MOCK_DIR}/invalid.md`);
      expect(task).toBeNull();
    });

    it('should return null when file read fails', async () => {
      mockReadFile.mockRejectedValue(new Error('Permission denied'));

      const task = await scanner.parseFile(`${MOCK_DIR}/missing.md`);
      expect(task).toBeNull();
    });

    it('should handle file without frontmatter gracefully', async () => {
      mockReadFile.mockResolvedValue('Just some content without frontmatter');

      const task = await scanner.parseFile(`${MOCK_DIR}/no-frontmatter.md`);
      expect(task).toBeNull();
    });

    it('should parse optional fields', async () => {
      const content = [
        '---',
        'name: "Custom Task"',
        'cron: "*/30 * * * *"',
        'chatId: "oc_custom"',
        'enabled: false',
        'blocking: false',
        'cooldownPeriod: 3600000',
        'createdBy: "ou_user123"',
        'createdAt: "2026-01-15T10:00:00Z"',
        '---',
        '',
        'Custom task prompt.',
      ].join('\n');

      mockReadFile.mockResolvedValue(content);

      const task = await scanner.parseFile(`${MOCK_DIR}/custom-task.md`);
      expect(task).not.toBeNull();
      expect(task!.enabled).toBe(false);
      expect(task!.blocking).toBe(false);
      expect(task!.cooldownPeriod).toBe(3600000);
      expect(task!.createdBy).toBe('ou_user123');
      expect(task!.createdAt).toBe('2026-01-15T10:00:00Z');
    });

    it('should parse unquoted string values', async () => {
      const content = [
        '---',
        'name: Unquoted Name',
        'cron: 0 9 * * *',
        'chatId: oc_unquoted',
        '---',
        '',
        'Task content.',
      ].join('\n');

      mockReadFile.mockResolvedValue(content);

      const task = await scanner.parseFile(`${MOCK_DIR}/unquoted.md`);
      expect(task).not.toBeNull();
      expect(task!.name).toBe('Unquoted Name');
      expect(task!.cron).toBe('0 9 * * *');
      expect(task!.chatId).toBe('oc_unquoted');
    });

    it('should parse quoted string values (stripping quotes)', async () => {
      const content = [
        '---',
        'name: "Quoted Name"',
        'cron: "0 9 * * *"',
        'chatId: "oc_quoted"',
        '---',
        '',
        'Task content.',
      ].join('\n');

      mockReadFile.mockResolvedValue(content);

      const task = await scanner.parseFile(`${MOCK_DIR}/quoted.md`);
      expect(task).not.toBeNull();
      expect(task!.name).toBe('Quoted Name');
      expect(task!.cron).toBe('0 9 * * *');
    });

    it('should default enabled to true when not specified', async () => {
      const content = [
        '---',
        'name: "Default Enabled"',
        'cron: "0 9 * * *"',
        'chatId: "oc_test"',
        '---',
        '',
        'Task content.',
      ].join('\n');

      mockReadFile.mockResolvedValue(content);

      const task = await scanner.parseFile(`${MOCK_DIR}/default-enabled.md`);
      expect(task).not.toBeNull();
      expect(task!.enabled).toBe(true);
    });

    it('should include sourceFile and fileMtime', async () => {
      mockReadFile.mockResolvedValue(makeScheduleContent());
      mockStat.mockResolvedValue({
        mtime: new Date('2026-03-20T12:00:00Z'),
        birthtime: new Date('2026-01-01T00:00:00Z'),
      } as Awaited<ReturnType<typeof import('fs/promises').stat>>);

      const task = await scanner.parseFile(`${MOCK_DIR}/test.md`);
      expect(task).not.toBeNull();
      expect(task!.sourceFile).toBe(`${MOCK_DIR}/test.md`);
      expect(task!.fileMtime).toEqual(new Date('2026-03-20T12:00:00Z'));
    });
  });

  describe('scanAll', () => {
    it('should scan all .md files in the directory', async () => {
      mockReaddir.mockResolvedValue(['daily-report.md', 'weekly-summary.md', 'notes.txt']);
      mockReadFile.mockResolvedValue(makeScheduleContent());

      const tasks = await scanner.scanAll();
      expect(tasks).toHaveLength(2);
      expect(mockReadFile).toHaveBeenCalledTimes(2);
    });

    it('should return empty array when directory does not exist', async () => {
      mockReaddir.mockRejectedValue({ code: 'ENOENT' } as NodeJS.ErrnoException);

      const tasks = await scanner.scanAll();
      expect(tasks).toEqual([]);
    });

    it('should skip files that fail to parse', async () => {
      mockReaddir.mockResolvedValue(['valid.md', 'invalid.md']);
      mockReadFile
        .mockResolvedValueOnce(makeScheduleContent())
        .mockResolvedValueOnce('no frontmatter');

      const tasks = await scanner.scanAll();
      expect(tasks).toHaveLength(1);
    });

    it('should throw on non-ENOENT errors during scan', async () => {
      mockReaddir.mockRejectedValue(new Error('Permission denied'));

      await expect(scanner.scanAll()).rejects.toThrow('Permission denied');
    });
  });

  describe('writeTask', () => {
    it('should write a task with schedule- prefix stripped from filename', async () => {
      const task: ScheduledTask = {
        id: 'schedule-daily-report',
        name: 'Daily Report',
        cron: '0 9 * * *',
        prompt: 'Execute daily report',
        chatId: 'oc_test',
        enabled: true,
        blocking: true,
        createdAt: '2026-01-01T00:00:00Z',
      };

      const filePath = await scanner.writeTask(task);
      expect(filePath).toBe(`${MOCK_DIR}/daily-report.md`);
      expect(mockWriteFile).toHaveBeenCalledTimes(1);

      const writtenContent = mockWriteFile.mock.calls[0][1] as string;
      expect(writtenContent).toContain('name: "Daily Report"');
      expect(writtenContent).toContain('cron: "0 9 * * *"');
      expect(writtenContent).toContain('chatId: oc_test');
      expect(writtenContent).toContain('Execute daily report');
    });

    it('should write optional fields when present', async () => {
      const task: ScheduledTask = {
        id: 'schedule-custom',
        name: 'Custom',
        cron: '*/30 * * * *',
        prompt: 'Custom task',
        chatId: 'oc_test',
        enabled: false,
        blocking: false,
        cooldownPeriod: 3600000,
        createdBy: 'ou_user',
        createdAt: '2026-03-01',
      };

      await scanner.writeTask(task);

      const writtenContent = mockWriteFile.mock.calls[0][1] as string;
      expect(writtenContent).toContain('cooldownPeriod: 3600000');
      expect(writtenContent).toContain('createdBy: ou_user');
      expect(writtenContent).toContain('createdAt: "2026-03-01"');
    });

    it('should handle task IDs without schedule- prefix', async () => {
      const task: ScheduledTask = {
        id: 'my-task',
        name: 'My Task',
        cron: '0 * * * *',
        prompt: 'Do stuff',
        chatId: 'oc_test',
        enabled: true,
        createdAt: '2026-01-01',
      };

      const filePath = await scanner.writeTask(task);
      expect(filePath).toBe(`${MOCK_DIR}/my-task.md`);
    });

    it('should call ensureDir before writing', async () => {
      const task: ScheduledTask = {
        id: 'schedule-test',
        name: 'Test',
        cron: '0 0 * * *',
        prompt: 'test',
        chatId: 'oc_test',
        enabled: true,
        createdAt: '2026-01-01',
      };

      await scanner.writeTask(task);
      expect(mockMkdir).toHaveBeenCalledWith(MOCK_DIR, { recursive: true });
    });
  });

  describe('deleteTask', () => {
    it('should delete a task file and return true', async () => {
      const result = await scanner.deleteTask('schedule-daily-report');
      expect(result).toBe(true);
      expect(mockUnlink).toHaveBeenCalledWith(`${MOCK_DIR}/daily-report.md`);
    });

    it('should return false for task IDs without schedule- prefix', async () => {
      const result = await scanner.deleteTask('not-a-schedule-id');
      expect(result).toBe(false);
      expect(mockUnlink).not.toHaveBeenCalled();
    });

    it('should return false when file does not exist (ENOENT)', async () => {
      mockUnlink.mockRejectedValue({ code: 'ENOENT' } as NodeJS.ErrnoException);

      const result = await scanner.deleteTask('schedule-nonexistent');
      expect(result).toBe(false);
    });

    it('should throw on non-ENOENT errors', async () => {
      mockUnlink.mockRejectedValue(new Error('Permission denied'));

      await expect(scanner.deleteTask('schedule-test')).rejects.toThrow('Permission denied');
    });
  });

  describe('getFilePath', () => {
    it('should strip schedule- prefix from task ID', () => {
      const filePath = scanner.getFilePath('schedule-daily-report');
      expect(filePath).toBe(`${MOCK_DIR}/daily-report.md`);
    });

    it('should use task ID as-is without schedule- prefix', () => {
      const filePath = scanner.getFilePath('my-task');
      expect(filePath).toBe(`${MOCK_DIR}/my-task.md`);
    });
  });
});
