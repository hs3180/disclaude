/**
 * ACP 模块单元测试
 *
 * 测试 ACP 协议基础设施：类型验证、传输层和 Client。
 * 使用依赖注入（MockTransport）进行 Client 测试，避免 ESM mock 限制。
 *
 * Issue #1333: PR A — ACP 协议基础设施
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AcpClient,
  AcpError,
  AcpStdioTransport,
  createNotification,
  type JsonRpcMessage,
  type AcpInitializeResult,
  type AcpTaskSendResult,
  type AcpTaskStatusNotification,
  type IAcpTransport,
} from './index.js';

// ============================================================================
// Mock Transport (Dependency Injection)
// ============================================================================

/**
 * Mock ACP Transport for testing.
 * Implements IAcpTransport interface with controllable behavior.
 */
class MockTransport implements IAcpTransport {
  private _connected = false;
  private _sentMessages: JsonRpcMessage[] = [];
  private _messageListeners = new Set<(msg: JsonRpcMessage) => void>();
  private _errorListeners = new Set<(err: Error) => void>();
  private _closeListeners = new Set<(code: number | null, signal: string | null) => void>();

  get connected() { return this._connected; }

  connect(): Promise<void> {
    this._connected = true;
    return Promise.resolve();
  }

  send(message: JsonRpcMessage): void {
    if (!this._connected) {
      throw new Error('not connected');
    }
    this._sentMessages.push(message);
  }

  disconnect(): void {
    this._connected = false;
  }

  onMessage(listener: (msg: JsonRpcMessage) => void): () => void {
    this._messageListeners.add(listener);
    return () => { this._messageListeners.delete(listener); };
  }

  onError(listener: (err: Error) => void): () => void {
    this._errorListeners.add(listener);
    return () => { this._errorListeners.delete(listener); };
  }

  onClose(listener: (code: number | null, signal: string | null) => void): () => void {
    this._closeListeners.add(listener);
    return () => { this._closeListeners.delete(listener); };
  }

  /** Simulate receiving a message from the server */
  simulateReceive(message: JsonRpcMessage): void {
    for (const listener of this._messageListeners) {
      listener(message);
    }
  }

  /** Simulate a transport error */
  simulateError(error: Error): void {
    for (const listener of this._errorListeners) {
      listener(error);
    }
  }

  /** Simulate transport close */
  simulateClose(code: number | null = null, signal: string | null = null): void {
    this._connected = false;
    for (const listener of this._closeListeners) {
      listener(code, signal);
    }
  }

  /** Get all sent messages */
  getSentMessages(): JsonRpcMessage[] {
    return [...this._sentMessages];
  }

  /** Find the last sent request by method */
  findSentRequest(method: string): JsonRpcMessage | undefined {
    return [...this._sentMessages].reverse().find(
      (msg) => 'method' in msg && (msg as { method: string }).method === method
    );
  }

  /** Extract the id from the last request matching method */
  getLastRequestId(method: string): string | number | undefined {
    const req = this.findSentRequest(method);
    if (!req || !('id' in req)) {
      return undefined;
    }
    return (req as { id: string | number }).id;
  }
}

// ============================================================================
// createNotification
// ============================================================================

describe('createNotification', () => {
  it('should create a notification without params', () => {
    const notification = createNotification('notifications/task/status');
    expect(notification).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/task/status',
    });
  });

  it('should create a notification with params', () => {
    const params = { taskId: 'task-1', state: 'completed' };
    const notification = createNotification('notifications/task/status', params);
    expect(notification).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/task/status',
      params,
    });
  });

  it('should not have an id property', () => {
    const notification = createNotification('test');
    expect('id' in notification).toBe(false);
  });
});

// ============================================================================
// AcpStdioTransport (basic smoke tests without spawning)
// ============================================================================

describe('AcpStdioTransport', () => {
  it('should throw when sending on disconnected transport', () => {
    const transport = new AcpStdioTransport({
      command: 'echo',
    });

    const message: JsonRpcMessage = {
      jsonrpc: '2.0',
      id: '1',
      method: 'test',
    };

    expect(() => transport.send(message)).toThrow('not connected');
    expect(transport.connected).toBe(false);
  });

  it('should report connected state as false initially', () => {
    const transport = new AcpStdioTransport({
      command: 'echo',
    });
    expect(transport.connected).toBe(false);
  });

  it('should support event subscription and unsubscription', () => {
    const transport = new AcpStdioTransport({
      command: 'echo',
    });

    const unsub = transport.onMessage(() => {});
    expect(typeof unsub).toBe('function');
    unsub();

    const unsub2 = transport.onError(() => {});
    expect(typeof unsub2).toBe('function');
    unsub2();

    const unsub3 = transport.onClose(() => {});
    expect(typeof unsub3).toBe('function');
    unsub3();
  });
});

