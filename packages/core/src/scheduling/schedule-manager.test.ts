/**
 * Tests for ScheduleManager (packages/core/src/scheduling/schedule-manager.ts)
 *
 * Issue #1617 Phase 2: Tests for scheduled task query operations.
 * Covers task retrieval, filtering by chatId/enabled status, and no-cache behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ScheduleManager } from './schedule-manager.js';
import type { ScheduledTask } from './scheduled-task.js';

// ============================================================================
// Helpers
// ============================================================================

/** Create a valid schedule markdown content. */
function makeScheduleContent(overrides: Partial<ScheduledTask> = {}): string {
  const task: Required<ScheduledTask> = {
    id: 'schedule-test-task',
    name: 'Test Task',
    cron: '0 9 * * *',
    prompt: 'Do something useful',
    chatId: 'oc_test_chat',
    createdBy: 'ou_test_user',
    enabled: true,
    blocking: true,
    cooldownPeriod: 300000,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastExecutedAt: '2026-01-02T09:00:00.000Z',
    model: 'claude-sonnet-4-20250514',
    ...overrides,
  };

  return [
    '---',
    `name: "${task.name}"`,
    `cron: "${task.cron}"`,
    `enabled: ${task.enabled}`,
    `blocking: ${task.blocking}`,
    `chatId: ${task.chatId}`,
    `createdBy: ${task.createdBy}`,
    `cooldownPeriod: ${task.cooldownPeriod}`,
    `createdAt: "${task.createdAt}"`,
    `lastExecutedAt: "${task.lastExecutedAt}"`,
    `model: "${task.model}"`,
    '---',
    '',
    task.prompt,
  ].join('\n');
}

/** Create a minimal valid schedule markdown. */
function makeMinimalSchedule(name: string, cron: string, chatId: string, enabled = true): string {
  return [
    '---',
    `name: "${name}"`,
    `cron: "${cron}"`,
    `enabled: ${enabled}`,
    `chatId: ${chatId}`,
    '---',
    '',
    'Task prompt content',
  ].join('\n');
}

/** Write a schedule file to the schedules directory. */
async function writeScheduleFile(dir: string, fileName: string, content: string): Promise<void> {
  await fsPromises.writeFile(path.join(dir, fileName), content, 'utf-8');
}

// ============================================================================
// Tests
// ============================================================================

