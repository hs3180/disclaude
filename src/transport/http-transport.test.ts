/**
 * Tests for HttpTransport.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpTransport } from './http-transport.js';
import type { TaskRequest, TaskResponse, MessageContent, ControlCommand, ControlResponse } from './types.js';

describe('HttpTransport', () => {
  describe('Execution Mode', () => {
    let transport: HttpTransport;

    beforeEach(() => {
      transport = new HttpTransport({
        mode: 'execution',
        port: 3101, // Use non-standard port for tests
      });
    });

    afterEach(async () => {
      await transport.stop();
    });

    it('should be created with execution mode', () => {
      expect(transport).toBeDefined();
    });

    it('should start and stop successfully', async () => {
      await transport.start();
      expect(transport.isRunning()).toBe(true);

      await transport.stop();
      expect(transport.isRunning()).toBe(false);
    });

    it('should register task handler', () => {
      const handler = vi.fn().mockResolvedValue({
        success: true,
        taskId: 'test-1',
      }) as (request: TaskRequest) => Promise<TaskResponse>;
      transport.onTask(handler);
      // Handler registered without error
    });

    it('should register control handler', () => {
      const handler = vi.fn().mockResolvedValue({
        success: true,
        type: 'reset',
      }) as (command: ControlCommand) => Promise<ControlResponse>;
      transport.onControl(handler);
      // Handler registered without error
    });

    it('should warn on sendMessage in execution mode without handler', async () => {
      await transport.start();
      const content: MessageContent = {
        chatId: 'chat-1',
        type: 'text',
        text: 'Hello',
      };
      // Should not throw, just warn
      await expect(transport.sendMessage(content)).resolves.toBeUndefined();
    });

    it('should return error for sendTask in execution mode', async () => {
      await transport.start();
      const request: TaskRequest = {
        taskId: 'test-1',
        chatId: 'chat-1',
        message: 'Hello',
        messageId: 'msg-1',
      };
      const response = await transport.sendTask(request);
      expect(response.success).toBe(false);
      expect(response.error).toContain('not available in execution mode');
    });

    it('should return error for sendControl in execution mode', async () => {
      await transport.start();
      const command: ControlCommand = {
        type: 'reset',
        chatId: 'chat-1',
      };
      const response = await transport.sendControl(command);
      expect(response.success).toBe(false);
      expect(response.error).toContain('not available in execution mode');
    });
  });

  describe('Communication Mode', () => {
    let transport: HttpTransport;

    beforeEach(() => {
      transport = new HttpTransport({
        mode: 'communication',
        executionUrl: 'http://localhost:3101',
        callbackPort: 3102,
      });
    });

    afterEach(async () => {
      await transport.stop();
    });

    it('should be created with communication mode', () => {
      expect(transport).toBeDefined();
    });

    it('should start and stop successfully', async () => {
      await transport.start();
      expect(transport.isRunning()).toBe(true);

      await transport.stop();
      expect(transport.isRunning()).toBe(false);
    });

    it('should register message handler', () => {
      const handler = vi.fn() as (content: MessageContent) => Promise<void>;
      transport.onMessage(handler);
      // Handler registered without error
    });

    it('should return error for sendTask without execution URL', async () => {
      const noUrlTransport = new HttpTransport({
        mode: 'communication',
        callbackPort: 3103,
      });
      await noUrlTransport.start();

      const request: TaskRequest = {
        taskId: 'test-1',
        chatId: 'chat-1',
        message: 'Hello',
        messageId: 'msg-1',
      };
      const response = await noUrlTransport.sendTask(request);
      expect(response.success).toBe(false);
      expect(response.error).toContain('Execution URL not configured');

      await noUrlTransport.stop();
    });
  });

  describe('HTTP Server', () => {
    let transport: HttpTransport;
    const testPort = 3111;

    beforeEach(() => {
      transport = new HttpTransport({
        mode: 'execution',
        port: testPort,
      });
    });

    afterEach(async () => {
      await transport.stop();
    });

    it('should respond to health check', async () => {
      await transport.start();

      const response = await fetch(`http://localhost:${testPort}/health`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.status).toBe('ok');
      expect(data.mode).toBe('execution');
    });

    it('should return 404 for unknown paths', async () => {
      await transport.start();

      const response = await fetch(`http://localhost:${testPort}/unknown`);
      expect(response.status).toBe(404);
    });

    it('should handle task request', async () => {
      await transport.start();

      // Register handler
      transport.onTask(async (request) => ({
        success: true,
        taskId: request.taskId,
      }));

      const response = await fetch(`http://localhost:${testPort}/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: 'test-1',
          chatId: 'chat-1',
          message: 'Hello',
          messageId: 'msg-1',
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.taskId).toBe('test-1');
    });

    it('should handle control request', async () => {
      await transport.start();

      // Register handler
      transport.onControl(async (command) => ({
        success: true,
        type: command.type,
      }));

      const response = await fetch(`http://localhost:${testPort}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'reset',
          chatId: 'chat-1',
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.type).toBe('reset');
    });

    it('should return 500 when no task handler registered', async () => {
      await transport.start();

      const response = await fetch(`http://localhost:${testPort}/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: 'test-1',
          chatId: 'chat-1',
          message: 'Hello',
          messageId: 'msg-1',
        }),
      });

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error).toContain('No task handler registered');
    });
  });

  describe('Authentication', () => {
    const testPort = 3121;
    const authToken = 'test-secret-token';

    it('should reject requests without auth token when configured', async () => {
      const transport = new HttpTransport({
        mode: 'execution',
        port: testPort,
        authToken,
      });

      await transport.start();

      const response = await fetch(`http://localhost:${testPort}/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: 'test-1',
          chatId: 'chat-1',
          message: 'Hello',
          messageId: 'msg-1',
        }),
      });

      expect(response.status).toBe(401);

      await transport.stop();
    });

    it('should accept requests with correct auth token', async () => {
      const transport = new HttpTransport({
        mode: 'execution',
        port: testPort,
        authToken,
      });

      transport.onTask(async (request) => ({
        success: true,
        taskId: request.taskId,
      }));

      await transport.start();

      const response = await fetch(`http://localhost:${testPort}/task`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          taskId: 'test-1',
          chatId: 'chat-1',
          message: 'Hello',
          messageId: 'msg-1',
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      await transport.stop();
    });
  });
});
