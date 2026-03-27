/**
 * Tests for ScheduleManager.
 *
 * Tests task query operations, including:
 * - Loading tasks from file system
 * - Filtering by chatId
 * - Filtering enabled tasks
 * - Listing all tasks
 * - Handling empty/missing schedule directories
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScheduleManager } from './schedule-manager.js';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('ScheduleManager', () => {
  let manager: ScheduleManager;
  let schedulesDir: string;

  beforeEach(async () => {
    schedulesDir = path.join(os.tmpdir(), `schedules-test-${Date.now()}`);
    await fsPromises.mkdir(schedulesDir, { recursive: true });
    manager = new ScheduleManager({ schedulesDir });
  });

  afterEach(async () => {
    await fsPromises.rm(schedulesDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('constructor', () => {
    it('should create a manager with schedules directory', () => {
      expect(manager).toBeDefined();
    });

    it('should expose the file scanner', () => {
      expect(manager.getFileScanner()).toBeDefined();
    });
  });

  describe('listAll', () => {
    it('should return empty array when no schedule files exist', async () => {
      const tasks = await manager.listAll();
      expect(tasks).toHaveLength(0);
    });

    it('should return all parsed tasks', async () => {
      // Create a valid schedule file
      const content = [
        '---',
        'name: "Daily Report"',
        'cron: "0 9 * * *"',
        'enabled: true',
        'chatId: oc_test1',
        '---',
        '',
        'Generate daily report',
      ].join('\n');
      await fsPromises.writeFile(path.join(schedulesDir, 'daily-report.md'), content);

      const tasks = await manager.listAll();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].name).toBe('Daily Report');
      expect(tasks[0].chatId).toBe('oc_test1');
    });

    it('should skip files missing required fields', async () => {
      // File missing cron field
      const content = [
        '---',
        'name: "Incomplete Task"',
        'enabled: true',
        '---',
        '',
        'Do something',
      ].join('\n');
      await fsPromises.writeFile(path.join(schedulesDir, 'incomplete.md'), content);

      const tasks = await manager.listAll();
      expect(tasks).toHaveLength(0);
    });

    it('should parse multiple schedule files', async () => {
      for (let i = 1; i <= 3; i++) {
        const content = [
          '---',
          `name: "Task ${i}"`,
          'cron: "0 9 * * *"',
          `enabled: ${i !== 2}`, // Task 2 is disabled
          `chatId: oc_chat_${i}`,
          '---',
          '',
          `Task ${i} prompt`,
        ].join('\n');
        await fsPromises.writeFile(path.join(schedulesDir, `task-${i}.md`), content);
      }

      const tasks = await manager.listAll();
      expect(tasks).toHaveLength(3);
    });
  });

  describe('listByChatId', () => {
    it('should return empty array when no tasks match chatId', async () => {
      // Create task for a different chat
      const content = [
        '---',
        'name: "Other Chat Task"',
        'cron: "0 9 * * *"',
        'enabled: true',
        'chatId: oc_other',
        '---',
        '',
        'Prompt',
      ].join('\n');
      await fsPromises.writeFile(path.join(schedulesDir, 'other.md'), content);

      const tasks = await manager.listByChatId('oc_target');
      expect(tasks).toHaveLength(0);
    });

    it('should return only tasks matching the specified chatId', async () => {
      // Create tasks for different chats with unique file names
      const taskConfigs = [
        { name: 'Chat1 Task A', chatId: 'oc_chat1', file: 'chat1-task-a.md' },
        { name: 'Chat2 Task', chatId: 'oc_chat2', file: 'chat2-task.md' },
        { name: 'Chat1 Task B', chatId: 'oc_chat1', file: 'chat1-task-b.md' },
      ];

      for (const config of taskConfigs) {
        const content = [
          '---',
          `name: "${config.name}"`,
          'cron: "0 9 * * *"',
          'enabled: true',
          `chatId: ${config.chatId}`,
          '---',
          '',
          'Prompt',
        ].join('\n');
        await fsPromises.writeFile(path.join(schedulesDir, config.file), content);
      }

      const tasks = await manager.listByChatId('oc_chat1');
      expect(tasks).toHaveLength(2);
      tasks.forEach(t => expect(t.chatId).toBe('oc_chat1'));
    });
  });

  describe('listEnabled', () => {
    it('should return only enabled tasks', async () => {
      // Create enabled task
      const enabledContent = [
        '---',
        'name: "Enabled Task"',
        'cron: "0 9 * * *"',
        'enabled: true',
        'chatId: oc_test',
        '---',
        '',
        'Enabled prompt',
      ].join('\n');
      await fsPromises.writeFile(path.join(schedulesDir, 'enabled.md'), enabledContent);

      // Create disabled task
      const disabledContent = [
        '---',
        'name: "Disabled Task"',
        'cron: "0 10 * * *"',
        'enabled: false',
        'chatId: oc_test',
        '---',
        '',
        'Disabled prompt',
      ].join('\n');
      await fsPromises.writeFile(path.join(schedulesDir, 'disabled.md'), disabledContent);

      const tasks = await manager.listEnabled();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].name).toBe('Enabled Task');
    });

    it('should return all tasks when all are enabled', async () => {
      for (let i = 1; i <= 3; i++) {
        const content = [
          '---',
          `name: "Task ${i}"`,
          'cron: "0 9 * * *"',
          'enabled: true',
          'chatId: oc_test',
          '---',
          '',
          `Prompt ${i}`,
        ].join('\n');
        await fsPromises.writeFile(path.join(schedulesDir, `task-${i}.md`), content);
      }

      const tasks = await manager.listEnabled();
      expect(tasks).toHaveLength(3);
    });

    it('should return empty when all tasks are disabled', async () => {
      const content = [
        '---',
        'name: "Disabled"',
        'cron: "0 9 * * *"',
        'enabled: false',
        'chatId: oc_test',
        '---',
        '',
        'Prompt',
      ].join('\n');
      await fsPromises.writeFile(path.join(schedulesDir, 'disabled.md'), content);

      const tasks = await manager.listEnabled();
      expect(tasks).toHaveLength(0);
    });
  });

  describe('get', () => {
    it('should return undefined for non-existent task', async () => {
      const task = await manager.get('non-existent-id');
      expect(task).toBeUndefined();
    });

    it('should return the correct task by ID', async () => {
      const content = [
        '---',
        'name: "Target Task"',
        'cron: "0 9 * * *"',
        'enabled: true',
        'chatId: oc_test',
        '---',
        '',
        'Target prompt',
      ].join('\n');
      await fsPromises.writeFile(path.join(schedulesDir, 'target.md'), content);

      const task = await manager.get('schedule-target');
      expect(task).toBeDefined();
      expect(task!.name).toBe('Target Task');
    });
  });

  describe('parsing edge cases', () => {
    it('should handle tasks with optional fields', async () => {
      const content = [
        '---',
        'name: "Full Task"',
        'cron: "*/30 * * * *"',
        'enabled: true',
        'blocking: false',
        'chatId: oc_test',
        'createdBy: user_123',
        'cooldownPeriod: 300000',
        'model: "claude-sonnet-4-20250514"',
        '---',
        '',
        'Full task prompt',
      ].join('\n');
      await fsPromises.writeFile(path.join(schedulesDir, 'full.md'), content);

      const tasks = await manager.listAll();
      expect(tasks).toHaveLength(1);

      const task = tasks[0];
      expect(task.blocking).toBe(false);
      expect(task.createdBy).toBe('user_123');
      expect(task.cooldownPeriod).toBe(300000);
      expect(task.model).toBe('claude-sonnet-4-20250514');
    });

    it('should handle non-markdown files gracefully', async () => {
      // Create a non-markdown file
      await fsPromises.writeFile(path.join(schedulesDir, 'readme.txt'), 'Not a schedule file');
      await fsPromises.writeFile(path.join(schedulesDir, '.gitkeep'), '');

      const tasks = await manager.listAll();
      expect(tasks).toHaveLength(0);
    });
  });
});
