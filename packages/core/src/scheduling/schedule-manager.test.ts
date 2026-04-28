/**
 * Tests for ScheduleManager.
 *
 * Verifies query operations (get, listByChatId, listEnabled, listAll)
 * against file-based schedule storage.
 *
 * Issue #1617: Phase 2 - scheduling module test coverage.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ScheduleManager } from './schedule-manager.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schedule-manager-test-'));
  await fs.mkdir(path.join(tempDir, 'schedules'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

/**
 * Write a schedule as a subdirectory with SCHEDULE.md.
 * The scanner generates task ID as `schedule-${dirName}`.
 */
async function writeScheduleFile(
  dirName: string,
  options: {
    name?: string;
    cron?: string;
    prompt?: string;
    chatId?: string;
    enabled?: boolean;
    createdBy?: string;
    blocking?: boolean;
    cooldownPeriod?: number;
    model?: string;
    lastExecutedAt?: string;
  } = {}
): Promise<void> {
  const {
    name = 'Test Task',
    cron = '0 9 * * *',
    prompt = 'Run tests',
    chatId = 'oc_test',
    enabled = true,
    createdBy,
    blocking,
    cooldownPeriod,
    model,
    lastExecutedAt,
  } = options;

  const content = `---
name: ${name}
cron: "${cron}"
prompt: "${prompt}"
chatId: ${chatId}
enabled: ${enabled}
${createdBy ? `createdBy: "${createdBy}"` : ''}
${blocking !== undefined ? `blocking: ${blocking}` : ''}
${cooldownPeriod !== undefined ? `cooldownPeriod: ${cooldownPeriod}` : ''}
${model ? `model: "${model}"` : ''}
${lastExecutedAt ? `lastExecutedAt: "${lastExecutedAt}"` : ''}
---

# ${name}

${prompt}

Schedule: \`${cron}\`
`;
  const subDir = path.join(tempDir, 'schedules', dirName);
  await fs.mkdir(subDir, { recursive: true });
  await fs.writeFile(path.join(subDir, 'SCHEDULE.md'), content, 'utf-8');
}

/** Derive the task ID from the directory name (matches ScheduleFileScanner behavior) */
function taskId(dirName: string): string {
  return `schedule-${dirName}`;
}

