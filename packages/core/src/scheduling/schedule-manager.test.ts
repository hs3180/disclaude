/**
 * Unit tests for ScheduleManager
 *
 * Tests the schedule query operations including:
 * - Task retrieval by ID
 * - Task listing by chatId
 * - Listing enabled tasks
 * - Listing all tasks
 *
 * Issue #1041: Migrated from worker-node to core.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ScheduleManager } from './schedule-manager.js';

describe('ScheduleManager', () => {
  let tempDir: string;
  let schedulesDir: string;
  let manager: ScheduleManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schedule-mgr-test-'));
    schedulesDir = path.join(tempDir, 'schedules');
    await fs.mkdir(schedulesDir, { recursive: true });
    manager = new ScheduleManager({ schedulesDir });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Helper to create a schedule markdown file with YAML frontmatter.
   * Uses the exact key names expected by ScheduleFileScanner:
   * name, cron, chatId, createdBy, createdAt, lastExecutedAt, model, enabled, blocking, cooldownPeriod
   */
  async function createScheduleFile(fileName: string, overrides: Record<string, unknown> = {}): Promise<string> {
    // Build frontmatter lines with correct key names
    const lines: string[] = [];

    // String fields (quoted) - only include required fields by default
    const stringFields: Record<string, string | undefined> = {
      name: 'Test Task',
      cron: '0 9 * * *',
      chatId: 'oc_test123',
      createdBy: undefined,
      createdAt: undefined,
    };

    // Boolean fields (unquoted true/false)
    const boolFields: Record<string, boolean> = {
      enabled: true,
      blocking: false,
    };

    // Apply overrides to the correct field type
    for (const [key, value] of Object.entries(overrides)) {
      if (key in stringFields) {
        (stringFields as Record<string, unknown>)[key] = value;
      } else if (key in boolFields) {
        (boolFields as Record<string, unknown>)[key] = value;
      } else if (key === 'cooldownPeriod') {
        // Number field
        lines.push(`cooldownPeriod: ${value}`);
      } else if (key === 'lastExecutedAt') {
        lines.push(`lastExecutedAt: "${value}"`);
      } else if (key === 'model') {
        lines.push(`model: "${value}"`);
      }
    }

    // Add string fields (skip undefined)
    for (const [key, value] of Object.entries(stringFields)) {
      if (value !== undefined) {
        lines.push(`${key}: "${value}"`);
      }
    }

    // Add boolean fields
    for (const [key, value] of Object.entries(boolFields)) {
      lines.push(`${key}: ${value}`);
    }

    const prompt = overrides['prompt'] ?? 'Do something';
    const content = `---\n${lines.join('\n')}\n---\n\n${prompt}\n`;
    const filePath = path.join(schedulesDir, fileName);
    await fs.writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  describe('constructor', () => {
    it('should create a ScheduleManager with the given directory', () => {
      expect(manager).toBeDefined();
      expect(manager.getFileScanner()).toBeDefined();
    });
  });

  describe('get', () => {
    it('should return undefined for non-existent task', async () => {
      const task = await manager.get('non-existent-id');
      expect(task).toBeUndefined();
    });

    it('should retrieve a task by its ID (schedule-<filename>)', async () => {
      await createScheduleFile('my-task.md');

      // Task ID is generated as schedule-{filename_without_extension}
      const task = await manager.get('schedule-my-task');
      expect(task).toBeDefined();
      expect(task!.name).toBe('Test Task');
      expect(task!.cron).toBe('0 9 * * *');
      expect(task!.prompt).toBe('Do something');
      expect(task!.chatId).toBe('oc_test123');
      expect(task!.enabled).toBe(true);
    });

    it('should return correct task among multiple tasks', async () => {
      await createScheduleFile('task-a.md', { name: 'Task A', prompt: 'Run A' });
      await createScheduleFile('task-b.md', { name: 'Task B', prompt: 'Run B' });
      await createScheduleFile('task-c.md', { name: 'Task C', prompt: 'Run C' });

      const taskB = await manager.get('schedule-task-b');
      expect(taskB).toBeDefined();
      expect(taskB!.name).toBe('Task B');
    });
  });

  describe('listByChatId', () => {
    it('should return empty array when no tasks exist for chatId', async () => {
      const tasks = await manager.listByChatId('oc_nonexistent');
      expect(tasks).toEqual([]);
    });

    it('should return tasks matching the chatId', async () => {
      await createScheduleFile('task-1.md', { name: 'Task 1', chatId: 'oc_chat1' });
      await createScheduleFile('task-2.md', { name: 'Task 2', chatId: 'oc_chat2' });
      await createScheduleFile('task-3.md', { name: 'Task 3', chatId: 'oc_chat1' });

      const tasks = await manager.listByChatId('oc_chat1');
      expect(tasks).toHaveLength(2);
      expect(tasks.map(t => t.name)).toContain('Task 1');
      expect(tasks.map(t => t.name)).toContain('Task 3');
    });

    it('should return empty array when no tasks exist at all', async () => {
      const tasks = await manager.listByChatId('oc_chat1');
      expect(tasks).toEqual([]);
    });
  });

  describe('listEnabled', () => {
    it('should return only enabled tasks', async () => {
      await createScheduleFile('enabled-1.md', { name: 'Enabled 1', enabled: true });
      await createScheduleFile('disabled-1.md', { name: 'Disabled 1', enabled: false });
      await createScheduleFile('enabled-2.md', { name: 'Enabled 2', enabled: true });

      const tasks = await manager.listEnabled();
      expect(tasks).toHaveLength(2);
      expect(tasks.map(t => t.name)).toContain('Enabled 1');
      expect(tasks.map(t => t.name)).toContain('Enabled 2');
    });

    it('should return empty array when all tasks are disabled', async () => {
      await createScheduleFile('disabled-1.md', { name: 'Disabled 1', enabled: false });
      await createScheduleFile('disabled-2.md', { name: 'Disabled 2', enabled: false });

      const tasks = await manager.listEnabled();
      expect(tasks).toEqual([]);
    });

    it('should return empty array when no tasks exist', async () => {
      const tasks = await manager.listEnabled();
      expect(tasks).toEqual([]);
    });
  });

  describe('listAll', () => {
    it('should return all tasks', async () => {
      await createScheduleFile('task-1.md', { name: 'Task 1' });
      await createScheduleFile('task-2.md', { name: 'Task 2' });
      await createScheduleFile('task-3.md', { name: 'Task 3' });

      const tasks = await manager.listAll();
      expect(tasks).toHaveLength(3);
    });

    it('should return empty array when no tasks exist', async () => {
      const tasks = await manager.listAll();
      expect(tasks).toEqual([]);
    });

    it('should include both enabled and disabled tasks', async () => {
      await createScheduleFile('enabled.md', { name: 'Enabled', enabled: true });
      await createScheduleFile('disabled.md', { name: 'Disabled', enabled: false });

      const tasks = await manager.listAll();
      expect(tasks).toHaveLength(2);
    });
  });

  describe('task properties', () => {
    it('should parse optional fields correctly', async () => {
      await createScheduleFile('full-task.md', {
        name: 'Full Task',
        cron: '*/30 * * * *',
        prompt: 'Check status',
        chatId: 'oc_chat1',
        createdBy: 'ou_creator',
        createdAt: '2026-03-01T12:00:00Z',
        blocking: true,
        cooldownPeriod: 3600000,
        lastExecutedAt: '2026-03-15T09:00:00Z',
        model: 'claude-haiku-4-20250414',
      });

      const task = await manager.get('schedule-full-task');
      expect(task).toBeDefined();
      expect(task!.createdBy).toBe('ou_creator');
      expect(task!.blocking).toBe(true);
      expect(task!.cooldownPeriod).toBe(3600000);
      expect(task!.lastExecutedAt).toBe('2026-03-15T09:00:00Z');
      expect(task!.model).toBe('claude-haiku-4-20250414');
    });

    it('should handle task with minimal frontmatter', async () => {
      await createScheduleFile('minimal.md', {
        name: 'Minimal',
        cron: '0 * * * *',
        prompt: 'Ping',
        chatId: 'oc_chat1',
        enabled: true,
        createdAt: '2026-01-01T00:00:00Z',
      });

      const task = await manager.get('schedule-minimal');
      expect(task).toBeDefined();
      expect(task!.createdBy).toBeUndefined();
      expect(task!.blocking).toBe(false); // default from createScheduleFile
      expect(task!.cooldownPeriod).toBeUndefined();
    });
  });

  describe('no cache behavior', () => {
    it('should reflect file system changes without cache', async () => {
      await createScheduleFile('dynamic.md', { name: 'Dynamic' });

      const tasks1 = await manager.listAll();
      expect(tasks1).toHaveLength(1);

      // Add a new file
      await createScheduleFile('new-file.md', { name: 'New File' });

      const tasks2 = await manager.listAll();
      expect(tasks2).toHaveLength(2);
    });

    it('should reflect deleted files', async () => {
      await createScheduleFile('temp.md', { name: 'Temp' });
      expect(await manager.listAll()).toHaveLength(1);

      await fs.unlink(path.join(schedulesDir, 'temp.md'));
      expect(await manager.listAll()).toHaveLength(0);
    });
  });

  describe('getFileScanner', () => {
    it('should return the file scanner instance', () => {
      const scanner = manager.getFileScanner();
      expect(scanner).toBeDefined();
    });
  });
});