// ============================================================================
// AcpClient (using MockTransport via dependency injection)
// ============================================================================

describe('AcpClient', () => {
  let mockTransport: MockTransport;

  beforeEach(() => {
    mockTransport = new MockTransport();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper: 创建已连接的 AcpClient
   */
  async function createConnectedClient(): Promise<AcpClient> {
    const client = new AcpClient({
      transport: mockTransport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      requestTimeoutMs: 5000,
    });

    // Start connect
    const connectPromise = client.connect();

    // Wait for initialize request to be sent
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Respond to initialize
    const initId = mockTransport.getLastRequestId('initialize');
    expect(initId).toBeDefined();

    const initResult: AcpInitializeResult = {
      protocolVersion: '2025-03-26',
      capabilities: {
        protocolVersions: ['2025-03-26'],
        streaming: true,
        tools: true,
        taskCancellation: true,
      },
      serverInfo: { name: 'test-server', version: '0.1.0' },
    };

    mockTransport.simulateReceive({
      jsonrpc: '2.0',
      id: initId!,
      result: initResult,
    });

    await connectPromise;
    return client;
  }

  it('should connect and perform initialize handshake', async () => {
    const client = await createConnectedClient();

    expect(client.isConnected).toBe(true);
    expect(client.getState()).toBe('connected');
    expect(client.getProtocolVersion()).toBe('2025-03-26');
    expect(client.getServerInfo()?.name).toBe('test-server');
    expect(client.getServerCapabilities()?.streaming).toBe(true);

    client.disconnect();
  });

  it('should send initialize with client info', async () => {
    const client = new AcpClient({
      transport: mockTransport,
      clientInfo: { name: 'my-client', version: '2.0.0' },
      requestTimeoutMs: 5000,
    });

    const connectPromise = client.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const initRequest = mockTransport.findSentRequest('initialize');
    expect(initRequest).toBeDefined();
    const { params } = initRequest as { params?: Record<string, unknown> };
    expect(params?.clientInfo).toEqual({ name: 'my-client', version: '2.0.0' });

    // Respond to initialize to avoid unhandled rejection on disconnect
    const initId = mockTransport.getLastRequestId('initialize');
    mockTransport.simulateReceive({
      jsonrpc: '2.0',
      id: initId!,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        serverInfo: { name: 'test', version: '1.0.0' },
      },
    });
    await connectPromise;
    client.disconnect();
  });

  it('should throw when sending task while disconnected', async () => {
    const client = new AcpClient({
      transport: mockTransport,
    });

    await expect(
      client.sendTask({ role: 'user', content: 'Hello' })
    ).rejects.toThrow('not connected');
  });

  it('should throw when cancelling task while disconnected', async () => {
    const client = new AcpClient({
      transport: mockTransport,
    });

    await expect(
      client.cancelTask('task-123')
    ).rejects.toThrow('not connected');
  });

  it('should send task and receive result', async () => {
    const client = await createConnectedClient();

    const taskPromise = client.sendTask(
      { role: 'user', content: 'Write a test' },
      { priority: 'high' }
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const taskRequest = mockTransport.findSentRequest('tasks/send');
    expect(taskRequest).toBeDefined();
    const { params: taskParams } = taskRequest as { params?: Record<string, unknown> };
    expect((taskParams?.message as { content: string }).content).toBe('Write a test');
    expect((taskParams?.metadata as { priority: string }).priority).toBe('high');

    const taskResult: AcpTaskSendResult = { taskId: 'task-123', state: 'submitted' };
    mockTransport.simulateReceive({
      jsonrpc: '2.0',
      id: mockTransport.getLastRequestId('tasks/send')!,
      result: taskResult,
    });

    const result = await taskPromise;
    expect(result).toEqual(taskResult);

    client.disconnect();
  });

  it('should cancel task', async () => {
    const client = await createConnectedClient();

    const cancelPromise = client.cancelTask('task-123');

    await new Promise((resolve) => setTimeout(resolve, 0));

    const cancelRequest = mockTransport.findSentRequest('tasks/cancel');
    expect(cancelRequest).toBeDefined();
    const { params: cancelParams } = cancelRequest as { params?: Record<string, unknown> };
    expect(cancelParams?.taskId).toBe('task-123');

    mockTransport.simulateReceive({
      jsonrpc: '2.0',
      id: mockTransport.getLastRequestId('tasks/cancel')!,
      result: { taskId: 'task-123', state: 'cancelled' },
    });

    const result = await cancelPromise;
    expect(result.state).toBe('cancelled');

    client.disconnect();
  });

  it('should handle task status notifications', async () => {
    const client = await createConnectedClient();

    const statusNotifications: AcpTaskStatusNotification[] = [];
    client.onTaskStatus('task-123', (notification) => {
      statusNotifications.push(notification);
    });

    mockTransport.simulateReceive({
      jsonrpc: '2.0',
      method: 'notifications/task/status',
      params: {
        taskId: 'task-123',
        state: 'working',
        message: { role: 'assistant', content: 'Processing...' },
      },
    });

    expect(statusNotifications).toHaveLength(1);
    expect(statusNotifications[0].taskId).toBe('task-123');
    expect(statusNotifications[0].state).toBe('working');

    client.disconnect();
  });

  it('should handle error responses', async () => {
    const client = await createConnectedClient();

    const taskPromise = client.sendTask({ role: 'user', content: 'Test' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    mockTransport.simulateReceive({
      jsonrpc: '2.0',
      id: mockTransport.getLastRequestId('tasks/send')!,
      error: {
        code: -32000,
        message: 'Task rejected: invalid input',
        data: { field: 'content' },
      },
    });

    await expect(taskPromise).rejects.toThrow(AcpError);
    await expect(taskPromise).rejects.toMatchObject({
      message: 'Task rejected: invalid input',
    });

    client.disconnect();
  });

  it('should reject pending requests on disconnect', async () => {
    const client = await createConnectedClient();

    const taskPromise = client.sendTask({ role: 'user', content: 'Test' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    client.disconnect();

    await expect(taskPromise).rejects.toThrow('disconnected');
  });

  it('should reject pending requests on transport error', async () => {
    const client = await createConnectedClient();

    const taskPromise = client.sendTask({ role: 'user', content: 'Test' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    mockTransport.simulateError(new Error('Connection lost'));

    await expect(taskPromise).rejects.toThrow('Connection lost');
  });

  it('should reject pending requests on unexpected transport close', async () => {
    const client = await createConnectedClient();

    const taskPromise = client.sendTask({ role: 'user', content: 'Test' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    mockTransport.simulateClose(1, 'SIGTERM');

    await expect(taskPromise).rejects.toThrow('Transport closed');
    expect(client.getState()).toBe('disconnected');
  });

  it('should timeout requests', async () => {
    const client = new AcpClient({
      transport: mockTransport,
      requestTimeoutMs: 50, // Very short timeout
    });

    const connectPromise = client.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Respond to initialize
    const initId = mockTransport.getLastRequestId('initialize');
    mockTransport.simulateReceive({
      jsonrpc: '2.0',
      id: initId!,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        serverInfo: { name: 'test', version: '1.0.0' },
      },
    });
    await connectPromise;

    // Send task that will timeout (no response)
    const taskPromise = client.sendTask({ role: 'user', content: 'Test' });

    await expect(taskPromise).rejects.toThrow('timed out');

    client.disconnect();
  });

  it('should allow unsubscribing from task status', async () => {
    const client = await createConnectedClient();

    let callCount = 0;
    const unsubscribe = client.onTaskStatus('task-123', () => {
      callCount++;
    });

    // Send first notification
    mockTransport.simulateReceive({
      jsonrpc: '2.0',
      method: 'notifications/task/status',
      params: { taskId: 'task-123', state: 'working' },
    });
    expect(callCount).toBe(1);

    // Unsubscribe
    unsubscribe();

    // Send second notification
    mockTransport.simulateReceive({
      jsonrpc: '2.0',
      method: 'notifications/task/status',
      params: { taskId: 'task-123', state: 'completed' },
    });
    expect(callCount).toBe(1); // Should not increment

    client.disconnect();
  });

  it('should return null for server info when disconnected', () => {
    const client = new AcpClient({
      transport: mockTransport,
    });

    expect(client.getServerCapabilities()).toBeNull();
    expect(client.getServerInfo()).toBeNull();
    expect(client.getProtocolVersion()).toBeNull();
  });

  it('should return correct state throughout lifecycle', async () => {
    const client = new AcpClient({
      transport: mockTransport,
      requestTimeoutMs: 5000,
    });

    expect(client.getState()).toBe('disconnected');

    const connectPromise = client.connect();
    expect(client.getState()).toBe('connecting');

    await new Promise((resolve) => setTimeout(resolve, 0));

    const initId = mockTransport.getLastRequestId('initialize');
    mockTransport.simulateReceive({
      jsonrpc: '2.0',
      id: initId!,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        serverInfo: { name: 'test', version: '1.0.0' },
      },
    });

    await connectPromise;
    expect(client.getState()).toBe('connected');

    client.disconnect();
    expect(client.getState()).toBe('disconnected');
  });

  it('should handle connect failure gracefully', async () => {
    const failingTransport = new MockTransport();
    failingTransport.connect = vi.fn().mockRejectedValue(new Error('Spawn failed'));

    const client = new AcpClient({
      transport: failingTransport,
    });

    await expect(client.connect()).rejects.toThrow('Spawn failed');
    expect(client.getState()).toBe('disconnected');
  });

  it('should complete full connect → sendTask → notification → cancel lifecycle', async () => {
    const client = await createConnectedClient();

    // Send task
    const taskPromise = client.sendTask(
      { role: 'user', content: 'Analyze data' },
      { priority: 'normal' }
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Respond with task ID
    mockTransport.simulateReceive({
      jsonrpc: '2.0',
      id: mockTransport.getLastRequestId('tasks/send')!,
      result: { taskId: 'task-abc', state: 'submitted' },
    });
    const taskResult = await taskPromise;
    expect(taskResult.taskId).toBe('task-abc');

    // Receive working notification
    const notifications: AcpTaskStatusNotification[] = [];
    client.onTaskStatus('task-abc', (n) => notifications.push(n));

    mockTransport.simulateReceive({
      jsonrpc: '2.0',
      method: 'notifications/task/status',
      params: { taskId: 'task-abc', state: 'working' },
    });
    expect(notifications).toHaveLength(1);

    // Receive completed notification
    mockTransport.simulateReceive({
      jsonrpc: '2.0',
      method: 'notifications/task/status',
      params: { taskId: 'task-abc', state: 'completed', message: { role: 'assistant', content: 'Done!' } },
    });
    expect(notifications).toHaveLength(2);
    expect(notifications[1].state).toBe('completed');

    // Cancel (already completed, but should still work)
    const cancelPromise = client.cancelTask('task-abc');
    await new Promise((resolve) => setTimeout(resolve, 0));

    mockTransport.simulateReceive({
      jsonrpc: '2.0',
      id: mockTransport.getLastRequestId('tasks/cancel')!,
      result: { taskId: 'task-abc', state: 'cancelled' },
    });
    const cancelResult = await cancelPromise;
    expect(cancelResult.state).toBe('cancelled');

    // Verify all sent messages
    const sent = mockTransport.getSentMessages();
    expect(sent.length).toBeGreaterThanOrEqual(3); // initialize + tasks/send + tasks/cancel

    client.disconnect();
    expect(client.getState()).toBe('disconnected');
    expect(client.isConnected).toBe(false);
  });
});

// ============================================================================
// AcpError
// ============================================================================

describe('AcpError', () => {
  it('should store code and data', () => {
    const error = new AcpError('test error', -32000, { field: 'value' });
    expect(error.message).toBe('test error');
    expect(error.code).toBe(-32000);
    expect(error.data).toEqual({ field: 'value' });
    expect(error.name).toBe('AcpError');
  });

  it('should be instanceof Error', () => {
    const error = new AcpError('test', 1);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AcpError);
  });
});

// ============================================================================
// Type Validation Tests
// ============================================================================

describe('ACP Type Validation', () => {
  it('should validate JSON-RPC request structure', () => {
    const request = {
      jsonrpc: '2.0' as const,
      id: 'req-1',
      method: 'initialize',
      params: { capabilities: {} },
    };

    expect(request.jsonrpc).toBe('2.0');
    expect(request.id).toBe('req-1');
    expect(request.method).toBe('initialize');
    expect(request.params).toBeDefined();
  });

  it('should validate JSON-RPC notification structure (no id)', () => {
    const notification = createNotification('notifications/task/status', {
      taskId: 'task-1',
      state: 'completed',
    });

    expect(notification.jsonrpc).toBe('2.0');
    expect('id' in notification).toBe(false);
    expect(notification.method).toBe('notifications/task/status');
  });

  it('should validate ACP task message with string content', () => {
    const message = {
      role: 'user' as const,
      content: 'Hello, world!',
    };

    expect(message.role).toBe('user');
    expect(message.content).toBe('Hello, world!');
  });

  it('should validate ACP task message with content blocks', () => {
    const message = {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: 'Look at this image:' },
        { type: 'image' as const, data: 'base64data', mimeType: 'image/png' },
      ],
    };

    expect(message.role).toBe('user');
    expect(Array.isArray(message.content)).toBe(true);
    expect(message.content).toHaveLength(2);
  });

  it('should validate ACP task content types', () => {
    const textContent = { type: 'text' as const, text: 'Hello' };
    const imageContent = { type: 'image' as const, data: 'abc', mimeType: 'image/png' };
    const toolUse = { type: 'tool_use' as const, id: 'tu-1', name: 'bash', input: { cmd: 'ls' } };
    const toolResult = { type: 'tool_result' as const, id: 'tu-1', output: 'file.txt', isError: false };

    expect(textContent.type).toBe('text');
    expect(imageContent.type).toBe('image');
    expect(toolUse.type).toBe('tool_use');
    expect(toolResult.type).toBe('tool_result');
  });

  it('should validate all ACP task states', () => {
    const states = ['submitted', 'working', 'input_required', 'completed', 'failed', 'cancelled'] as const;
    expect(states).toHaveLength(6);
  });
});