describe('ScheduleManager', () => {
  let tmpDir: string;
  let schedulesDir: string;
  let manager: ScheduleManager;

  beforeEach(async () => {
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'schedule-manager-test-'));
    schedulesDir = path.join(tmpDir, 'schedules');
    await fsPromises.mkdir(schedulesDir, { recursive: true });
    manager = new ScheduleManager({ schedulesDir });
  });

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------
  describe('constructor', () => {
    it('should create a manager with a schedules directory', () => {
      expect(manager).toBeDefined();
    });

    it('should expose the file scanner', () => {
      const scanner = manager.getFileScanner();
      expect(scanner).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // get
  // -------------------------------------------------------------------------
  describe('get', () => {
    it('should return undefined for non-existent task', async () => {
      const task = await manager.get('schedule-nonexistent');
      expect(task).toBeUndefined();
    });

    it('should retrieve a task by its ID (derived from filename)', async () => {
      await writeScheduleFile(schedulesDir, 'daily-report.md', makeMinimalSchedule('Daily Report', '0 9 * * *', 'oc_chat1'));

      const task = await manager.get('schedule-daily-report');
      expect(task).toBeDefined();
      expect(task!.name).toBe('Daily Report');
      expect(task!.cron).toBe('0 9 * * *');
      expect(task!.chatId).toBe('oc_chat1');
      expect(task!.enabled).toBe(true);
    });

    it('should parse all frontmatter fields correctly', async () => {
      await writeScheduleFile(schedulesDir, 'full-task.md', makeScheduleContent({
        name: 'Full Task',
        cron: '*/30 * * * *',
        chatId: 'oc_chat_full',
        createdBy: 'ou_user123',
        cooldownPeriod: 600000,
        model: 'claude-opus-4-20250514',
      }));

      const task = await manager.get('schedule-full-task');
      expect(task).toBeDefined();
      expect(task!.name).toBe('Full Task');
      expect(task!.cron).toBe('*/30 * * * *');
      expect(task!.chatId).toBe('oc_chat_full');
      expect(task!.createdBy).toBe('ou_user123');
      expect(task!.cooldownPeriod).toBe(600000);
      expect(task!.model).toBe('claude-opus-4-20250514');
    });
  });

  // -------------------------------------------------------------------------
  // listByChatId
  // -------------------------------------------------------------------------
  describe('listByChatId', () => {
    it('should return empty array for chat with no tasks', async () => {
      const tasks = await manager.listByChatId('oc_empty');
      expect(tasks).toEqual([]);
    });

    it('should filter tasks by chatId', async () => {
      await writeScheduleFile(schedulesDir, 'task-chat1-a.md', makeMinimalSchedule('Task A', '0 8 * * *', 'oc_chat1'));
      await writeScheduleFile(schedulesDir, 'task-chat1-b.md', makeMinimalSchedule('Task B', '0 9 * * *', 'oc_chat1'));
      await writeScheduleFile(schedulesDir, 'task-chat2-a.md', makeMinimalSchedule('Task C', '0 10 * * *', 'oc_chat2'));

      const chat1Tasks = await manager.listByChatId('oc_chat1');
      expect(chat1Tasks).toHaveLength(2);
      expect(chat1Tasks.every(t => t.chatId === 'oc_chat1')).toBe(true);

      const chat2Tasks = await manager.listByChatId('oc_chat2');
      expect(chat2Tasks).toHaveLength(1);
      expect(chat2Tasks[0].name).toBe('Task C');
    });

    it('should return empty array when schedules directory has no files', async () => {
      const tasks = await manager.listByChatId('oc_any');
      expect(tasks).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // listEnabled
  // -------------------------------------------------------------------------
  describe('listEnabled', () => {
    it('should return only enabled tasks', async () => {
      await writeScheduleFile(schedulesDir, 'enabled-task.md', makeMinimalSchedule('Enabled', '0 9 * * *', 'oc_chat1', true));
      await writeScheduleFile(schedulesDir, 'disabled-task.md', makeMinimalSchedule('Disabled', '0 10 * * *', 'oc_chat1', false));

      const enabled = await manager.listEnabled();
      expect(enabled).toHaveLength(1);
      expect(enabled[0].name).toBe('Enabled');
      expect(enabled[0].enabled).toBe(true);
    });

    it('should return all tasks when all are enabled', async () => {
      await writeScheduleFile(schedulesDir, 'task-a.md', makeMinimalSchedule('A', '0 8 * * *', 'oc_chat1'));
      await writeScheduleFile(schedulesDir, 'task-b.md', makeMinimalSchedule('B', '0 9 * * *', 'oc_chat2'));
      await writeScheduleFile(schedulesDir, 'task-c.md', makeMinimalSchedule('C', '0 10 * * *', 'oc_chat3'));

      const enabled = await manager.listEnabled();
      expect(enabled).toHaveLength(3);
    });

    it('should return empty array when all tasks are disabled', async () => {
      await writeScheduleFile(schedulesDir, 'disabled-a.md', makeMinimalSchedule('D-A', '0 8 * * *', 'oc_chat1', false));
      await writeScheduleFile(schedulesDir, 'disabled-b.md', makeMinimalSchedule('D-B', '0 9 * * *', 'oc_chat2', false));

      const enabled = await manager.listEnabled();
      expect(enabled).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // listAll
  // -------------------------------------------------------------------------
  describe('listAll', () => {
    it('should return all tasks regardless of enabled status', async () => {
      await writeScheduleFile(schedulesDir, 'enabled.md', makeMinimalSchedule('Enabled', '0 9 * * *', 'oc_chat1', true));
      await writeScheduleFile(schedulesDir, 'disabled.md', makeMinimalSchedule('Disabled', '0 10 * * *', 'oc_chat1', false));

      const all = await manager.listAll();
      expect(all).toHaveLength(2);
    });

    it('should return empty array when no tasks exist', async () => {
      const all = await manager.listAll();
      expect(all).toEqual([]);
    });

    it('should include all task fields', async () => {
      await writeScheduleFile(schedulesDir, 'complete.md', makeScheduleContent());

      const all = await manager.listAll();
      expect(all).toHaveLength(1);
      const task = all[0];
      expect(task.id).toBe('schedule-complete');
      expect(task.name).toBe('Test Task');
      expect(task.prompt).toBe('Do something useful');
    });
  });

  // -------------------------------------------------------------------------
  // No-cache behavior
  // -------------------------------------------------------------------------
  describe('no-cache behavior', () => {
    it('should always read fresh data from file system', async () => {
      // Initial read: one file
      await writeScheduleFile(schedulesDir, 'task-a.md', makeMinimalSchedule('A', '0 9 * * *', 'oc_chat1'));
      const first = await manager.listAll();
      expect(first).toHaveLength(1);

      // Add a new file
      await writeScheduleFile(schedulesDir, 'task-b.md', makeMinimalSchedule('B', '0 10 * * *', 'oc_chat2'));
      const second = await manager.listAll();
      expect(second).toHaveLength(2);
    });

    it('should reflect file deletions', async () => {
      await writeScheduleFile(schedulesDir, 'temp-task.md', makeMinimalSchedule('Temp', '0 9 * * *', 'oc_chat1'));
      expect(await manager.listAll()).toHaveLength(1);

      await fsPromises.unlink(path.join(schedulesDir, 'temp-task.md'));
      expect(await manager.listAll()).toHaveLength(0);
    });

    it('should reflect content changes', async () => {
      await writeScheduleFile(schedulesDir, 'changeable.md', makeMinimalSchedule('Original', '0 9 * * *', 'oc_chat1'));

      const before = await manager.get('schedule-changeable');
      expect(before!.name).toBe('Original');

      // Overwrite with new content
      await writeScheduleFile(schedulesDir, 'changeable.md', makeMinimalSchedule('Updated', '0 10 * * *', 'oc_chat2'));

      const after = await manager.get('schedule-changeable');
      expect(after!.name).toBe('Updated');
      expect(after!.cron).toBe('0 10 * * *');
      expect(after!.chatId).toBe('oc_chat2');
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------
  describe('edge cases', () => {
    it('should ignore non-markdown files in schedules directory', async () => {
      await writeScheduleFile(schedulesDir, 'task.md', makeMinimalSchedule('Valid', '0 9 * * *', 'oc_chat1'));
      await fsPromises.writeFile(path.join(schedulesDir, 'readme.txt'), 'not a schedule', 'utf-8');
      await fsPromises.writeFile(path.join(schedulesDir, '.gitkeep'), '', 'utf-8');

      const all = await manager.listAll();
      expect(all).toHaveLength(1);
      expect(all[0].name).toBe('Valid');
    });

    it('should skip files with missing required frontmatter fields', async () => {
      const invalidContent = [
        '---',
        'name: "Incomplete"',
        // missing cron and chatId
        '---',
        '',
        'Task prompt',
      ].join('\n');

      await writeScheduleFile(schedulesDir, 'invalid.md', invalidContent);
      const all = await manager.listAll();
      expect(all).toHaveLength(0);
    });

    it('should handle tasks with default blocking=true', async () => {
      const content = [
        '---',
        'name: "Default Blocking"',
        'cron: "0 9 * * *"',
        'chatId: oc_chat1',
        '---',
        '',
        'Prompt',
      ].join('\n');

      await writeScheduleFile(schedulesDir, 'default-blocking.md', content);
      const task = await manager.get('schedule-default-blocking');
      expect(task).toBeDefined();
      expect(task!.blocking).toBe(true);
    });
  });
});
