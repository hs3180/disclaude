/**
 * ScheduleFileScanner Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ScheduleFileScanner } from './schedule-file-scanner.js';

describe('ScheduleFileScanner', () => {
  let scanner: ScheduleFileScanner;
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `schedule-scanner-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, { recursive: true });
    scanner = new ScheduleFileScanner({ schedulesDir: testDir });
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('scanAll', () => {
    it('should return empty array when no files exist', async () => {
      const tasks = await scanner.scanAll();
      expect(tasks).toEqual([]);
    });

    it('should create directory if it does not exist', async () => {
      const newDir = path.join(testDir, 'nonexistent');
      const newScanner = new ScheduleFileScanner({ schedulesDir: newDir });

      await newScanner.scanAll();

      const exists = await fs.access(newDir).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('should scan and parse valid schedule files', async () => {
      // Create a valid schedule file
      const fileContent = `---
name: "Daily Report"
cron: "0 9 * * *"
enabled: true
blocking: true
chatId: "oc_test123"
createdBy: "ou_user1"
---

This is the task prompt.`;

      await fs.writeFile(path.join(testDir, 'daily-report.md'), fileContent);

      const tasks = await scanner.scanAll();

      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe('schedule-daily-report');
      expect(tasks[0].name).toBe('Daily Report');
      expect(tasks[0].cron).toBe('0 9 * * *');
      expect(tasks[0].enabled).toBe(true);
      expect(tasks[0].blocking).toBe(true);
      expect(tasks[0].chatId).toBe('oc_test123');
      expect(tasks[0].createdBy).toBe('ou_user1');
      expect(tasks[0].prompt).toBe('This is the task prompt.');
    });

    it('should skip files with missing required fields', async () => {
      // File missing chatId
      const invalidContent = `---
name: "Invalid Task"
cron: "0 9 * * *"
enabled: true
---

Missing chatId`;

      await fs.writeFile(path.join(testDir, 'invalid.md'), invalidContent);

      const tasks = await scanner.scanAll();
      expect(tasks).toHaveLength(0);
    });

    it('should skip non-markdown files', async () => {
      await fs.writeFile(path.join(testDir, 'test.txt'), 'Not a schedule file');
      await fs.writeFile(path.join(testDir, 'test.json'), '{}');

      const tasks = await scanner.scanAll();
      expect(tasks).toHaveLength(0);
    });

    it('should scan multiple schedule files', async () => {
      const file1 = `---
name: "Task 1"
cron: "0 9 * * *"
chatId: "chat1"
---
Prompt 1`;

      const file2 = `---
name: "Task 2"
cron: "0 10 * * *"
chatId: "chat2"
---
Prompt 2`;

      await fs.writeFile(path.join(testDir, 'task1.md'), file1);
      await fs.writeFile(path.join(testDir, 'task2.md'), file2);

      const tasks = await scanner.scanAll();
      expect(tasks).toHaveLength(2);
      expect(tasks.map(t => t.name)).toContain('Task 1');
      expect(tasks.map(t => t.name)).toContain('Task 2');
    });

    it('should parse enabled and blocking as boolean false', async () => {
      const fileContent = `---
name: "Disabled Task"
cron: "0 9 * * *"
enabled: false
blocking: false
chatId: "oc_test"
---
Prompt`;

      await fs.writeFile(path.join(testDir, 'disabled.md'), fileContent);

      const tasks = await scanner.scanAll();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].enabled).toBe(false);
      expect(tasks[0].blocking).toBe(false);
    });

    it('should default enabled and blocking to true when not specified', async () => {
      const fileContent = `---
name: "Default Task"
cron: "0 9 * * *"
chatId: "oc_test"
---
Prompt`;

      await fs.writeFile(path.join(testDir, 'defaults.md'), fileContent);

      const tasks = await scanner.scanAll();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].enabled).toBe(true);
      expect(tasks[0].blocking).toBe(true);
    });

    it('should handle quotes in frontmatter values', async () => {
      const fileContent = `---
name: 'Single Quoted'
cron: "0 9 * * *"
chatId: "oc_test"
---
Prompt`;

      await fs.writeFile(path.join(testDir, 'quoted.md'), fileContent);

      const tasks = await scanner.scanAll();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].name).toBe('Single Quoted');
    });
  });

  describe('parseFile', () => {
    it('should return null for non-existent file', async () => {
      const task = await scanner.parseFile(path.join(testDir, 'nonexistent.md'));
      expect(task).toBeNull();
    });

    it('should return file metadata', async () => {
      const fileContent = `---
name: "Test Task"
cron: "0 9 * * *"
chatId: "oc_test"
---
Prompt`;

      const filePath = path.join(testDir, 'test.md');
      await fs.writeFile(filePath, fileContent);

      const task = await scanner.parseFile(filePath);

      expect(task).not.toBeNull();
      expect(task?.sourceFile).toBe(filePath);
      expect(task?.fileMtime).toBeInstanceOf(Date);
    });

    it('should use file birthtime as createdAt when not specified', async () => {
      const fileContent = `---
name: "Test Task"
cron: "0 9 * * *"
chatId: "oc_test"
---
Prompt`;

      const filePath = path.join(testDir, 'test.md');
      await fs.writeFile(filePath, fileContent);

      const task = await scanner.parseFile(filePath);

      expect(task).not.toBeNull();
      expect(task?.createdAt).toBeDefined();
    });

    it('should use createdAt from frontmatter when specified', async () => {
      const fileContent = `---
name: "Test Task"
cron: "0 9 * * *"
chatId: "oc_test"
createdAt: "2024-01-01T00:00:00.000Z"
---
Prompt`;

      const filePath = path.join(testDir, 'test.md');
      await fs.writeFile(filePath, fileContent);

      const task = await scanner.parseFile(filePath);

      expect(task).not.toBeNull();
      expect(task?.createdAt).toBe('2024-01-01T00:00:00.000Z');
    });

    it('should preserve lastExecutedAt from frontmatter', async () => {
      const fileContent = `---
name: "Test Task"
cron: "0 9 * * *"
chatId: "oc_test"
lastExecutedAt: "2024-06-15T09:00:00.000Z"
---
Prompt`;

      const filePath = path.join(testDir, 'test.md');
      await fs.writeFile(filePath, fileContent);

      const task = await scanner.parseFile(filePath);

      expect(task).not.toBeNull();
      expect(task?.lastExecutedAt).toBe('2024-06-15T09:00:00.000Z');
    });
  });

  describe('writeTask', () => {
    it('should write a task to a markdown file', async () => {
      const task = {
        id: 'schedule-my-task',
        name: 'My Task',
        cron: '0 9 * * *',
        enabled: true,
        blocking: true,
        chatId: 'oc_test',
        prompt: 'Task prompt',
      };

      const filePath = await scanner.writeTask(task);

      expect(filePath).toBe(path.join(testDir, 'my-task.md'));

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('name: "My Task"');
      expect(content).toContain('cron: "0 9 * * *"');
      expect(content).toContain('chatId: oc_test');
      expect(content).toContain('enabled: true');
      expect(content).toContain('Task prompt');
    });

    it('should include optional fields when present', async () => {
      const task = {
        id: 'schedule-task',
        name: 'Task',
        cron: '0 9 * * *',
        enabled: true,
        blocking: true,
        chatId: 'oc_test',
        prompt: 'Prompt',
        createdBy: 'ou_user1',
        createdAt: '2024-01-01T00:00:00.000Z',
        lastExecutedAt: '2024-06-15T09:00:00.000Z',
      };

      const filePath = await scanner.writeTask(task);
      const content = await fs.readFile(filePath, 'utf-8');

      expect(content).toContain('createdBy: ou_user1');
      expect(content).toContain('createdAt: "2024-01-01T00:00:00.000Z"');
      expect(content).toContain('lastExecutedAt: "2024-06-15T09:00:00.000Z"');
    });

    it('should create directory if it does not exist', async () => {
      const newDir = path.join(testDir, 'newdir');
      const newScanner = new ScheduleFileScanner({ schedulesDir: newDir });

      await newScanner.writeTask({
        id: 'schedule-task',
        name: 'Task',
        cron: '0 9 * * *',
        enabled: true,
        blocking: true,
        chatId: 'oc_test',
        prompt: 'Prompt',
      });

      const exists = await fs.access(newDir).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });
  });

  describe('deleteTask', () => {
    it('should delete an existing task file', async () => {
      // Create a task file first
      await scanner.writeTask({
        id: 'schedule-task-to-delete',
        name: 'Task',
        cron: '0 9 * * *',
        enabled: true,
        blocking: true,
        chatId: 'oc_test',
        prompt: 'Prompt',
      });

      const deleted = await scanner.deleteTask('schedule-task-to-delete');
      expect(deleted).toBe(true);

      const tasks = await scanner.scanAll();
      expect(tasks).toHaveLength(0);
    });

    it('should return false for non-existent task', async () => {
      const deleted = await scanner.deleteTask('schedule-nonexistent');
      expect(deleted).toBe(false);
    });

    it('should return false for task ID without schedule- prefix', async () => {
      const deleted = await scanner.deleteTask('invalid-id');
      expect(deleted).toBe(false);
    });
  });

  describe('getFilePath', () => {
    it('should return correct file path for schedule- prefixed ID', () => {
      const filePath = scanner.getFilePath('schedule-my-task');
      expect(filePath).toBe(path.join(testDir, 'my-task.md'));
    });

    it('should handle task ID without schedule- prefix', () => {
      const filePath = scanner.getFilePath('my-task');
      expect(filePath).toBe(path.join(testDir, 'my-task.md'));
    });
  });

  describe('round-trip', () => {
    it('should preserve all task data through write and read cycle', async () => {
      const originalTask = {
        id: 'schedule-roundtrip',
        name: 'Roundtrip Task',
        cron: '30 14 * * 1-5',
        enabled: false,
        blocking: false,
        chatId: 'oc_roundtrip',
        prompt: 'Multi-line\nprompt\nwith special chars: é, 中文, 🎉',
        createdBy: 'ou_creator',
      };

      await scanner.writeTask(originalTask);
      const tasks = await scanner.scanAll();

      expect(tasks).toHaveLength(1);
      const readTask = tasks[0];

      expect(readTask.id).toBe(originalTask.id);
      expect(readTask.name).toBe(originalTask.name);
      expect(readTask.cron).toBe(originalTask.cron);
      expect(readTask.enabled).toBe(originalTask.enabled);
      expect(readTask.blocking).toBe(originalTask.blocking);
      expect(readTask.chatId).toBe(originalTask.chatId);
      expect(readTask.prompt).toBe(originalTask.prompt);
      expect(readTask.createdBy).toBe(originalTask.createdBy);
    });
  });
});
