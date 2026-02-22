/**
 * Tests for LocalTransport.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LocalTransport } from './local-transport.js';
import type { TaskRequest, TaskResponse, MessageContent } from './types.js';

describe('LocalTransport', () => {
  let transport: LocalTransport;

  beforeEach(() => {
    transport = new LocalTransport();
  });

  describe('start/stop', () => {
    it('should start and stop successfully', async () => {
      expect(transport.isRunning()).toBe(false);
      await transport.start();
      expect(transport.isRunning()).toBe(true);
      await transport.stop();
      expect(transport.isRunning()).toBe(false);
    });
  });

  describe('sendTask', () => {
    it('should return error when no task handler is registered', async () => {
      await transport.start();
      const request: TaskRequest = {
        taskId: 'test-1',
        chatId: 'chat-1',
        message: 'Hello',
        messageId: 'msg-1',
      };
      const response = await transport.sendTask(request);
      expect(response.success).toBe(false);
      expect(response.error).toBe('No task handler registered');
      expect(response.taskId).toBe('test-1');
    });

    it('should call registered task handler', async () => {
      await transport.start();
      const handler = vi.fn().mockResolvedValue({
        success: true,
        taskId: 'test-1',
      }) as (request: TaskRequest) => Promise<TaskResponse>;
      transport.onTask(handler);

      const request: TaskRequest = {
        taskId: 'test-1',
        chatId: 'chat-1',
        message: 'Hello',
        messageId: 'msg-1',
      };
      const response = await transport.sendTask(request);

      expect(handler).toHaveBeenCalledWith(request);
      expect(response.success).toBe(true);
      expect(response.taskId).toBe('test-1');
    });

    it('should handle task handler errors', async () => {
      await transport.start();
      const handler = vi.fn().mockRejectedValue(
        new Error('Handler error')
      ) as (request: TaskRequest) => Promise<TaskResponse>;
      transport.onTask(handler);

      const request: TaskRequest = {
        taskId: 'test-1',
        chatId: 'chat-1',
        message: 'Hello',
        messageId: 'msg-1',
      };
      const response = await transport.sendTask(request);

      expect(response.success).toBe(false);
      expect(response.error).toBe('Handler error');
    });
  });

  describe('sendMessage', () => {
    it('should throw error when no message handler is registered', async () => {
      await transport.start();
      const content: MessageContent = {
        chatId: 'chat-1',
        type: 'text',
        text: 'Hello',
      };
      await expect(transport.sendMessage(content)).rejects.toThrow('No message handler registered');
    });

    it('should call registered message handler', async () => {
      await transport.start();
      const handler = vi.fn() as (content: MessageContent) => Promise<void>;
      transport.onMessage(handler);

      const content: MessageContent = {
        chatId: 'chat-1',
        type: 'text',
        text: 'Hello',
      };
      await transport.sendMessage(content);

      expect(handler).toHaveBeenCalledWith(content);
    });

    it('should handle card messages', async () => {
      await transport.start();
      const handler = vi.fn() as (content: MessageContent) => Promise<void>;
      transport.onMessage(handler);

      const card = { header: { title: 'Test' } };
      const content: MessageContent = {
        chatId: 'chat-1',
        type: 'card',
        card,
        description: 'Test card',
      };
      await transport.sendMessage(content);

      expect(handler).toHaveBeenCalledWith(content);
    });

    it('should handle file messages', async () => {
      await transport.start();
      const handler = vi.fn() as (content: MessageContent) => Promise<void>;
      transport.onMessage(handler);

      const content: MessageContent = {
        chatId: 'chat-1',
        type: 'file',
        filePath: '/tmp/test.txt',
      };
      await transport.sendMessage(content);

      expect(handler).toHaveBeenCalledWith(content);
    });

    it('should propagate message handler errors', async () => {
      await transport.start();
      const handler = vi.fn().mockRejectedValue(
        new Error('Send failed')
      ) as (content: MessageContent) => Promise<void>;
      transport.onMessage(handler);

      const content: MessageContent = {
        chatId: 'chat-1',
        type: 'text',
        text: 'Hello',
      };
      await expect(transport.sendMessage(content)).rejects.toThrow('Send failed');
    });
  });

  describe('integration', () => {
    it('should support bidirectional communication', async () => {
      await transport.start();

      // Track messages and tasks
      const sentMessages: MessageContent[] = [];
      const processedTasks: TaskRequest[] = [];

      // Register handlers
      transport.onMessage(async (content) => {
        sentMessages.push(content);
      });
      transport.onTask(async (request) => {
        processedTasks.push(request);
        // Simulate sending a response message
        await transport.sendMessage({
          chatId: request.chatId,
          type: 'text',
          text: `Processed: ${request.message}`,
        });
        return { success: true, taskId: request.taskId };
      });

      // Send task
      const request: TaskRequest = {
        taskId: 'test-1',
        chatId: 'chat-1',
        message: 'Hello',
        messageId: 'msg-1',
      };
      const response = await transport.sendTask(request);

      expect(response.success).toBe(true);
      expect(processedTasks).toHaveLength(1);
      expect(processedTasks[0]).toEqual(request);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].text).toBe('Processed: Hello');
    });
  });
});
