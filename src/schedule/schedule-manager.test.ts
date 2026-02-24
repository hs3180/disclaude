/**
 * ScheduleManager Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ScheduleManager } from './schedule-manager.js';

describe('ScheduleManager', () => {
  let manager: ScheduleManager;
  const testFilePath = path.join(__dirname, 'test-schedules.json');

  beforeEach(async () => {
    manager = new ScheduleManager(testFilePath);
    // Ensure clean state
    try {
      await fs.unlink(testFilePath);
    } catch {
      // File doesn't exist, that's fine
    }
  });

  afterEach(async () => {
    // Clean up
    try {
      await fs.unlink(testFilePath);
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

    it('should persist tasks to file', async () => {
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

      // Create new manager to test persistence
      const newManager = new ScheduleManager(testFilePath);
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
      expect(chat1Tasks.map(t => t.name)).toEqual(['Task 1', 'Task 3']);

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

  describe('cache', () => {
    it('should use cache after first load', async () => {
      await manager.create({
        name: 'Task 1',
        cron: '0 9 * * *',
        prompt: 'Prompt 1',
        chatId: 'chat-1',
      });

      // Invalidate cache to force reload
      manager.invalidateCache();

      const tasks = await manager.listAll();
      expect(tasks).toHaveLength(1);
    });
  });
});
