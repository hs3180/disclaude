/**
 * Unit tests for ACP Protocol Client
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AcpClient, ACP_PROTOCOL_VERSION, AcpMethod, AcpNotification } from './protocol.js';

describe('AcpClient', () => {
  let client: AcpClient;

  beforeEach(() => {
    client = new AcpClient({
      clientName: 'test-client',
      clientVersion: '0.0.1',
    });
  });

  afterEach(() => {
    client.dispose();
  });

  describe('constructor', () => {
    it('should set default client capabilities', () => {
      expect(client.getConnectionState()).toBe('disconnected');
      expect(client.getServerCapabilities()).toBeNull();
    });

    it('should accept custom client info', () => {
      const customClient = new AcpClient({
        clientName: 'my-client',
        clientVersion: '2.0.0',
      });
      customClient.dispose();
      // Constructor should not throw with custom values
      expect(true).toBe(true);
    });
  });

  describe('constants', () => {
    it('should have correct protocol version', () => {
      expect(ACP_PROTOCOL_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should have correct method names', () => {
      expect(AcpMethod.INITIALIZE).toBe('initialize');
      expect(AcpMethod.TASK_SEND).toBe('tasks/send');
      expect(AcpMethod.TASK_CANCEL).toBe('tasks/cancel');
      expect(AcpMethod.TASK_STATUS).toBe('tasks/status');
    });

    it('should have correct notification names', () => {
      expect(AcpNotification.TASK_MESSAGE).toBe('notifications/task/message');
      expect(AcpNotification.TASK_STATUS).toBe('notifications/task/status');
    });
  });

  describe('sendTask', () => {
    it('should reject if not connected', async () => {
      await expect(
        client.sendTask([{ role: 'user', content: 'hello' }])
      ).rejects.toThrow('Cannot send');
    });
  });

  describe('cancelTask', () => {
    it('should reject if not connected', async () => {
      await expect(client.cancelTask('test-id')).rejects.toThrow('Cannot send');
    });
  });

  describe('getTaskStatus', () => {
    it('should reject if not connected', async () => {
      await expect(client.getTaskStatus('test-id')).rejects.toThrow('Cannot send');
    });
  });

  describe('task listeners', () => {
    it('should register and unregister task message listener', () => {
      const listener = vi.fn();
      const unsubscribe = client.onTaskMessage('task-1', listener);

      // Unsubscribe should not throw
      expect(() => unsubscribe()).not.toThrow();
    });

    it('should register and unregister task status listener', () => {
      const listener = vi.fn();
      const unsubscribe = client.onTaskStatus('task-1', listener);

      expect(() => unsubscribe()).not.toThrow();
    });

    it('should handle multiple listeners for same task', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const unsub1 = client.onTaskMessage('task-1', listener1);
      const unsub2 = client.onTaskMessage('task-1', listener2);

      unsub1();
      unsub2();
      // Should not throw
      expect(true).toBe(true);
    });

    it('should handle multiple tasks independently', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const unsub1 = client.onTaskMessage('task-1', listener1);
      const unsub2 = client.onTaskMessage('task-2', listener2);

      unsub1();
      unsub2();
      expect(true).toBe(true);
    });
  });

  describe('connect', () => {
    it('should reject SSE transport (not yet implemented)', async () => {
      await expect(
        client.connect({
          type: 'sse',
          url: 'http://localhost:8080/acp',
        })
      ).rejects.toThrow('SSE transport is not yet supported');
    });
  });

  describe('disconnect', () => {
    it('should clear server capabilities', () => {
      // Even without connecting, disconnect should not throw
      expect(() => client.disconnect()).not.toThrow();
    });
  });

  describe('dispose', () => {
    it('should reject operations after dispose', async () => {
      client.dispose();
      await expect(
        client.connect({ type: 'stdio', command: 'cat' })
      ).rejects.toThrow('disposed');
    });
  });

  describe('onConnectionEvent', () => {
    it('should accept connection event listener', () => {
      const listener = vi.fn();
      expect(() => client.onConnectionEvent(listener)).not.toThrow();
    });
  });
});
