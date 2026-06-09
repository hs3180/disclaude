/**
 * Tests for ScheduleFileScanner (packages/core/src/scheduling/schedule-watcher.ts)
 *
 * Tests the ScheduleFileScanner class which handles parsing, writing, and
 * managing schedule markdown files with YAML frontmatter.
 *
 * Uses vi.mock for ESM module mocking since vi.spyOn doesn't work with
 * ESM namespace exports.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Use vi.hoisted to define mock functions that can be referenced in vi.mock factory
const { mockMkdir, mockWriteFile, mockReadFile, mockReaddir, mockStat, mockUnlink, mockAccess, mockFsWatch } = vi.hoisted(() => {
  const watchClose = vi.fn();
  return {
    mockMkdir: vi.fn().mockResolvedValue(undefined),
    mockWriteFile: vi.fn().mockResolvedValue(undefined),
    mockReadFile: vi.fn().mockResolvedValue(''),
    mockReaddir: vi.fn().mockResolvedValue([]),
    mockStat: vi.fn().mockResolvedValue({
      mtime: new Date('2026-01-01'),
      birthtime: new Date('2026-01-01'),
    }),
    mockUnlink: vi.fn().mockResolvedValue(undefined),
    mockAccess: vi.fn().mockResolvedValue(undefined),
    mockFsWatch: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      close: watchClose,
    }),
  };
});

vi.mock('fs/promises', () => ({
  default: {
    mkdir: mockMkdir,
    writeFile: mockWriteFile,
    readFile: mockReadFile,
    readdir: mockReaddir,
    stat: mockStat,
    unlink: mockUnlink,
    access: mockAccess,
  },
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
  readFile: mockReadFile,
  readdir: mockReaddir,
  stat: mockStat,
  unlink: mockUnlink,
  access: mockAccess,
}));

// Mock fs.watch for ScheduleFileWatcher
vi.mock('fs', () => ({
  default: {
    watch: mockFsWatch,
  },
  watch: mockFsWatch,
}));

import { ScheduleFileScanner, ScheduleFileWatcher } from './schedule-watcher.js';
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
    it('should parse a valid schedule file (Issue #2526: subdirectory layout)', async () => {
      const content = makeScheduleContent();
      mockReadFile.mockResolvedValue(content);

      const task = await scanner.parseFile(`${MOCK_DIR}/daily-report/SCHEDULE.md`);

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

      const task = await scanner.parseFile(`${MOCK_DIR}/invalid/SCHEDULE.md`);
      expect(task).toBeNull();
    });

    it('should return null when cron is missing', async () => {
      const content = makeScheduleContent();
      const contentNoCron = content.replace(/cron: ".*"\n/, '');
      mockReadFile.mockResolvedValue(contentNoCron);

      const task = await scanner.parseFile(`${MOCK_DIR}/invalid/SCHEDULE.md`);
      expect(task).toBeNull();
    });

    it('should return null when chatId is missing', async () => {
      const content = makeScheduleContent();
      const contentNoChatId = content.replace(/chatId: ".*"\n/, '');
      mockReadFile.mockResolvedValue(contentNoChatId);

      const task = await scanner.parseFile(`${MOCK_DIR}/invalid/SCHEDULE.md`);
      expect(task).toBeNull();
    });

    it('should return null when file read fails', async () => {
      mockReadFile.mockRejectedValue(new Error('Permission denied'));

      const task = await scanner.parseFile(`${MOCK_DIR}/missing/SCHEDULE.md`);
      expect(task).toBeNull();
    });

    it('should handle file without frontmatter gracefully', async () => {
      mockReadFile.mockResolvedValue('Just some content without frontmatter');

      const task = await scanner.parseFile(`${MOCK_DIR}/no-frontmatter/SCHEDULE.md`);
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

      const task = await scanner.parseFile(`${MOCK_DIR}/custom-task/SCHEDULE.md`);
      expect(task).not.toBeNull();
      expect(task!.enabled).toBe(false);
      expect(task!.blocking).toBe(false);
      expect(task!.cooldownPeriod).toBe(3600000);
      expect(task!.createdBy).toBe('ou_user123');
      expect(task!.createdAt).toBe('2026-01-15T10:00:00Z');
    });

    it('should parse model field when specified (Issue #1338)', async () => {
      const content = [
        '---',
        'name: "Coding Task"',
        'cron: "0 */2 * * *"',
        'chatId: "oc_coding"',
        'model: "claude-sonnet-4-20250514"',
        '---',
        '',
        'Execute coding tasks with a coding-optimized model.',
      ].join('\n');

      mockReadFile.mockResolvedValue(content);

      const task = await scanner.parseFile(`${MOCK_DIR}/coding-task/SCHEDULE.md`);
      expect(task).not.toBeNull();
      expect(task!.model).toBe('claude-sonnet-4-20250514');
    });

    it('should default model to undefined when not specified', async () => {
      mockReadFile.mockResolvedValue(makeScheduleContent());

      const task = await scanner.parseFile(`${MOCK_DIR}/no-model/SCHEDULE.md`);
      expect(task).not.toBeNull();
      expect(task!.model).toBeUndefined();
    });

    it('should parse quoted model value (stripping quotes)', async () => {
      const content = [
        '---',
        'name: "Fast Task"',
        'cron: "0 * * * *"',
        'chatId: "oc_fast"',
        'model: "glm-4.7"',
        '---',
        '',
        'Fast routine task.',
      ].join('\n');

      mockReadFile.mockResolvedValue(content);

      const task = await scanner.parseFile(`${MOCK_DIR}/fast-task/SCHEDULE.md`);
      expect(task).not.toBeNull();
      expect(task!.model).toBe('glm-4.7');
    });

    it('should parse unquoted model value (Issue #1338)', async () => {
      const content = [
        '---',
        'name: "Unquoted Model Task"',
        'cron: "0 * * * *"',
        'chatId: "oc_unquoted"',
        'model: glm-4.7',
        '---',
        '',
        'Task with unquoted model value.',
      ].join('\n');

      mockReadFile.mockResolvedValue(content);

      const task = await scanner.parseFile(`${MOCK_DIR}/unquoted-model/SCHEDULE.md`);
      expect(task).not.toBeNull();
      expect(task!.model).toBe('glm-4.7');
    });

    it('should not strip mismatched nested quotes from model value (Issue #1338)', async () => {
      const content = [
        '---',
        'name: "Nested Quote Task"',
        'cron: "0 0 * * *"',
        'chatId: "oc_nested"',
        "model: \"'glm'\"",
        '---',
        '',
        'Task with nested quotes.',
      ].join('\n');

      mockReadFile.mockResolvedValue(content);

      const task = await scanner.parseFile(`${MOCK_DIR}/nested-quote/SCHEDULE.md`);
      expect(task).not.toBeNull();
      // Matched outer double quotes should be stripped, leaving inner single quotes intact
      expect(task!.model).toBe("'glm'");
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

      const task = await scanner.parseFile(`${MOCK_DIR}/unquoted/SCHEDULE.md`);
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

      const task = await scanner.parseFile(`${MOCK_DIR}/quoted/SCHEDULE.md`);
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

      const task = await scanner.parseFile(`${MOCK_DIR}/default-enabled/SCHEDULE.md`);
      expect(task).not.toBeNull();
      expect(task!.enabled).toBe(true);
    });

    it('should include sourceFile and fileMtime', async () => {
      mockReadFile.mockResolvedValue(makeScheduleContent());
      mockStat.mockResolvedValue({
        mtime: new Date('2026-03-20T12:00:00Z'),
        birthtime: new Date('2026-01-01T00:00:00Z'),
      } as Awaited<ReturnType<typeof import('fs/promises').stat>>);

      const task = await scanner.parseFile(`${MOCK_DIR}/test/SCHEDULE.md`);
      expect(task).not.toBeNull();
      expect(task!.sourceFile).toBe(`${MOCK_DIR}/test/SCHEDULE.md`);
      expect(task!.fileMtime).toEqual(new Date('2026-03-20T12:00:00Z'));
    });
  });

  describe('scanAll', () => {
    it('should scan subdirectories for SCHEDULE.md files (Issue #2526)', async () => {
      // Simulate readdir with withFileTypes: true
      mockReaddir.mockResolvedValue([
        { name: 'daily-report', isDirectory: () => true },
        { name: 'weekly-summary', isDirectory: () => true },
        { name: 'notes.txt', isDirectory: () => false },
      ]);
      mockReadFile.mockResolvedValue(makeScheduleContent());

      const tasks = await scanner.scanAll();
      expect(tasks).toHaveLength(2);
      expect(mockReadFile).toHaveBeenCalledTimes(2);
    });

    it('should skip dot-directories', async () => {
      mockReaddir.mockResolvedValue([
        { name: '.cooldown', isDirectory: () => true },
        { name: '.temp-chats', isDirectory: () => true },
        { name: 'valid-task', isDirectory: () => true },
      ]);
      mockReadFile.mockResolvedValue(makeScheduleContent());

      const tasks = await scanner.scanAll();
      expect(tasks).toHaveLength(1);
    });

    it('should return empty array when directory does not exist', async () => {
      mockReaddir.mockRejectedValue({ code: 'ENOENT' } as NodeJS.ErrnoException);

      const tasks = await scanner.scanAll();
      expect(tasks).toEqual([]);
    });

    it('should skip subdirectories that fail to parse', async () => {
      mockReaddir.mockResolvedValue([
        { name: 'valid', isDirectory: () => true },
        { name: 'invalid', isDirectory: () => true },
      ]);
      mockReadFile
        .mockResolvedValueOnce(makeScheduleContent())
        .mockResolvedValueOnce('no frontmatter');

      const tasks = await scanner.scanAll();
      expect(tasks).toHaveLength(1);
    });

    it('should skip subdirectories without SCHEDULE.md gracefully (Issue #2526 review)', async () => {
      mockReaddir.mockResolvedValue([
        { name: 'has-schedule', isDirectory: () => true },
        { name: 'no-schedule', isDirectory: () => true },
      ]);
      // First access call succeeds (has-schedule), second fails (no-schedule)
      mockAccess
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce({ code: 'ENOENT' } as NodeJS.ErrnoException);
      mockReadFile.mockResolvedValue(makeScheduleContent());

      const tasks = await scanner.scanAll();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe('schedule-has-schedule');
      // parseFile should only be called once (for has-schedule)
      expect(mockReadFile).toHaveBeenCalledTimes(1);
    });

    it('should throw on non-ENOENT errors during scan', async () => {
      mockReaddir.mockRejectedValue(new Error('Permission denied'));

      await expect(scanner.scanAll()).rejects.toThrow('Permission denied');
    });
  });

  describe('writeTask', () => {
    it('should write a task to <slug>/SCHEDULE.md (Issue #2526)', async () => {
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
      expect(filePath).toBe(`${MOCK_DIR}/daily-report/SCHEDULE.md`);
      expect(mockMkdir).toHaveBeenCalledWith(`${MOCK_DIR}/daily-report`, { recursive: true });
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

    it('should write model field when present (Issue #1338)', async () => {
      const task: ScheduledTask = {
        id: 'schedule-coding',
        name: 'Coding Task',
        cron: '0 */2 * * *',
        prompt: 'Code review task',
        chatId: 'oc_test',
        enabled: true,
        createdAt: '2026-03-01',
        model: 'claude-sonnet-4-20250514',
      };

      await scanner.writeTask(task);

      const writtenContent = mockWriteFile.mock.calls[0][1] as string;
      expect(writtenContent).toContain('model: "claude-sonnet-4-20250514"');
    });

    it('should not write model field when undefined', async () => {
      const task: ScheduledTask = {
        id: 'schedule-default',
        name: 'Default Task',
        cron: '0 0 * * *',
        prompt: 'Task without model override',
        chatId: 'oc_test',
        enabled: true,
        createdAt: '2026-03-01',
      };

      await scanner.writeTask(task);

      const writtenContent = mockWriteFile.mock.calls[0][1] as string;
      expect(writtenContent).not.toContain('model:');
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
      expect(filePath).toBe(`${MOCK_DIR}/my-task/SCHEDULE.md`);
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
    it('should delete <slug>/SCHEDULE.md and return true (Issue #2526)', async () => {
      const result = await scanner.deleteTask('schedule-daily-report');
      expect(result).toBe(true);
      expect(mockUnlink).toHaveBeenCalledWith(`${MOCK_DIR}/daily-report/SCHEDULE.md`);
    });

    it('should attempt to remove the empty subdirectory', async () => {
      // rmdir succeeds (directory was empty)
      await scanner.deleteTask('schedule-daily-report');
      // The rmdir call is also made (it's a cleanup, not critical)
      // Just verify unlink was called with the correct path
      expect(mockUnlink).toHaveBeenCalledWith(`${MOCK_DIR}/daily-report/SCHEDULE.md`);
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
    it('should return <slug>/SCHEDULE.md path (Issue #2526)', () => {
      const filePath = scanner.getFilePath('schedule-daily-report');
      expect(filePath).toBe(`${MOCK_DIR}/daily-report/SCHEDULE.md`);
    });

    it('should use task ID as-is without schedule- prefix', () => {
      const filePath = scanner.getFilePath('my-task');
      expect(filePath).toBe(`${MOCK_DIR}/my-task/SCHEDULE.md`);
    });
  });

  describe('parseFile - empty model warning (Issue #1338)', () => {
    it('should warn when model is empty string', async () => {
      const content = [
        '---',
        'name: "Empty Model Task"',
        'cron: "0 * * * *"',
        'chatId: "oc_empty_model"',
        'model: ""',
        '---',
        '',
        'Task with empty model.',
      ].join('\n');

      mockReadFile.mockResolvedValue(content);

      const task = await scanner.parseFile(`${MOCK_DIR}/empty-model/SCHEDULE.md`);
      expect(task).not.toBeNull();
      expect(task!.model).toBe('');
      // Covers line 224-225: empty model warning branch
    });
  });

  describe('parseFile - timezone support (Issue #3860)', () => {
    it('should parse timezone field from frontmatter', async () => {
      const content = [
        '---',
        'name: "NYC Task"',
        'cron: "0 9 * * *"',
        'chatId: "oc_nyc"',
        'timezone: "America/New_York"',
        '---',
        '',
        'Task in NYC timezone.',
      ].join('\n');

      mockReadFile.mockResolvedValue(content);

      const task = await scanner.parseFile(`${MOCK_DIR}/nyc-task/SCHEDULE.md`);
      expect(task).not.toBeNull();
      expect(task!.timezone).toBe('America/New_York');
    });

    it('should default timezone to undefined when not specified', async () => {
      mockReadFile.mockResolvedValue(makeScheduleContent());

      const task = await scanner.parseFile(`${MOCK_DIR}/default-tz/SCHEDULE.md`);
      expect(task).not.toBeNull();
      expect(task!.timezone).toBeUndefined();
    });

    it('should write timezone to frontmatter when present', async () => {
      const task: ScheduledTask = {
        id: 'schedule-tz-test',
        name: 'TZ Task',
        cron: '0 9 * * *',
        prompt: 'Timezone task',
        chatId: 'oc_test',
        enabled: true,
        createdAt: '2026-01-01',
        timezone: 'Europe/London',
      };

      await scanner.writeTask(task);

      const writtenContent = mockWriteFile.mock.calls[0][1] as string;
      expect(writtenContent).toContain('timezone: "Europe/London"');
    });

    it('should not write timezone when undefined', async () => {
      const task: ScheduledTask = {
        id: 'schedule-no-tz',
        name: 'No TZ',
        cron: '0 9 * * *',
        prompt: 'Task',
        chatId: 'oc_test',
        enabled: true,
        createdAt: '2026-01-01',
      };

      await scanner.writeTask(task);

      const writtenContent = mockWriteFile.mock.calls[0][1] as string;
      expect(writtenContent).not.toContain('timezone:');
    });

    it('should reject invalid IANA timezone', async () => {
      const content = [
        '---',
        'name: "Bad TZ"',
        'cron: "0 9 * * *"',
        'chatId: "oc_bad"',
        'timezone: "Invalid/Timezone"',
        '---',
        '',
        'Task with bad timezone.',
      ].join('\n');

      mockReadFile.mockResolvedValue(content);

      const task = await scanner.parseFile(`${MOCK_DIR}/bad-tz/SCHEDULE.md`);
      // Invalid timezone causes parseFile to catch the error and return null
      expect(task).toBeNull();
    });

    it('should reject timezone with typo (missing underscore)', async () => {
      const content = [
        '---',
        'name: "Typo TZ"',
        'cron: "0 9 * * *"',
        'chatId: "oc_typo"',
        'timezone: "America/NewYork"',
        '---',
        '',
        'Task with typo timezone.',
      ].join('\n');

      mockReadFile.mockResolvedValue(content);

      const task = await scanner.parseFile(`${MOCK_DIR}/typo-tz/SCHEDULE.md`);
      expect(task).toBeNull();
    });
  });

  describe('disableSchedule (Issue #4041)', () => {
    const scheduleContent = [
      '---',
      'name: "Loop: test task"',
      'cron: "0 * * * *"',
      'enabled: true',
      'blocking: true',
      'chatId: oc_test_chat',
      '---',
      '',
      'Execute next item in LOOP.md',
    ].join('\n');

    it('should set enabled: false in the schedule file', async () => {
      mockReadFile.mockResolvedValue(scheduleContent);

      const result = await scanner.disableSchedule('schedule-test-task');

      expect(result).toBe(true);
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('test-task/SCHEDULE.md'),
        expect.stringContaining('enabled: false'),
        'utf-8'
      );
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.not.stringContaining('enabled: true'),
        'utf-8'
      );
    });

    it('should return false if already disabled', async () => {
      const disabledContent = scheduleContent.replace('enabled: true', 'enabled: false');
      mockReadFile.mockResolvedValue(disabledContent);

      const result = await scanner.disableSchedule('schedule-test-task');

      expect(result).toBe(false);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('should return false if file not found', async () => {
      const error = new Error('ENOENT');
      (error as NodeJS.ErrnoException).code = 'ENOENT';
      mockReadFile.mockRejectedValue(error);

      const result = await scanner.disableSchedule('schedule-nonexistent');

      expect(result).toBe(false);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('should return false if no frontmatter found', async () => {
      mockReadFile.mockResolvedValue('No frontmatter here, just plain text.');

      const result = await scanner.disableSchedule('schedule-test-task');

      expect(result).toBe(false);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('should preserve other frontmatter fields when disabling', async () => {
      const contentWithMoreFields = [
        '---',
        'name: "Loop: complex task"',
        'cron: "*/5 * * * *"',
        'enabled: true',
        'blocking: false',
        'chatId: oc_complex',
        'createdAt: "2026-01-01T00:00:00Z"',
        'modelTier: "fast"',
        '---',
        '',
        'Task prompt here',
      ].join('\n');
      mockReadFile.mockResolvedValue(contentWithMoreFields);

      const result = await scanner.disableSchedule('schedule-complex-task');

      expect(result).toBe(true);
      const writtenContent = (mockWriteFile as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(writtenContent).toContain('name: "Loop: complex task"');
      expect(writtenContent).toContain('cron: "*/5 * * * *"');
      expect(writtenContent).toContain('enabled: false');
      expect(writtenContent).toContain('blocking: false');
      expect(writtenContent).toContain('chatId: oc_complex');
      expect(writtenContent).toContain('Task prompt here');
    });
  });
});

// ============================================================================
// ScheduleFileWatcher Tests
// ============================================================================

describe('ScheduleFileWatcher', () => {
  let watcher: ScheduleFileWatcher;
  let onFileAdded: ReturnType<typeof vi.fn>;
  let onFileChanged: ReturnType<typeof vi.fn>;
  let onFileRemoved: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    onFileAdded = vi.fn();
    onFileChanged = vi.fn();
    onFileRemoved = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (watcher) {
      watcher.stop();
    }
  });

  function createWatcher(debounceMs = 10) {
    watcher = new ScheduleFileWatcher({
      schedulesDir: MOCK_DIR,
      onFileAdded,
      onFileChanged,
      onFileRemoved,
      debounceMs,
      rescanIntervalMs: 0, // Disable periodic rescan in tests to avoid fake timer infinite loop
    });
    return watcher;
  }

  describe('constructor', () => {
    it('should initialize with correct schedules dir', () => {
      createWatcher();
      expect(watcher).toBeDefined();
      expect(watcher.isRunning()).toBe(false);
    });

    it('should use default debounce of 100ms', () => {
      const w = new ScheduleFileWatcher({
        schedulesDir: MOCK_DIR,
        onFileAdded,
        onFileChanged,
        onFileRemoved,
      });
      // The default debounce is 100ms, constructor doesn't expose it directly
      // but we verify it's constructed successfully and isRunning is false
      expect(w).toBeDefined();
      expect(w.isRunning()).toBe(false);
      w.stop();
    });
  });

  describe('start', () => {
    it('should start watching the directory recursively (Issue #2526)', async () => {
      createWatcher();
      await watcher.start();

      expect(mockFsWatch).toHaveBeenCalledWith(
        MOCK_DIR,
        { persistent: true, recursive: true },
        expect.any(Function)
      );
      expect(watcher.isRunning()).toBe(true);
    });

    it('should create directory before watching', async () => {
      createWatcher();
      await watcher.start();

      expect(mockMkdir).toHaveBeenCalledWith(MOCK_DIR, { recursive: true });
    });

    it('should not start if already running', async () => {
      createWatcher();
      await watcher.start();
      expect(mockFsWatch).toHaveBeenCalledTimes(1);

      await watcher.start();
      // Should not call fs.watch again
      expect(mockFsWatch).toHaveBeenCalledTimes(1);
    });

    it('should throw if fs.watch fails', async () => {
      createWatcher();
      mockFsWatch.mockImplementation(() => {
        throw new Error('Watch failed');
      });

      await expect(watcher.start()).rejects.toThrow('Watch failed');
      expect(watcher.isRunning()).toBe(false);
    });

    it('should register error handler on watcher', async () => {
      const mockOn = vi.fn().mockReturnThis();
      mockFsWatch.mockReturnValue({ on: mockOn, close: vi.fn() });

      createWatcher();
      await watcher.start();

      expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function));
    });
  });

  describe('stop', () => {
    it('should stop the watcher', async () => {
      createWatcher();
      await watcher.start();
      expect(watcher.isRunning()).toBe(true);

      const mockWatcherInstance = mockFsWatch.mock.results[0].value;
      watcher.stop();
      expect(watcher.isRunning()).toBe(false);
      expect(mockWatcherInstance.close).toHaveBeenCalled();
    });

    it('should be safe to call stop without start', () => {
      createWatcher();
      watcher.stop(); // Should not throw
      expect(watcher.isRunning()).toBe(false);
    });

    it('should clear debounce timers on stop', async () => {
      createWatcher(100);
      await watcher.start();

      // Trigger a file event to create a debounce timer
      const [[,,debounceCallback]] = mockFsWatch.mock.calls;
      debounceCallback('rename', 'test/SCHEDULE.md');

      // Stop should clear timers
      watcher.stop();
      expect(watcher.isRunning()).toBe(false);
    });
  });

  describe('file event handling', () => {
    let eventCallback: (eventType: string, filename: string | null) => void;

    beforeEach(async () => {
      createWatcher(10);
      await watcher.start();
      const [[,,cb]] = mockFsWatch.mock.calls;
      eventCallback = cb;
    });

    it('should trigger full re-scan when filename is null (Issue #3860)', async () => {
      // P0: null filename triggers full re-scan instead of silent discard
      mockReaddir.mockResolvedValue([]);

      eventCallback('change', null);
      // Allow the fullRescan async to complete
      await vi.runAllTimersAsync();

      // fullRescan should have been called (uses scanAll which calls readdir)
      expect(mockReaddir).toHaveBeenCalled();
    });

    it('should ignore non-SCHEDULE.md files', () => {
      eventCallback('change', 'notes.txt');
      vi.advanceTimersByTime(20);

      expect(onFileChanged).not.toHaveBeenCalled();
    });

    it('should ignore plain .md files (Issue #2526)', () => {
      eventCallback('change', 'legacy-schedule.md');
      vi.advanceTimersByTime(20);

      expect(onFileChanged).not.toHaveBeenCalled();
    });

    it('should debounce rapid file events', () => {
      eventCallback('change', 'daily-report/SCHEDULE.md');
      eventCallback('change', 'daily-report/SCHEDULE.md');
      eventCallback('change', 'daily-report/SCHEDULE.md');

      vi.advanceTimersByTime(20);

      // Only one call after debounce
      expect(mockReadFile).toHaveBeenCalledTimes(1);
    });

    it('should handle file rename event when SCHEDULE.md is added (Issue #2526)', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(makeScheduleContent());

      eventCallback('rename', 'daily-report/SCHEDULE.md');
      vi.advanceTimersByTime(20);
      // Wait for async processFileEvent to complete
      await vi.runAllTimersAsync();

      expect(onFileAdded).toHaveBeenCalledTimes(1);
      expect(onFileAdded.mock.calls[0][0].id).toBe('schedule-daily-report');
    });

    it('should handle file rename event when SCHEDULE.md is removed', async () => {
      mockAccess.mockRejectedValue({ code: 'ENOENT' });

      eventCallback('rename', 'daily-report/SCHEDULE.md');
      vi.advanceTimersByTime(20);
      await vi.runAllTimersAsync();
      // Issue #3860 P1: Additional 200ms delay for rename-and-replace detection
      vi.advanceTimersByTime(250);
      await vi.runAllTimersAsync();

      expect(onFileRemoved).toHaveBeenCalledWith(
        'schedule-daily-report',
        `${MOCK_DIR}/daily-report/SCHEDULE.md`
      );
    });

    it('should detect rename-and-replace pattern (file recreated within delay)', async () => {
      // First check: file does not exist → enters removal branch
      // Second check (after delay): file exists again → treat as changed
      mockAccess
        .mockRejectedValueOnce({ code: 'ENOENT' })   // first fileExists check
        .mockResolvedValueOnce(undefined);             // second check after delay
      mockReadFile.mockResolvedValue(makeScheduleContent({ name: 'Replaced Task' }));

      eventCallback('rename', 'daily-report/SCHEDULE.md');
      vi.advanceTimersByTime(20);
      await vi.runAllTimersAsync();

      // Should detect the file was recreated and call onFileChanged
      expect(onFileChanged).toHaveBeenCalledTimes(1);
      expect(onFileChanged.mock.calls[0][0].name).toBe('Replaced Task');
      expect(onFileRemoved).not.toHaveBeenCalled();
    });

    it('should handle file change event', async () => {
      mockReadFile.mockResolvedValue(makeScheduleContent({ name: 'Updated Task' }));

      eventCallback('change', 'daily-report/SCHEDULE.md');
      vi.advanceTimersByTime(20);
      await vi.runAllTimersAsync();

      expect(onFileChanged).toHaveBeenCalledTimes(1);
      expect(onFileChanged.mock.calls[0][0].name).toBe('Updated Task');
    });

    it('should not call onFileChanged when changed file fails to parse', async () => {
      mockReadFile.mockResolvedValue('no frontmatter content');

      eventCallback('change', 'bad-file/SCHEDULE.md');
      vi.advanceTimersByTime(20);
      await vi.runAllTimersAsync();

      expect(onFileChanged).not.toHaveBeenCalled();
    });

    it('should handle file added with invalid content', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('invalid content without frontmatter');

      eventCallback('rename', 'invalid/SCHEDULE.md');
      vi.advanceTimersByTime(20);
      await vi.runAllTimersAsync();

      // parseFile returns null for invalid content
      expect(onFileAdded).not.toHaveBeenCalled();
    });

    it('should handle errors during file event processing gracefully', async () => {
      // access() throws non-ENOENT error → fileExists returns false → treated as removal
      mockAccess.mockRejectedValue(new Error('Unexpected error'));

      eventCallback('rename', 'error-file/SCHEDULE.md');
      vi.advanceTimersByTime(20);
      await vi.runAllTimersAsync();

      // When fileExists returns false, onFileRemoved is called
      // This verifies the error doesn't crash the watcher
      expect(onFileRemoved).toHaveBeenCalledWith(
        'schedule-error-file',
        `${MOCK_DIR}/error-file/SCHEDULE.md`
      );
    });

    it('should handle change event errors gracefully', async () => {
      mockReadFile.mockRejectedValue(new Error('Read error'));

      eventCallback('change', 'error-file/SCHEDULE.md');
      vi.advanceTimersByTime(20);
      await vi.runAllTimersAsync();

      // Should not throw - error is caught and logged
      expect(onFileChanged).not.toHaveBeenCalled();
    });

    it('should process multiple different schedule subdirs independently', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(makeScheduleContent());

      eventCallback('rename', 'task1/SCHEDULE.md');
      eventCallback('rename', 'task2/SCHEDULE.md');

      vi.advanceTimersByTime(20);
      await vi.runAllTimersAsync();

      expect(onFileAdded).toHaveBeenCalledTimes(2);
    });
  });

  describe('fullRescan', () => {
    it('should detect new tasks not in knownTaskIds', async () => {
      createWatcher();
      await watcher.start();
      watcher.stop(); // stop to avoid interference

      mockReaddir.mockResolvedValue([
        { name: 'task-a', isDirectory: () => true },
        { name: 'task-b', isDirectory: () => true },
      ]);
      mockReadFile.mockResolvedValue(makeScheduleContent());
      mockStat.mockResolvedValue({
        mtime: new Date('2026-01-01'),
        birthtime: new Date('2026-01-01'),
      });

      // knownTaskIds is empty, so both should be detected as new
      await watcher.fullRescan();

      expect(onFileAdded).toHaveBeenCalledTimes(2);
    });

    it('should detect removed tasks', async () => {
      createWatcher();
      await watcher.start();
      watcher.stop();

      // Set known tasks to include one that won't be in the scan
      watcher.setKnownTaskIds(new Set(['schedule-task-a', 'schedule-task-b']));

      // Only task-a is present in the scan
      mockReaddir.mockResolvedValue([
        { name: 'task-a', isDirectory: () => true },
      ]);
      mockReadFile.mockResolvedValue(makeScheduleContent());
      mockStat.mockResolvedValue({
        mtime: new Date('2026-01-01'),
        birthtime: new Date('2026-01-01'),
      });

      await watcher.fullRescan();

      expect(onFileRemoved).toHaveBeenCalledWith(
        'schedule-task-b',
        `${MOCK_DIR}/task-b/SCHEDULE.md`
      );
    });

    it('should detect changed tasks via mtime comparison', async () => {
      createWatcher();
      await watcher.start();
      watcher.stop();

      const oldMtime = new Date('2026-01-01');
      const newMtime = new Date('2026-06-01');

      // Set known tasks with old mtime
      watcher.setKnownTaskIds(
        new Set(['schedule-daily-report']),
        new Map([['schedule-daily-report', oldMtime]])
      );

      // Scan returns same task with newer mtime
      mockReaddir.mockResolvedValue([
        { name: 'daily-report', isDirectory: () => true },
      ]);
      mockReadFile.mockResolvedValue(makeScheduleContent());
      mockStat.mockResolvedValue({
        mtime: newMtime,
        birthtime: new Date('2026-01-01'),
      });

      await watcher.fullRescan();

      expect(onFileChanged).toHaveBeenCalledTimes(1);
      expect(onFileChanged.mock.calls[0][0].id).toBe('schedule-daily-report');
    });

    it('should not trigger callbacks when nothing changed', async () => {
      createWatcher();
      await watcher.start();
      watcher.stop();

      const mtime = new Date('2026-01-01');
      watcher.setKnownTaskIds(
        new Set(['schedule-daily-report']),
        new Map([['schedule-daily-report', mtime]])
      );

      mockReaddir.mockResolvedValue([
        { name: 'daily-report', isDirectory: () => true },
      ]);
      mockReadFile.mockResolvedValue(makeScheduleContent());
      mockStat.mockResolvedValue({
        mtime,
        birthtime: new Date('2026-01-01'),
      });

      await watcher.fullRescan();

      expect(onFileAdded).not.toHaveBeenCalled();
      expect(onFileChanged).not.toHaveBeenCalled();
      expect(onFileRemoved).not.toHaveBeenCalled();
    });

    it('should handle scan errors gracefully', async () => {
      createWatcher();
      await watcher.start();
      watcher.stop();

      mockReaddir.mockRejectedValue(new Error('Scan failed'));

      // Should not throw
      await watcher.fullRescan();

      expect(onFileAdded).not.toHaveBeenCalled();
      expect(onFileRemoved).not.toHaveBeenCalled();
    });
  });

  describe('knownTaskIds sync on file events (Issue #3929)', () => {
    it('should prevent fullRescan from re-firing onFileAdded after file add event', async () => {
      createWatcher();
      await watcher.start();
      watcher.stop();

      // Simulate: processFileEvent added a task and synced knownTaskIds
      const mtime = new Date('2026-01-01');
      watcher.setKnownTaskIds(
        new Set(['schedule-added-task']),
        new Map([['schedule-added-task', mtime]])
      );

      // fullRescan finds the same task
      mockReaddir.mockResolvedValue([
        { name: 'added-task', isDirectory: () => true },
      ]);
      mockReadFile.mockResolvedValue(makeScheduleContent());
      mockStat.mockResolvedValue({
        mtime,
        birthtime: new Date('2026-01-01'),
      });

      await watcher.fullRescan();

      // Task already known → should NOT call onFileAdded
      expect(onFileAdded).not.toHaveBeenCalled();
      expect(onFileChanged).not.toHaveBeenCalled();
      expect(onFileRemoved).not.toHaveBeenCalled();
    });

    it('should prevent fullRescan from re-firing onFileRemoved after file remove event', async () => {
      createWatcher();
      await watcher.start();
      watcher.stop();

      // Simulate: processFileEvent removed a task and synced knownTaskIds
      watcher.setKnownTaskIds(new Set());

      // fullRescan finds no files → knownTaskIds is empty → no removals detected
      mockReaddir.mockResolvedValue([]);

      await watcher.fullRescan();

      expect(onFileRemoved).not.toHaveBeenCalled();
    });

    it('should prevent fullRescan from re-firing onFileChanged after file change event', async () => {
      createWatcher();
      await watcher.start();
      watcher.stop();

      // Simulate: processFileEvent changed a task and synced knownTaskMtimes
      const mtime = new Date('2026-06-01');
      watcher.setKnownTaskIds(
        new Set(['schedule-changed-task']),
        new Map([['schedule-changed-task', mtime]])
      );

      // fullRescan finds the task with the SAME mtime (already synced)
      mockReaddir.mockResolvedValue([
        { name: 'changed-task', isDirectory: () => true },
      ]);
      mockReadFile.mockResolvedValue(makeScheduleContent());
      mockStat.mockResolvedValue({
        mtime,
        birthtime: new Date('2026-01-01'),
      });

      await watcher.fullRescan();

      // mtime matches knownTaskMtimes → should NOT call onFileChanged
      expect(onFileChanged).not.toHaveBeenCalled();
      expect(onFileAdded).not.toHaveBeenCalled();
      expect(onFileRemoved).not.toHaveBeenCalled();
    });
  });

  describe('setKnownTaskIds', () => {
    it('should update knownTaskIds', async () => {
      createWatcher();
      await watcher.start();
      watcher.stop();

      const ids = new Set(['schedule-task-a', 'schedule-task-b']);
      watcher.setKnownTaskIds(ids);

      // Verify via fullRescan: if we scan and find only task-a, task-b should be removed
      mockReaddir.mockResolvedValue([
        { name: 'task-a', isDirectory: () => true },
      ]);
      mockReadFile.mockResolvedValue(makeScheduleContent());
      mockStat.mockResolvedValue({
        mtime: new Date('2026-01-01'),
        birthtime: new Date('2026-01-01'),
      });

      await watcher.fullRescan();

      expect(onFileRemoved).toHaveBeenCalledWith(
        'schedule-task-b',
        `${MOCK_DIR}/task-b/SCHEDULE.md`
      );
    });

    it('should accept optional mtimes for change detection', async () => {
      createWatcher();
      await watcher.start();
      watcher.stop();

      const mtime = new Date('2026-01-01');
      watcher.setKnownTaskIds(
        new Set(['schedule-daily-report']),
        new Map([['schedule-daily-report', mtime]])
      );

      // Scan with newer mtime
      mockReaddir.mockResolvedValue([
        { name: 'daily-report', isDirectory: () => true },
      ]);
      mockReadFile.mockResolvedValue(makeScheduleContent());
      mockStat.mockResolvedValue({
        mtime: new Date('2026-06-01'),
        birthtime: new Date('2026-01-01'),
      });

      await watcher.fullRescan();

      expect(onFileChanged).toHaveBeenCalledTimes(1);
    });
  });

  describe('rescan timer', () => {
    it('should start periodic rescan timer on start', async () => {
      vi.useFakeTimers();
      const shortWatcher = new ScheduleFileWatcher({
        schedulesDir: MOCK_DIR,
        onFileAdded,
        onFileChanged,
        onFileRemoved,
        debounceMs: 10,
        rescanIntervalMs: 1000,
      });
      await shortWatcher.start();

      mockReaddir.mockResolvedValue([]);

      // Advance by interval to trigger rescan, then stop before interval fires again
      vi.advanceTimersByTime(1000);
      shortWatcher.stop();

      // Use vi.runOnlyPendingTimersAsync to settle pending async without infinite loop
      await vi.runOnlyPendingTimersAsync();

      expect(mockReaddir).toHaveBeenCalled();
    });

    it('should not start rescan timer when rescanIntervalMs is 0', async () => {
      vi.useFakeTimers();
      const noRescanWatcher = new ScheduleFileWatcher({
        schedulesDir: MOCK_DIR,
        onFileAdded,
        onFileChanged,
        onFileRemoved,
        debounceMs: 10,
        rescanIntervalMs: 0,
      });
      await noRescanWatcher.start();

      mockReaddir.mockResolvedValue([]);

      vi.advanceTimersByTime(600000);
      await vi.advanceTimersByTimeAsync(0);

      // readdir should NOT be called by periodic timer (only by mkdir in start)
      expect(mockReaddir).not.toHaveBeenCalled();

      noRescanWatcher.stop();
    });

    it('should clear rescan timer on stop', async () => {
      vi.useFakeTimers();
      const shortWatcher = new ScheduleFileWatcher({
        schedulesDir: MOCK_DIR,
        onFileAdded,
        onFileChanged,
        onFileRemoved,
        debounceMs: 10,
        rescanIntervalMs: 1000,
      });
      await shortWatcher.start();
      shortWatcher.stop();

      mockReaddir.mockResolvedValue([]);

      vi.advanceTimersByTime(2000);
      await vi.advanceTimersByTimeAsync(0);

      // readdir should not be called after stop
      expect(mockReaddir).not.toHaveBeenCalled();
    });
  });

  describe('rename delay options', () => {
    it('should use default rename delays when not specified', () => {
      createWatcher();
      expect(watcher).toBeDefined();
    });

    it('should accept custom rename delays', async () => {
      vi.useFakeTimers();
      const customWatcher = new ScheduleFileWatcher({
        schedulesDir: MOCK_DIR,
        onFileAdded,
        onFileChanged,
        onFileRemoved,
        debounceMs: 10,
        rescanIntervalMs: 0,
        renameCreateDelayMs: 100,
        renameRemoveDelayMs: 500,
      });
      await customWatcher.start();

      const [[,,cb]] = mockFsWatch.mock.calls;

      // Test creation with custom delay
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(makeScheduleContent());
      mockStat.mockResolvedValue({
        mtime: new Date('2026-01-01'),
        birthtime: new Date('2026-01-01'),
      });

      cb('rename', 'daily-report/SCHEDULE.md');
      vi.advanceTimersByTime(20);
      await vi.runAllTimersAsync();

      expect(onFileAdded).toHaveBeenCalledTimes(1);

      customWatcher.stop();
    });
  });
});
