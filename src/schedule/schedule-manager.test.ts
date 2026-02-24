/**
 * ScheduleManager Tests
 *
 * Note: ScheduleManager has NO cache - all operations read directly from file system.
 * This ensures perfect consistency - file system is the single source of truth.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ScheduleManager } from './schedule-manager.js';

describe('ScheduleManager', () => {
  let manager: ScheduleManager;
  let testDir: string;

  beforeEach(async () => {
    // Create unique temp directory for each test
    testDir = path.join(os.tmpdir(), `schedule-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, { recursive: true });
    manager = new ScheduleManager({ schedulesDir: testDir });
  });

  afterEach(async () => {
    // Clean up
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('create', () => {
    it('should create a new scheduled task', async () => {
      const task = await manager.create({
        name: 'Test Task',
        cron: '0 9 * * *',
        prompt: 'Test prompt',
        chatId: 'test-chat-id',
      });

      expect(task.id).toMatch(/^schedule-/);
      expect(task.name).toBe('Test Task');
      expect(task.cron).toBe('0 9 * * *');
      expect(task.prompt).toBe('Test prompt');
      expect(task.chatId).toBe('test-chat-id');
      expect(task.enabled).toBe(true);
      expect(task.createdAt).toBeDefined();
    });

    it('should persist tasks to markdown files', async () => {
      await manager.create({
        name: 'Task 1',
        cron: '0 9 * * *',
        prompt: 'Prompt 1',
        chatId: 'chat-1',
      });

      await manager.create({
        name: 'Task 2',
        cron: '0 10 * * *',
        prompt: 'Prompt 2',
        chatId: 'chat-2',
      });

      // Verify files exist
      const files = await fs.readdir(testDir);
      expect(files.length).toBe(2);
      expect(files.every(f => f.endsWith('.md'))).toBe(true);

      // Create new manager to test persistence (no cache, reads from files)
      const newManager = new ScheduleManager({ schedulesDir: testDir });
      const tasks = await newManager.listAll();

      expect(tasks).toHaveLength(2);
      expect(tasks.map(t => t.name)).toContain('Task 1');
      expect(tasks.map(t => t.name)).toContain('Task 2');
    });
  });

  describe('get', () => {
    it('should return task by id', async () => {
      const created = await manager.create({
        name: 'Test Task',
        cron: '0 9 * * *',
        prompt: 'Test prompt',
        chatId: 'test-chat',
      });

      const task = await manager.get(created.id);
      expect(task).toBeDefined();
      expect(task?.name).toBe('Test Task');
    });

    it('should return undefined for non-existent task', async () => {
      const task = await manager.get('non-existent-id');
      expect(task).toBeUndefined();
    });
  });

  describe('listByChatId', () => {
    it('should return tasks for specific chat', async () => {
      await manager.create({
        name: 'Task 1',
        cron: '0 9 * * *',
        prompt: 'Prompt 1',
        chatId: 'chat-1',
      });

      await manager.create({
        name: 'Task 2',
        cron: '0 10 * * *',
        prompt: 'Prompt 2',
        chatId: 'chat-2',
      });

      await manager.create({
        name: 'Task 3',
        cron: '0 11 * * *',
        prompt: 'Prompt 3',
        chatId: 'chat-1',
      });

      const chat1Tasks = await manager.listByChatId('chat-1');
      expect(chat1Tasks).toHaveLength(2);
      expect(chat1Tasks.map(t => t.name)).toEqual(expect.arrayContaining(['Task 1', 'Task 3']));

      const chat2Tasks = await manager.listByChatId('chat-2');
      expect(chat2Tasks).toHaveLength(1);
      expect(chat2Tasks[0].name).toBe('Task 2');
    });
  });

  describe('listEnabled', () => {
    it('should return only enabled tasks', async () => {
      await manager.create({
        name: 'Task 1',
        cron: '0 9 * * *',
        prompt: 'Prompt 1',
        chatId: 'chat-1',
      });

      const task2 = await manager.create({
        name: 'Task 2',
        cron: '0 10 * * *',
        prompt: 'Prompt 2',
        chatId: 'chat-1',
      });

      // Disable task 2
      await manager.toggle(task2.id, false);

      const enabledTasks = await manager.listEnabled();
      expect(enabledTasks).toHaveLength(1);
      expect(enabledTasks[0].name).toBe('Task 1');
    });
  });

  describe('update', () => {
    it('should update task fields', async () => {
      const task = await manager.create({
        name: 'Original Name',
        cron: '0 9 * * *',
        prompt: 'Original prompt',
        chatId: 'test-chat',
      });

      const updated = await manager.update(task.id, {
        name: 'Updated Name',
        cron: '0 10 * * *',
      });

      expect(updated).toBeDefined();
      expect(updated?.name).toBe('Updated Name');
      expect(updated?.cron).toBe('0 10 * * *');
      expect(updated?.prompt).toBe('Original prompt'); // Unchanged
    });
  });

  describe('toggle', () => {
    it('should toggle task enabled status', async () => {
      const task = await manager.create({
        name: 'Test Task',
        cron: '0 9 * * *',
        prompt: 'Test prompt',
        chatId: 'test-chat',
      });

      expect(task.enabled).toBe(true);

      const disabled = await manager.toggle(task.id, false);
      expect(disabled?.enabled).toBe(false);

      const enabled = await manager.toggle(task.id, true);
      expect(enabled?.enabled).toBe(true);
    });
  });

  describe('delete', () => {
    it('should delete a task', async () => {
      const task = await manager.create({
        name: 'Test Task',
        cron: '0 9 * * *',
        prompt: 'Test prompt',
        chatId: 'test-chat',
      });

      const deleted = await manager.delete(task.id);
      expect(deleted).toBe(true);

      const notFound = await manager.get(task.id);
      expect(notFound).toBeUndefined();
    });

    it('should return false for non-existent task', async () => {
      const deleted = await manager.delete('non-existent-id');
      expect(deleted).toBe(false);
    });
  });

  describe('markExecuted', () => {
    it('should update lastExecutedAt', async () => {
      const task = await manager.create({
        name: 'Test Task',
        cron: '0 9 * * *',
        prompt: 'Test prompt',
        chatId: 'test-chat',
      });

      expect(task.lastExecutedAt).toBeUndefined();

      await manager.markExecuted(task.id);

      const updated = await manager.get(task.id);
      expect(updated?.lastExecutedAt).toBeDefined();
    });
  });

  // ========================================================================
  // Issue #86 Tests: 文件系统一致性（无缓存）
  // ========================================================================

  describe('Issue #86: 删除任务后一致性', () => {
    it('should not show deleted task after delete (no cache)', async () => {
      // Create a task
      const task = await manager.create({
        name: 'Task to Delete',
        cron: '* * * * *',
        prompt: 'Test prompt',
        chatId: 'test-chat',
      });

      // Verify task exists
      const tasksBefore = await manager.listByChatId('test-chat');
      expect(tasksBefore).toHaveLength(1);
      expect(tasksBefore[0].id).toBe(task.id);

      // Delete the task
      const deleted = await manager.delete(task.id);
      expect(deleted).toBe(true);

      // Verify task is removed (reads from file system, no cache)
      const tasksAfter = await manager.listByChatId('test-chat');
      expect(tasksAfter).toHaveLength(0);
    });

    it('should not show deleted task in listAll after delete', async () => {
      const task = await manager.create({
        name: 'Task to Delete',
        cron: '* * * * *',
        prompt: 'Test',
        chatId: 'chat-1',
      });

      // Verify task exists
      let allTasks = await manager.listAll();
      expect(allTasks).toHaveLength(1);

      // Delete
      await manager.delete(task.id);

      // Verify listAll returns empty (reads from file system)
      allTasks = await manager.listAll();
      expect(allTasks).toHaveLength(0);
    });

    it('should not show deleted task in listEnabled after delete', async () => {
      const task = await manager.create({
        name: 'Enabled Task',
        cron: '* * * * *',
        prompt: 'Test',
        chatId: 'chat-1',
      });

      // Verify task is enabled
      let enabledTasks = await manager.listEnabled();
      expect(enabledTasks).toHaveLength(1);

      // Delete
      await manager.delete(task.id);

      // Verify listEnabled returns empty
      enabledTasks = await manager.listEnabled();
      expect(enabledTasks).toHaveLength(0);
    });
  });

  describe('Issue #86: 外部文件修改立即可见', () => {
    it('should see external file modifications immediately (no cache)', async () => {
      // Create task via manager
      const task = await manager.create({
        name: 'Original Task',
        cron: '0 9 * * *',
        prompt: 'Original',
        chatId: 'chat-1',
      });

      // Get the task file path
      const files = await fs.readdir(testDir);
      const taskFile = files.find(f => f.includes('original-task'));
      expect(taskFile).toBeDefined();

      // Manually modify the file (simulate external change)
      const filePath = path.join(testDir, taskFile!);
      const modifiedContent = `---
name: "Modified Task"
cron: "0 10 * * *"
enabled: true
chatId: "chat-1"
createdAt: "${task.createdAt}"
---
Modified prompt`;
      await fs.writeFile(filePath, modifiedContent);

      // No need to invalidate cache - next read sees changes
      const tasks = await manager.listAll();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].name).toBe('Modified Task');
      expect(tasks[0].cron).toBe('0 10 * * *');
      expect(tasks[0].prompt).toBe('Modified prompt');
    });

    it('should see external file deletion immediately (no cache)', async () => {
      // Create task
      await manager.create({
        name: 'Task to Remove',
        cron: '* * * * *',
        prompt: 'Test',
        chatId: 'chat-1',
      });

      // Verify exists
      let tasks = await manager.listAll();
      expect(tasks).toHaveLength(1);

      // Manually delete the file
      const files = await fs.readdir(testDir);
      const taskFile = files.find(f => f.includes('task-to-remove'));
      if (taskFile) {
        await fs.unlink(path.join(testDir, taskFile));
      }

      // No need to invalidate cache - next read sees deletion
      tasks = await manager.listAll();
      expect(tasks).toHaveLength(0);
    });
  });

  describe('Issue #86: 多任务删除一致性', () => {
    it('should correctly handle deleting one of multiple tasks', async () => {
      // Create multiple tasks
      const task1 = await manager.create({
        name: 'Task 1',
        cron: '0 9 * * *',
        prompt: 'Prompt 1',
        chatId: 'chat-1',
      });

      const task2 = await manager.create({
        name: 'Task 2',
        cron: '0 10 * * *',
        prompt: 'Prompt 2',
        chatId: 'chat-1',
      });

      const task3 = await manager.create({
        name: 'Task 3',
        cron: '0 11 * * *',
        prompt: 'Prompt 3',
        chatId: 'chat-2',
      });

      // Delete task2
      await manager.delete(task2.id);

      // Verify task1 and task3 still exist
      const allTasks = await manager.listAll();
      expect(allTasks).toHaveLength(2);
      expect(allTasks.map(t => t.name)).toEqual(expect.arrayContaining(['Task 1', 'Task 3']));

      // Verify chat-1 has only task1
      const chat1Tasks = await manager.listByChatId('chat-1');
      expect(chat1Tasks).toHaveLength(1);
      expect(chat1Tasks[0].id).toBe(task1.id);

      // Verify chat-2 has task3
      const chat2Tasks = await manager.listByChatId('chat-2');
      expect(chat2Tasks).toHaveLength(1);
      expect(chat2Tasks[0].id).toBe(task3.id);
    });
  });

  describe('No Cache: 文件系统是唯一真相', () => {
    it('should always read fresh data from files', async () => {
      // Create task
      const task = await manager.create({
        name: 'Test Task',
        cron: '0 9 * * *',
        prompt: 'Original',
        chatId: 'chat-1',
      });

      // Read via get()
      let fetched = await manager.get(task.id);
      expect(fetched?.prompt).toBe('Original');

      // Update via manager
      await manager.update(task.id, { prompt: 'Updated' });

      // Read again - should see updated value
      fetched = await manager.get(task.id);
      expect(fetched?.prompt).toBe('Updated');
    });

    it('should see changes from another manager instance', async () => {
      // Create task with first manager
      const task = await manager.create({
        name: 'Test Task',
        cron: '0 9 * * *',
        prompt: 'Original',
        chatId: 'chat-1',
      });

      // Create second manager (simulating another process)
      const manager2 = new ScheduleManager({ schedulesDir: testDir });

      // Update via second manager
      await manager2.update(task.id, { prompt: 'Updated by manager2' });

      // First manager should see the change
      const fetched = await manager.get(task.id);
      expect(fetched?.prompt).toBe('Updated by manager2');
    });
  });
});
