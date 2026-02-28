/**
 * ScheduleManager Tests
 *
 * Note: ScheduleManager has NO cache - all operations read directly from file system.
 * This ensures perfect consistency - file system is the single source of truth.
 *
 * CRUD operations (create/update/delete) have been removed.
 * Tests now use file system directly to create test data.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ScheduleManager } from './schedule-manager.js';

/**
 * Helper to create a schedule file directly in the file system.
 * Note: The task ID is generated as `schedule-${fileName}` by ScheduleFileScanner.
 * So if you want ID "schedule-my-task", pass "my-task" as the id parameter.
 */
async function createScheduleFile(
  testDir: string,
  task: {
    id: string;  // This is the base name (without .md), ID will be `schedule-${id}`
    name: string;
    cron: string;
    prompt: string;
    chatId: string;
    enabled?: boolean;
    createdAt?: string;
  }
): Promise<void> {
  // id is the base name, file is `${id}.md`, generated ID will be `schedule-${id}`
  const filePath = path.join(testDir, `${task.id}.md`);
  const content = `---
name: "${task.name}"
cron: "${task.cron}"
enabled: ${task.enabled ?? true}
chatId: "${task.chatId}"
createdAt: "${task.createdAt ?? new Date().toISOString()}"
---
${task.prompt}`;
  await fs.writeFile(filePath, content);
}

/**
 * Helper to get the expected task ID from base name.
 */
function getTaskId(baseName: string): string {
  return `schedule-${baseName}`;
}

/**
 * Helper to delete a schedule file directly.
 */
