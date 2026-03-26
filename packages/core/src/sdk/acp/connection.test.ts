/**
 * Unit tests for ACP Connection Manager
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AcpConnection } from './connection.js';
import type { JsonRpcNotification } from './json-rpc.js';

describe('AcpConnection', () => {
  let connection: AcpConnection;

  beforeEach(() => {
    connection = new AcpConnection({ responseTimeoutMs: 1000 });
  });

  afterEach(() => {
    connection.dispose();
  });

  describe('initial state', () => {
    it('should start in disconnected state', () => {
      expect(connection.getState()).toBe('disconnected');
    });
  });

  describe('connectStdio', () => {
    it('should transition to connecting then connected', async () => {
      // Use 'echo' as a simple process that reads from stdin and writes to stdout
      await connection.connectStdio({ command: 'cat' });
      expect(connection.getState()).toBe('connected');
    });

    it('should reject if already connected', async () => {
      await connection.connectStdio({ command: 'cat' });
      await expect(connection.connectStdio({ command: 'cat' })).rejects.toThrow('Cannot connect');
    });

    it('should reject on invalid command', async () => {
      await expect(
        connection.connectStdio({ command: 'nonexistent_command_xyz_123' })
      ).rejects.toThrow();
    });

    it('should emit state change events', async () => {
      const events: string[] = [];
      connection.on('connecting', () => events.push('connecting'));
      connection.on('connected', () => events.push('connected'));

      await connection.connectStdio({ command: 'cat' });

      expect(events).toContain('connecting');
      expect(events).toContain('connected');
    });
  });

  describe('sendRequest', () => {
    it('should reject if not connected', () => {
      expect(() => {
        connection.sendRequest({ jsonrpc: '2.0', method: 'test', id: 1 });
      }).toThrow('Cannot send');
    });

    it('should reject request without id', async () => {
      await connection.connectStdio({ command: 'cat' });
      expect(() => {
        connection.sendRequest({ jsonrpc: '2.0', method: 'test' });
      }).toThrow('must have an id');
    });

    it('should timeout on no response', async () => {
      // Use 'cat' which echoes back but doesn't send valid JSON-RPC responses
      await connection.connectStdio({ command: 'cat' });
      await expect(
        connection.sendRequest({ jsonrpc: '2.0', method: 'test', id: 'timeout-test' })
      ).rejects.toThrow('timeout');
    });
  });

  describe('sendNotification', () => {
    it('should reject if not connected', () => {
      expect(() => {
        connection.sendNotification({ jsonrpc: '2.0', method: 'test' });
      }).toThrow('Cannot send');
    });

    it('should not throw when connected (fire-and-forget)', async () => {
      await connection.connectStdio({ command: 'cat' });
      expect(() => {
        connection.sendNotification({
          jsonrpc: '2.0',
          method: 'notifications/test',
          params: { key: 'value' },
        });
      }).not.toThrow();
    });
  });

  describe('onNotification', () => {
    it('should receive parsed notifications', async () => {
      const receivedNotifications: JsonRpcNotification[] = [];

      await connection.connectStdio({ command: 'cat' });
      connection.onNotification((notif) => {
        receivedNotifications.push(notif);
      });

      // Simulate server sending a notification
      // We use the protected method via casting to inject data
      const notifStr = JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/task/message',
        params: { taskId: 'test-123', message: { role: 'assistant', content: 'hello' } },
      });

      // Access protected method for testing
      // Note: handleData expects newline-delimited JSON, so append newline
      (connection as unknown as { handleExternalData: (data: string) => void }).handleExternalData(`${notifStr  }\n`);

      expect(receivedNotifications).toHaveLength(1);
      expect(receivedNotifications[0].method).toBe('notifications/task/message');
    });
  });

  describe('disconnect', () => {
    it('should transition to disconnected', async () => {
      await connection.connectStdio({ command: 'cat' });
      expect(connection.getState()).toBe('connected');

      connection.disconnect();
      expect(connection.getState()).toBe('disconnected');
    });

    it('should reject pending requests on disconnect', async () => {
      await connection.connectStdio({ command: 'cat' });

      const requestPromise = connection.sendRequest({
        jsonrpc: '2.0',
        method: 'slow-task',
        id: 'pending-test',
      });

      // Disconnect before response
      connection.disconnect();

      await expect(requestPromise).rejects.toThrow('Connection closed');
    });
  });

  describe('dispose', () => {
    it('should clean up all resources', async () => {
      await connection.connectStdio({ command: 'cat' });
      connection.dispose();
      expect(connection.getState()).toBe('disconnected');
    });
  });
});
