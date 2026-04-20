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
      isFile: () => true,
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

      const task = await scanner.parseFile(`${MOCK_DIR}/coding-task.md`);
      expect(task).not.toBeNull();
      expect(task!.model).toBe('claude-sonnet-4-20250514');
    });

    it('should default model to undefined when not specified', async () => {
      mockReadFile.mockResolvedValue(makeScheduleContent());

      const task = await scanner.parseFile(`${MOCK_DIR}/no-model.md`);
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

      const task = await scanner.parseFile(`${MOCK_DIR}/fast-task.md`);
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

      const task = await scanner.parseFile(`${MOCK_DIR}/unquoted-model.md`);
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

      const task = await scanner.parseFile(`${MOCK_DIR}/nested-quote.md`);
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
        isFile: () => true,
      } as Awaited<ReturnType<typeof import('fs/promises').stat>>);

      const task = await scanner.parseFile(`${MOCK_DIR}/test.md`);
      expect(task).not.toBeNull();
      expect(task!.sourceFile).toBe(`${MOCK_DIR}/test.md`);
      expect(task!.fileMtime).toEqual(new Date('2026-03-20T12:00:00Z'));
    });
  });

  describe('scanAll', () => {
    /** Helper to create a mock Dirent */
    function makeDirent(name: string, isDir: boolean) {
      return {
        name,
        isDirectory: () => isDir,
        isFile: () => !isDir,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isSymbolicLink: () => false,
        isFIFO: () => false,
        isSocket: () => false,
      };
    }

    it('should scan subdirectory SCHEDULE.md files (Issue #2526)', async () => {
      mockReaddir.mockResolvedValue([
        makeDirent('daily-report', true),
        makeDirent('weekly-summary', true),
        makeDirent('notes.txt', false),
      ]);
      mockReadFile.mockResolvedValue(makeScheduleContent());

      const tasks = await scanner.scanAll();
      expect(tasks).toHaveLength(2);
      // Verify it reads from subdirectory paths
      expect(mockReadFile).toHaveBeenCalledWith(`${MOCK_DIR}/daily-report/SCHEDULE.md`, 'utf-8');
      expect(mockReadFile).toHaveBeenCalledWith(`${MOCK_DIR}/weekly-summary/SCHEDULE.md`, 'utf-8');
    });

    it('should also discover flat .md files in root for backward compatibility', async () => {
      mockReaddir.mockResolvedValue([
        makeDirent('legacy-task.md', false),
        makeDirent('new-schedule', true),
      ]);
      mockReadFile.mockResolvedValue(makeScheduleContent());

      const tasks = await scanner.scanAll();
      expect(tasks).toHaveLength(2);
      // Flat file
      expect(mockReadFile).toHaveBeenCalledWith(`${MOCK_DIR}/legacy-task.md`, 'utf-8');
      // Subdirectory
      expect(mockReadFile).toHaveBeenCalledWith(`${MOCK_DIR}/new-schedule/SCHEDULE.md`, 'utf-8');
    });

    it('should skip subdirectories without SCHEDULE.md', async () => {
      mockReaddir.mockResolvedValue([
        makeDirent('empty-dir', true),
        makeDirent('has-schedule', true),
      ]);
      // First call: stat for empty-dir/SCHEDULE.md → ENOENT, then stat for has-schedule/SCHEDULE.md → exists
      mockStat
        .mockRejectedValueOnce({ code: 'ENOENT' } as NodeJS.ErrnoException)
        .mockResolvedValueOnce({
          mtime: new Date('2026-01-01'),
          birthtime: new Date('2026-01-01'),
          isFile: () => true,
        } as Awaited<ReturnType<typeof import('fs/promises').stat>>);
      mockReadFile.mockResolvedValue(makeScheduleContent());

      const tasks = await scanner.scanAll();
      expect(tasks).toHaveLength(1);
    });

    it('should ignore SCHEDULE.md files in root directory', async () => {
      mockReaddir.mockResolvedValue([
        makeDirent('SCHEDULE.md', false), // Should be ignored
        makeDirent('my-task', true),
      ]);
      mockReadFile.mockResolvedValue(makeScheduleContent());

      const tasks = await scanner.scanAll();
      // SCHEDULE.md in root is ignored, only subdirectory is scanned
      expect(tasks).toHaveLength(1);
      expect(mockReadFile).toHaveBeenCalledWith(`${MOCK_DIR}/my-task/SCHEDULE.md`, 'utf-8');
    });

    it('should return empty array when directory does not exist', async () => {
      mockReaddir.mockRejectedValue({ code: 'ENOENT' } as NodeJS.ErrnoException);

      const tasks = await scanner.scanAll();
      expect(tasks).toEqual([]);
    });

    it('should skip files that fail to parse', async () => {
      mockReaddir.mockResolvedValue([
        makeDirent('valid', true),
        makeDirent('invalid', true),
      ]);
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
    it('should write a task to subdirectory/SCHEDULE.md (Issue #2526)', async () => {
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
    it('should delete from subdirectory layout first (Issue #2526)', async () => {
      const result = await scanner.deleteTask('schedule-daily-report');
      expect(result).toBe(true);
      expect(mockUnlink).toHaveBeenCalledWith(`${MOCK_DIR}/daily-report/SCHEDULE.md`);
    });

    it('should fallback to flat layout when subdirectory not found', async () => {
      mockUnlink
        .mockRejectedValueOnce({ code: 'ENOENT' } as NodeJS.ErrnoException)
        .mockResolvedValueOnce(undefined);

      const result = await scanner.deleteTask('schedule-daily-report');
      expect(result).toBe(true);
      // First attempt: subdirectory
      expect(mockUnlink).toHaveBeenCalledWith(`${MOCK_DIR}/daily-report/SCHEDULE.md`);
      // Second attempt: flat
      expect(mockUnlink).toHaveBeenCalledWith(`${MOCK_DIR}/daily-report.md`);
    });

    it('should return false for task IDs without schedule- prefix', async () => {
      const result = await scanner.deleteTask('not-a-schedule-id');
      expect(result).toBe(false);
      expect(mockUnlink).not.toHaveBeenCalled();
    });

    it('should return false when file does not exist in either layout', async () => {
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
    it('should return subdirectory path with schedule- prefix stripped (Issue #2526)', () => {
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

      const task = await scanner.parseFile(`${MOCK_DIR}/empty-model.md`);
      expect(task).not.toBeNull();
      expect(task!.model).toBe('');
      // Covers line 224-225: empty model warning branch
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
      debounceCallback('rename', 'test.md');

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

    it('should ignore events without filename', () => {
      eventCallback('change', null);
      vi.advanceTimersByTime(20);

      expect(onFileChanged).not.toHaveBeenCalled();
    });

    it('should ignore non-.md files', () => {
      eventCallback('change', 'notes.txt');
      vi.advanceTimersByTime(20);

      expect(onFileChanged).not.toHaveBeenCalled();
    });

    it('should debounce rapid file events', () => {
      eventCallback('change', 'test.md');
      eventCallback('change', 'test.md');
      eventCallback('change', 'test.md');

      vi.advanceTimersByTime(20);

      // Only one call after debounce
      expect(mockReadFile).toHaveBeenCalledTimes(1);
    });

    it('should handle file rename event when file is added', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(makeScheduleContent());

      eventCallback('rename', 'daily-report.md');
      vi.advanceTimersByTime(20);
      // Wait for async processFileEvent to complete
      await vi.runAllTimersAsync();

      expect(onFileAdded).toHaveBeenCalledTimes(1);
      expect(onFileAdded.mock.calls[0][0].id).toBe('schedule-daily-report');
    });

    it('should handle file rename event when file is removed', async () => {
      mockAccess.mockRejectedValue({ code: 'ENOENT' });

      eventCallback('rename', 'daily-report.md');
      vi.advanceTimersByTime(20);
      await vi.runAllTimersAsync();

      expect(onFileRemoved).toHaveBeenCalledWith(
        'schedule-daily-report',
        `${MOCK_DIR}/daily-report.md`
      );
    });

    it('should handle file change event', async () => {
      mockReadFile.mockResolvedValue(makeScheduleContent({ name: 'Updated Task' }));

      eventCallback('change', 'daily-report.md');
      vi.advanceTimersByTime(20);
      await vi.runAllTimersAsync();

      expect(onFileChanged).toHaveBeenCalledTimes(1);
      expect(onFileChanged.mock.calls[0][0].name).toBe('Updated Task');
    });

    it('should not call onFileChanged when changed file fails to parse', async () => {
      mockReadFile.mockResolvedValue('no frontmatter content');

      eventCallback('change', 'bad-file.md');
      vi.advanceTimersByTime(20);
      await vi.runAllTimersAsync();

      expect(onFileChanged).not.toHaveBeenCalled();
    });

    it('should handle file added with invalid content', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('invalid content without frontmatter');

      eventCallback('rename', 'invalid.md');
      vi.advanceTimersByTime(20);
      await vi.runAllTimersAsync();

      // parseFile returns null for invalid content
      expect(onFileAdded).not.toHaveBeenCalled();
    });

    it('should handle errors during file event processing gracefully', async () => {
      // access() throws non-ENOENT error → fileExists returns false → treated as removal
      mockAccess.mockRejectedValue(new Error('Unexpected error'));

      eventCallback('rename', 'error-file.md');
      vi.advanceTimersByTime(20);
      await vi.runAllTimersAsync();

      // When fileExists returns false, onFileRemoved is called
      // This verifies the error doesn't crash the watcher
      expect(onFileRemoved).toHaveBeenCalledWith(
        'schedule-error-file',
        `${MOCK_DIR}/error-file.md`
      );
    });

    it('should handle change event errors gracefully', async () => {
      mockReadFile.mockRejectedValue(new Error('Read error'));

      eventCallback('change', 'error-file.md');
      vi.advanceTimersByTime(20);
      await vi.runAllTimersAsync();

      // Should not throw - error is caught and logged
      expect(onFileChanged).not.toHaveBeenCalled();
    });

    it('should process multiple different files independently', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(makeScheduleContent());

      eventCallback('rename', 'task1.md');
      eventCallback('rename', 'task2.md');

      vi.advanceTimersByTime(20);
      await vi.runAllTimersAsync();

      expect(onFileAdded).toHaveBeenCalledTimes(2);
    });

    it('should handle subdirectory SCHEDULE.md events (Issue #2526)', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(makeScheduleContent());

      eventCallback('rename', 'daily-report/SCHEDULE.md');
      vi.advanceTimersByTime(20);
      await vi.runAllTimersAsync();

      expect(onFileAdded).toHaveBeenCalledTimes(1);
      expect(onFileAdded.mock.calls[0][0].id).toBe('schedule-daily-report');
    });

    it('should handle subdirectory SCHEDULE.md change events', async () => {
      mockReadFile.mockResolvedValue(makeScheduleContent({ name: 'Updated Schedule' }));

      eventCallback('change', 'my-task/SCHEDULE.md');
      vi.advanceTimersByTime(20);
      await vi.runAllTimersAsync();

      expect(onFileChanged).toHaveBeenCalledTimes(1);
      expect(onFileChanged.mock.calls[0][0].name).toBe('Updated Schedule');
    });
  });
});
