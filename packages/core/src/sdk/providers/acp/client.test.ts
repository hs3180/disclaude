/**
 * ACP 客户端单元测试
 *
 * 使用依赖注入模式测试客户端逻辑，避免直接 spawn 子进程。
 *
 * @see Issue #1333 - 支持OpenAI Agent
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AcpClient } from './client.js';
import { ACP_PROTOCOL_VERSION, AcpMethod, type AcpTransportConfig } from './types.js';

describe('AcpClient', () => {
  let client: AcpClient;

  beforeEach(() => {
    // 创建一个不实际启动进程的 transport 配置
    // 客户端的 connect() 需要 transport 工作正常，我们通过模拟来测试
    const config: AcpTransportConfig = {
      type: 'stdio',
      command: 'echo', // echo 会立即退出，不会真正连接
      connectionTimeout: 1000,
    };
    client = new AcpClient(config);
  });

  afterEach(() => {
    client.disconnect();
  });

  describe('properties', () => {
    it('should have correct client info', () => {
      expect(client.clientInfo.name).toBe('disclaude');
      expect(client.clientInfo.version).toBeDefined();
    });

    it('should declare streaming capability', () => {
      expect(client.capabilities.streaming).toBe(true);
      expect(client.capabilities.pushNotifications).toBe(true);
    });

    it('should start uninitialized', () => {
      expect(client.initialized).toBe(false);
      expect(client.initializeResult).toBeNull();
    });
  });

  describe('connect', () => {
    it('should throw when transport fails to connect', async () => {
      // echo 会立即退出，导致连接失败
      await expect(client.connect()).rejects.toThrow();
      expect(client.initialized).toBe(false);
    });
  });

  describe('sendTask', () => {
    it('should throw when not initialized', async () => {
      await expect(
        client.sendTask({
          messages: [{ role: 'user', content: 'Hello' }],
        })
      ).rejects.toThrow('not initialized');
    });
  });

  describe('cancelTask', () => {
    it('should throw when not initialized', async () => {
      await expect(client.cancelTask('task-123')).rejects.toThrow('not initialized');
    });
  });

  describe('onTaskNotification', () => {
    it('should register notification callback', () => {
      const callback = vi.fn();
      client.onTaskNotification('task-123', callback);

      // 无法直接触发内部回调（需要 transport 层配合），
      // 但可以验证注册/取消注册不会抛错
      client.removeTaskNotification('task-123');
      client.onTaskNotification('task-456', callback);
      client.removeTaskNotification('task-456');
    });
  });

  describe('disconnect', () => {
    it('should not throw when disconnecting unconnected client', () => {
      expect(() => client.disconnect()).not.toThrow();
    });
  });
});

describe('AcpClient Protocol Details', () => {
  it('should use correct protocol version format', () => {
    expect(ACP_PROTOCOL_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('should use correct method names for ACP protocol', () => {
    expect(AcpMethod.Initialize).toBe('initialize');
    expect(AcpMethod.TaskSend).toBe('tasks/send');
    expect(AcpMethod.TaskCancel).toBe('tasks/cancel');
    expect(AcpMethod.TaskNotification).toBe('notifications/task');
  });
});