async function deleteScheduleFile(testDir: string, baseName: string): Promise<void> {
  const filePath = path.join(testDir, `${baseName}.md`);
  await fs.unlink(filePath).catch(() => {});
}

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

  describe('get', () => {
    it('should return task by id', async () => {
      await createScheduleFile(testDir, {
        id: 'test-task',
        name: 'Test Task',
        cron: '0 9 * * *',
        prompt: 'Test prompt',
        chatId: 'test-chat',
      });

      const task = await manager.get(getTaskId('test-task'));
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
      await createScheduleFile(testDir, {
        id: 'task-1',
        name: 'Task 1',
        cron: '0 9 * * *',
        prompt: 'Prompt 1',
        chatId: 'chat-1',
      });

      await createScheduleFile(testDir, {
        id: 'task-2',
        name: 'Task 2',
        cron: '0 10 * * *',
        prompt: 'Prompt 2',
        chatId: 'chat-2',
      });

      await createScheduleFile(testDir, {
        id: 'task-3',
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
      await createScheduleFile(testDir, {
        id: 'task-1',
        name: 'Task 1',
        cron: '0 9 * * *',
        prompt: 'Prompt 1',
        chatId: 'chat-1',
        enabled: true,
      });

      await createScheduleFile(testDir, {
        id: 'task-2',
        name: 'Task 2',
        cron: '0 10 * * *',
        prompt: 'Prompt 2',
        chatId: 'chat-1',
        enabled: false,
      });

      const enabledTasks = await manager.listEnabled();
      expect(enabledTasks).toHaveLength(1);
      expect(enabledTasks[0].name).toBe('Task 1');
    });
  });

  describe('listAll', () => {
    it('should return all tasks', async () => {
      await createScheduleFile(testDir, {
        id: 'task-1',
        name: 'Task 1',
        cron: '0 9 * * *',
        prompt: 'Prompt 1',
        chatId: 'chat-1',
      });

      await createScheduleFile(testDir, {
        id: 'task-2',
        name: 'Task 2',
        cron: '0 10 * * *',
        prompt: 'Prompt 2',
        chatId: 'chat-2',
      });

      const allTasks = await manager.listAll();
      expect(allTasks).toHaveLength(2);
      expect(allTasks.map(t => t.name)).toEqual(expect.arrayContaining(['Task 1', 'Task 2']));
    });
  });

  describe('getFileScanner', () => {
    it('should return the file scanner instance', () => {
      const scanner = manager.getFileScanner();
      expect(scanner).toBeDefined();
    });
  });

  // ========================================================================
  // Issue #86 Tests: 文件系统一致性（无缓存）
  // ========================================================================

  describe('Issue #86: 删除任务后一致性', () => {
    it('should not show deleted task after delete (no cache)', async () => {
      // Create a task file
      await createScheduleFile(testDir, {
        id: 'task-to-delete',
        name: 'Task to Delete',
        cron: '* * * * *',
        prompt: 'Test prompt',
        chatId: 'test-chat',
      });

      const expectedId = getTaskId('task-to-delete');

      // Verify task exists
      const tasksBefore = await manager.listByChatId('test-chat');
      expect(tasksBefore).toHaveLength(1);
      expect(tasksBefore[0].id).toBe(expectedId);

      // Delete the task file directly
      await deleteScheduleFile(testDir, 'task-to-delete');

      // Verify task is removed (reads from file system, no cache)
      const tasksAfter = await manager.listByChatId('test-chat');
      expect(tasksAfter).toHaveLength(0);
    });

    it('should not show deleted task in listAll after file deletion', async () => {
      await createScheduleFile(testDir, {
        id: 'task-to-delete',
        name: 'Task to Delete',
        cron: '* * * * *',
        prompt: 'Test',
        chatId: 'chat-1',
      });

      // Verify task exists
      let allTasks = await manager.listAll();
      expect(allTasks).toHaveLength(1);

      // Delete file directly
      await deleteScheduleFile(testDir, 'task-to-delete');

      // Verify listAll returns empty (reads from file system)
      allTasks = await manager.listAll();
      expect(allTasks).toHaveLength(0);
    });

    it('should not show deleted task in listEnabled after file deletion', async () => {
      await createScheduleFile(testDir, {
        id: 'enabled-task',
        name: 'Enabled Task',
        cron: '* * * * *',
        prompt: 'Test',
        chatId: 'chat-1',
        enabled: true,
      });

      // Verify task is enabled
      let enabledTasks = await manager.listEnabled();
      expect(enabledTasks).toHaveLength(1);

      // Delete file
      await deleteScheduleFile(testDir, 'enabled-task');

      // Verify listEnabled returns empty
      enabledTasks = await manager.listEnabled();
      expect(enabledTasks).toHaveLength(0);
    });
  });

  describe('Issue #86: 外部文件修改立即可见', () => {
    it('should see external file modifications immediately (no cache)', async () => {
      const createdAt = new Date().toISOString();

      // Create task file
      await createScheduleFile(testDir, {
        id: 'original-task',
        name: 'Original Task',
        cron: '0 9 * * *',
        prompt: 'Original',
        chatId: 'chat-1',
        createdAt,
      });

      // Manually modify the file (simulate external change)
      const filePath = path.join(testDir, 'original-task.md');
      const modifiedContent = `---
name: "Modified Task"
cron: "0 10 * * *"
enabled: true
chatId: "chat-1"
createdAt: "${createdAt}"
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
      await createScheduleFile(testDir, {
        id: 'task-to-remove',
        name: 'Task to Remove',
        cron: '* * * * *',
        prompt: 'Test',
        chatId: 'chat-1',
      });

      // Verify exists
      let tasks = await manager.listAll();
      expect(tasks).toHaveLength(1);

      // Manually delete the file
      await deleteScheduleFile(testDir, 'task-to-remove');

      // No need to invalidate cache - next read sees deletion
      tasks = await manager.listAll();
      expect(tasks).toHaveLength(0);
    });
  });

  describe('Issue #86: 多任务删除一致性', () => {
    it('should correctly handle deleting one of multiple tasks', async () => {
      // Create multiple tasks
      await createScheduleFile(testDir, {
        id: 'task-1',
        name: 'Task 1',
        cron: '0 9 * * *',
        prompt: 'Prompt 1',
        chatId: 'chat-1',
      });

      await createScheduleFile(testDir, {
        id: 'task-2',
        name: 'Task 2',
        cron: '0 10 * * *',
        prompt: 'Prompt 2',
        chatId: 'chat-1',
      });

      await createScheduleFile(testDir, {
        id: 'task-3',
        name: 'Task 3',
        cron: '0 11 * * *',
        prompt: 'Prompt 3',
        chatId: 'chat-2',
      });

      // Delete task2 file
      await deleteScheduleFile(testDir, 'task-2');

      // Verify task1 and task3 still exist
      const allTasks = await manager.listAll();
      expect(allTasks).toHaveLength(2);
      expect(allTasks.map(t => t.name)).toEqual(expect.arrayContaining(['Task 1', 'Task 3']));

      // Verify chat-1 has only task1
      const chat1Tasks = await manager.listByChatId('chat-1');
      expect(chat1Tasks).toHaveLength(1);
      expect(chat1Tasks[0].id).toBe(getTaskId('task-1'));

      // Verify chat-2 has task3
      const chat2Tasks = await manager.listByChatId('chat-2');
      expect(chat2Tasks).toHaveLength(1);
      expect(chat2Tasks[0].id).toBe(getTaskId('task-3'));
    });
  });

  describe('No Cache: 文件系统是唯一真相', () => {
    it('should always read fresh data from files', async () => {
      const createdAt = new Date().toISOString();

      // Create task file
      await createScheduleFile(testDir, {
        id: 'test-task',
        name: 'Test Task',
        cron: '0 9 * * *',
        prompt: 'Original',
        chatId: 'chat-1',
        createdAt,
      });

      const expectedId = getTaskId('test-task');

      // Read via get()
      let fetched = await manager.get(expectedId);
      expect(fetched?.prompt).toBe('Original');

      // Modify file directly
      const filePath = path.join(testDir, 'test-task.md');
      const modifiedContent = `---
name: "Test Task"
cron: "0 9 * * *"
enabled: true
chatId: "chat-1"
createdAt: "${createdAt}"
---
Updated`;
      await fs.writeFile(filePath, modifiedContent);

      // Read again - should see updated value
      fetched = await manager.get(expectedId);
      expect(fetched?.prompt).toBe('Updated');
    });

    it('should see changes from another manager instance', async () => {
      const createdAt = new Date().toISOString();

      // Create task file
      await createScheduleFile(testDir, {
        id: 'test-task',
        name: 'Test Task',
        cron: '0 9 * * *',
        prompt: 'Original',
        chatId: 'chat-1',
        createdAt,
      });

      const expectedId = getTaskId('test-task');

      // Create second manager (simulating another process)
      const manager2 = new ScheduleManager({ schedulesDir: testDir });

      // Modify file directly (simulating update via another process)
      const filePath = path.join(testDir, 'test-task.md');
      const modifiedContent = `---
name: "Test Task"
cron: "0 9 * * *"
enabled: true
chatId: "chat-1"
createdAt: "${createdAt}"
---
Updated by manager2`;
      await fs.writeFile(filePath, modifiedContent);

      // First manager should see the change
      const fetched = await manager.get(expectedId);
      expect(fetched?.prompt).toBe('Updated by manager2');
    });
  });

});