describe('ScheduleManager', () => {
  let manager: ScheduleManager;

  beforeEach(() => {
    manager = new ScheduleManager({ schedulesDir: path.join(tempDir, 'schedules') });
  });

  describe('constructor', () => {
    it('should create ScheduleManager with schedulesDir', () => {
      expect(manager).toBeInstanceOf(ScheduleManager);
    });

    it('should expose file scanner via getFileScanner', () => {
      const scanner = manager.getFileScanner();
      expect(scanner).toBeDefined();
    });
  });

  describe('get', () => {
    it('should return undefined for non-existent task', async () => {
      const result = await manager.get('nonexistent');
      expect(result).toBeUndefined();
    });

    it('should return task by ID when it exists', async () => {
      await writeScheduleFile('daily-report', {
        name: 'Daily Report',
        cron: '0 9 * * *',
        prompt: 'Generate daily report',
        chatId: 'oc_chat1',
        enabled: true,
      });

      const result = await manager.get(taskId('daily-report'));
      expect(result).toBeDefined();
      expect(result!.id).toBe('schedule-daily-report');
      expect(result!.name).toBe('Daily Report');
      expect(result!.cron).toBe('0 9 * * *');
      // Prompt is derived from the body content after frontmatter
      expect(result!.prompt).toContain('Generate daily report');
      expect(result!.chatId).toBe('oc_chat1');
      expect(result!.enabled).toBe(true);
    });

    it('should return task with optional fields', async () => {
      await writeScheduleFile('full-task', {
        name: 'Full Task',
        cron: '0 */2 * * *',
        prompt: 'Check status',
        chatId: 'oc_chat2',
        enabled: true,
        createdBy: 'user-123',
        blocking: true,
        cooldownPeriod: 3600000,
        model: 'claude-sonnet-4-20250514',
        lastExecutedAt: '2026-03-01T09:00:00Z',
      });

      const result = await manager.get(taskId('full-task'));
      expect(result).toBeDefined();
      expect(result!.createdBy).toBe('user-123');
      expect(result!.blocking).toBe(true);
      expect(result!.cooldownPeriod).toBe(3600000);
      expect(result!.model).toBe('claude-sonnet-4-20250514');
      expect(result!.lastExecutedAt).toBe('2026-03-01T09:00:00Z');
    });
  });

  describe('listByChatId', () => {
    it('should return empty array for chat with no tasks', async () => {
      const result = await manager.listByChatId('oc_empty');
      expect(result).toEqual([]);
    });

    it('should return only tasks for the specified chat', async () => {
      await writeScheduleFile('chat1-task1', {
        name: 'Chat1 Task1',
        cron: '0 9 * * *',
        prompt: 'Task for chat 1',
        chatId: 'oc_chat1',
      });
      await writeScheduleFile('chat1-task2', {
        name: 'Chat1 Task2',
        cron: '0 18 * * *',
        prompt: 'Another task for chat 1',
        chatId: 'oc_chat1',
        enabled: false,
      });
      await writeScheduleFile('chat2-task1', {
        name: 'Chat2 Task1',
        cron: '0 12 * * *',
        prompt: 'Task for chat 2',
        chatId: 'oc_chat2',
      });

      const chat1Tasks = await manager.listByChatId('oc_chat1');
      expect(chat1Tasks).toHaveLength(2);
      expect(chat1Tasks.every(t => t.chatId === 'oc_chat1')).toBe(true);

      const chat2Tasks = await manager.listByChatId('oc_chat2');
      expect(chat2Tasks).toHaveLength(1);
      expect(chat2Tasks[0].id).toBe(taskId('chat2-task1'));
    });

    it('should return both enabled and disabled tasks', async () => {
      await writeScheduleFile('enabled', {
        name: 'Enabled',
        cron: '0 9 * * *',
        prompt: 'Run',
        chatId: 'oc_chat',
      });
      await writeScheduleFile('disabled', {
        name: 'Disabled',
        cron: '0 10 * * *',
        prompt: 'Skip',
        chatId: 'oc_chat',
        enabled: false,
      });

      const result = await manager.listByChatId('oc_chat');
      expect(result).toHaveLength(2);
    });
  });

  describe('listEnabled', () => {
    it('should return empty array when no tasks exist', async () => {
      const result = await manager.listEnabled();
      expect(result).toEqual([]);
    });

    it('should return only enabled tasks', async () => {
      await writeScheduleFile('enabled1', {
        name: 'Enabled 1',
        cron: '0 9 * * *',
        prompt: 'Run 1',
        chatId: 'oc_chat',
      });
      await writeScheduleFile('disabled1', {
        name: 'Disabled',
        cron: '0 10 * * *',
        prompt: 'Skip',
        chatId: 'oc_chat',
        enabled: false,
      });
      await writeScheduleFile('enabled2', {
        name: 'Enabled 2',
        cron: '0 18 * * *',
        prompt: 'Run 2',
        chatId: 'oc_other',
      });

      const result = await manager.listEnabled();
      expect(result).toHaveLength(2);
      expect(result.every(t => t.enabled)).toBe(true);
      expect(result.map(t => t.id)).toContain(taskId('enabled1'));
      expect(result.map(t => t.id)).toContain(taskId('enabled2'));
    });
  });

  describe('listAll', () => {
    it('should return empty array when no tasks exist', async () => {
      const result = await manager.listAll();
      expect(result).toEqual([]);
    });

    it('should return all tasks regardless of enabled status', async () => {
      await writeScheduleFile('task-a', {
        name: 'Task A',
        cron: '0 9 * * *',
        prompt: 'Run A',
        chatId: 'oc_chat1',
      });
      await writeScheduleFile('task-b', {
        name: 'Task B',
        cron: '0 10 * * *',
        prompt: 'Run B',
        chatId: 'oc_chat2',
        enabled: false,
      });

      const result = await manager.listAll();
      expect(result).toHaveLength(2);
    });

    it('should always read fresh data from file system (no cache)', async () => {
      // Initially no files
      expect(await manager.listAll()).toHaveLength(0);

      // Add a file
      await writeScheduleFile('new-task', {
        name: 'New Task',
        cron: '0 9 * * *',
        prompt: 'Run new',
        chatId: 'oc_chat',
      });

      // Should see the new file
      const result = await manager.listAll();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(taskId('new-task'));
      expect(result[0].name).toBe('New Task');
    });
  });

  describe('file system edge cases', () => {
    it('should handle empty schedules directory', async () => {
      const result = await manager.listAll();
      expect(result).toEqual([]);
    });

    it('should handle directory with non-markdown files gracefully', async () => {
      await fs.writeFile(
        path.join(tempDir, 'schedules', 'readme.txt'),
        'This is not a schedule file',
        'utf-8'
      );

      const result = await manager.listAll();
      expect(result).toEqual([]);
    });

    it('should handle malformed frontmatter gracefully', async () => {
      const malformedContent = `---
invalid yaml content [[[broken
---

# Bad Schedule
`;
      const badDir = path.join(tempDir, 'schedules', 'bad');
      await fs.mkdir(badDir, { recursive: true });
      await fs.writeFile(
        path.join(badDir, 'SCHEDULE.md'),
        malformedContent,
        'utf-8'
      );

      // Should not throw, just skip the bad file
      const result = await manager.listAll();
      expect(result).toEqual([]);
    });
  });
});
