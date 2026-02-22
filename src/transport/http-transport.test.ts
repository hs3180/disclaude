/**
 * Tests for HttpTransport.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpTransport } from './http-transport.js';
import type { TaskRequest, TaskResponse, MessageContent, ControlCommand, ControlResponse } from './types.js';

describe('HttpTransport', () => {
  describe('Communication Mode (Server)', () => {
    let transport: HttpTransport;

    beforeEach(() => {
      transport = new HttpTransport({
        mode: 'communication',
        port: 3201, // Use non-standard port for tests
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

    it('should register task handler', () => {
      const handler = vi.fn().mockResolvedValue({
        success: true,
        taskId: 'test-1',
      }) as (request: TaskRequest) => Promise<TaskResponse>;
      transport.onTask(handler);
      // Handler registered without error
    });

    it('should register message handler', () => {
      const handler = vi.fn() as (content: MessageContent) => Promise<void>;
      transport.onMessage(handler);
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

    it('should handle messages via registered handler', async () => {
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

    it('should handle control commands via registered handler', async () => {
      const handler = vi.fn().mockResolvedValue({
        success: true,
        type: 'reset',
      }) as (command: ControlCommand) => Promise<ControlResponse>;
      transport.onControl(handler);

      const command: ControlCommand = {
        type: 'reset',
        chatId: 'chat-1',
      };

      const response = await transport.sendControl(command);
      expect(response.success).toBe(true);
      expect(handler).toHaveBeenCalledWith(command);
    });

    it('should return error for sendTask in HTTP mode', async () => {
      await transport.start();
      const request: TaskRequest = {
        taskId: 'test-1',
        chatId: 'chat-1',
        message: 'Hello',
        messageId: 'msg-1',
      };
      const response = await transport.sendTask(request);
      expect(response.success).toBe(false);
      expect(response.error).toContain('not applicable');
    });
  });

  describe('Execution Mode (Client)', () => {
    let transport: HttpTransport;

    beforeEach(() => {
      transport = new HttpTransport({
        mode: 'execution',
        communicationUrl: 'http://localhost:3201',
      });
    });

    afterEach(async () => {
      await transport.stop();
    });

    it('should be created with execution mode', () => {
      expect(transport).toBeDefined();
    });

    it('should start without server (client only)', async () => {
      await transport.start();
      expect(transport.isRunning()).toBe(true);
    });

    it('should throw error when sending message without communication URL', async () => {
      const noUrlTransport = new HttpTransport({
        mode: 'execution',
      });
      await noUrlTransport.start();

      const content: MessageContent = {
        chatId: 'chat-1',
        type: 'text',
        text: 'Hello',
      };
      await expect(noUrlTransport.sendMessage(content)).rejects.toThrow('Communication URL not configured');

      await noUrlTransport.stop();
    });

    it('should return error for sendControl without communication URL', async () => {
      const noUrlTransport = new HttpTransport({
        mode: 'execution',
      });
      await noUrlTransport.start();

      const command: ControlCommand = {
        type: 'reset',
        chatId: 'chat-1',
      };
      const response = await noUrlTransport.sendControl(command);
      expect(response.success).toBe(false);
      expect(response.error).toContain('Communication URL not configured');

      await noUrlTransport.stop();
    });
  });

  describe('HTTP Server', () => {
    let transport: HttpTransport;
    let testPort: number;

    beforeEach(async () => {
      // Use unique port for each test
      testPort = 3110 + Math.floor(Math.random() * 100);
      transport = new HttpTransport({
        mode: 'communication',
        port: testPort,
      });
      await transport.start();
    });

    afterEach(async () => {
      await transport.stop();
    });

    it('should respond to health check', async () => {
      const response = await fetch(`http://localhost:${testPort}/health`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.status).toBe('ok');
      expect(data.mode).toBe('communication');
    });

    it('should return 404 for unknown paths', async () => {
      const response = await fetch(`http://localhost:${testPort}/unknown`);
      expect(response.status).toBe(404);
    });

    it('should handle task request', async () => {
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

    it('should handle callback request', async () => {
      // Register message handler
      const handler = vi.fn() as (content: MessageContent) => Promise<void>;
      transport.onMessage(handler);

      const response = await fetch(`http://localhost:${testPort}/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: 'chat-1',
          type: 'text',
          text: 'Hello from Execution Node',
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });

    it('should handle control request', async () => {
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
    const authToken = 'test-secret-token';
    let testPort: number;
    let transport: HttpTransport;

    beforeEach(async () => {
      testPort = 3220 + Math.floor(Math.random() * 100);
    });

    afterEach(async () => {
      if (transport) {
        await transport.stop();
      }
    });

    it('should reject requests without auth token when configured', async () => {
      transport = new HttpTransport({
        mode: 'communication',
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
    });

    it('should accept requests with correct auth token', async () => {
      transport = new HttpTransport({
        mode: 'communication',
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
    });
  });
});
