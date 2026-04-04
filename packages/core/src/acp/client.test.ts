/**
 * Tests for ACP Client
 *
 * Verifies JSON-RPC message handling, request/response correlation,
 * notification dispatch, and lifecycle management.
 *
 * Issue #1333: ACP protocol infrastructure
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AcpClient } from './client.js';
import type { AcpTransport } from './transport.js';
import {
  AcpMethod,
  AcpNotification,
  type JsonRpcMessage,
  type AcpInitializeParams,
} from './types.js';

// ============================================================================
// Mock Transport
// ============================================================================

/**
 * 创建一个 mock transport 用于测试
 */
function createMockTransport(): AcpTransport & {
  sentMessages: JsonRpcMessage[];
  simulateMessage: (message: JsonRpcMessage) => void;
  simulateClose: () => void;
  simulateError: (err: Error) => void;
} {
  const sentMessages: JsonRpcMessage[] = [];
  let messageCallback: ((message: JsonRpcMessage) => void) | null = null;
  const eventHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};

  return {
    sentMessages,
    get connected() {
      return true;
    },
    send(_message: JsonRpcMessage): Promise<void> {
      sentMessages.push(_message);
      return Promise.resolve();
    },
    onMessage(callback: (message: JsonRpcMessage) => void): void {
      messageCallback = callback;
    },
    on(event: string, handler: (...args: unknown[]) => void): void {
      if (!eventHandlers[event]) {
        eventHandlers[event] = [];
      }
      eventHandlers[event].push(handler);
    },
    simulateMessage(message: JsonRpcMessage): void {
      messageCallback?.(message);
    },
    simulateClose(): void {
      eventHandlers['close']?.forEach((h) => h());
    },
    simulateError(err: Error): void {
      eventHandlers['error']?.forEach((h) => h(err));
    },
    async close(): Promise<void> {
      // no-op
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('AcpClient', () => {
  let mockTransport: ReturnType<typeof createMockTransport>;
  let client: AcpClient;

  beforeEach(() => {
    mockTransport = createMockTransport();
    // Override the transport via constructor by using a stdio config
    // then replacing the internal transport
    client = new AcpClient({
      type: 'stdio',
      command: 'echo',
    });
    // Access private transport and replace with mock
    const clientInternals = client as unknown as {
      transport: AcpTransport;
      _connected: boolean;
      handleMessage: (msg: JsonRpcMessage) => void;
    };
    clientInternals.transport = mockTransport;
    // Simulate connected state
    clientInternals._connected = true;
    // Register handleMessage on the mock transport (normally done in connect())
    mockTransport.onMessage((msg) => clientInternals.handleMessage(msg));
  });

  afterEach(async () => {
    try {
      await client.close();
    } catch {
      // ignore close errors in cleanup
    }
  });

  // ==========================================================================
  // Connection & Initialization
  // ==========================================================================

  describe('connect', () => {
    it('should send initialize request and return result', async () => {
      const initParams: AcpInitializeParams = {
        clientName: 'test-client',
        clientVersion: '1.0.0',
        capabilities: { subscriptions: true },
      };

      // Simulate successful initialize response
      const connectPromise = client.connect(initParams);

      // Find the initialize request
      const initRequest = mockTransport.sentMessages.find(
        (m: JsonRpcMessage) => 'method' in m && (m as { method: string }).method === AcpMethod.INITIALIZE
      );
      expect(initRequest).toBeDefined();

      // Simulate response
      const requestId = (initRequest as { id: number }).id;
      mockTransport.simulateMessage({
        jsonrpc: '2.0',
        id: requestId,
        result: {
          agentName: 'test-agent',
          agentVersion: '0.1.0',
          capabilities: { streaming: true, toolUse: true },
          protocolVersion: '2025-01-01',
        },
      });

      const result = await connectPromise;

      expect(result.agentName).toBe('test-agent');
      expect(result.agentVersion).toBe('0.1.0');
      expect(result.capabilities.streaming).toBe(true);
      expect(result.capabilities.toolUse).toBe(true);
      expect(result.protocolVersion).toBe('2025-01-01');
    });

    it('should set initialized state after successful connect', async () => {
      const connectPromise = client.connect({
        clientName: 'test',
        clientVersion: '1.0.0',
        capabilities: {},
      });

      const initRequest = mockTransport.sentMessages.find(
        (m: JsonRpcMessage) => 'method' in m && (m as { method: string }).method === AcpMethod.INITIALIZE
      );
      const requestId = (initRequest as { id: number }).id;
      mockTransport.simulateMessage({
        jsonrpc: '2.0',
        id: requestId,
        result: {
          agentName: 'agent',
          agentVersion: '1.0.0',
          capabilities: {},
          protocolVersion: '2025-01-01',
        },
      });

      await connectPromise;

      expect(client.initialized).toBe(true);
      expect(client.agentName).toBe('agent');
      expect(client.agentVersion).toBe('1.0.0');
      expect(client.protocolVersion).toBe('2025-01-01');
    });
  });

  // ==========================================================================
  // Task Management
  // ==========================================================================

  describe('createTask', () => {
    it('should send tasks/create request', async () => {
      const createPromise = client.createTask({ metadata: { key: 'value' } });

      const request = mockTransport.sentMessages.find(
        (m: JsonRpcMessage) => 'method' in m && (m as { method: string }).method === AcpMethod.TASK_CREATE
      );
      expect(request).toBeDefined();

      const requestId = (request as { id: number }).id;
      mockTransport.simulateMessage({
        jsonrpc: '2.0',
        id: requestId,
        result: {
          id: 'task-123',
          status: 'created',
          metadata: { key: 'value' },
        },
      });

      const result = await createPromise;
      expect(result.id).toBe('task-123');
      expect(result.status).toBe('created');
    });
  });

  describe('sendTaskMessage', () => {
    it('should send tasks/send request', async () => {
      const sendPromise = client.sendTaskMessage({
        taskId: 'task-123',
        message: {
          role: 'user',
          content: { type: 'text', text: 'Hello' },
        },
      });

      const request = mockTransport.sentMessages.find(
        (m: JsonRpcMessage) => 'method' in m && (m as { method: string }).method === AcpMethod.TASK_SEND
      );
      expect(request).toBeDefined();

      const requestId = (request as { id: number }).id;
      mockTransport.simulateMessage({
        jsonrpc: '2.0',
        id: requestId,
        result: {},
      });

      await sendPromise;
    });
  });

  describe('cancelTask', () => {
    it('should send tasks/cancel request', async () => {
      const cancelPromise = client.cancelTask({ taskId: 'task-123' });

      const request = mockTransport.sentMessages.find(
        (m: JsonRpcMessage) => 'method' in m && (m as { method: string }).method === AcpMethod.TASK_CANCEL
      );
      expect(request).toBeDefined();

      const requestId = (request as { id: number }).id;
      mockTransport.simulateMessage({
        jsonrpc: '2.0',
        id: requestId,
        result: {},
      });

      await cancelPromise;
    });
  });

  describe('getTask', () => {
    it('should send tasks/get request', async () => {
      const getPromise = client.getTask({ taskId: 'task-123' });

      const request = mockTransport.sentMessages.find(
        (m: JsonRpcMessage) => 'method' in m && (m as { method: string }).method === AcpMethod.TASK_GET
      );
      expect(request).toBeDefined();

      const requestId = (request as { id: number }).id;
      mockTransport.simulateMessage({
        jsonrpc: '2.0',
        id: requestId,
        result: {
          id: 'task-123',
          status: 'working',
        },
      });

      const result = await getPromise;
      expect(result.id).toBe('task-123');
      expect(result.status).toBe('working');
    });
  });

  describe('listTasks', () => {
    it('should send tasks/list request', async () => {
      const listPromise = client.listTasks();

      const request = mockTransport.sentMessages.find(
        (m: JsonRpcMessage) => 'method' in m && (m as { method: string }).method === AcpMethod.TASK_LIST
      );
      expect(request).toBeDefined();

      const requestId = (request as { id: number }).id;
      mockTransport.simulateMessage({
        jsonrpc: '2.0',
        id: requestId,
        result: {
          tasks: [
            { id: 'task-1', status: 'completed' },
            { id: 'task-2', status: 'working' },
          ],
        },
      });

      const result = await listPromise;
      expect(result.tasks).toHaveLength(2);
      expect(result.tasks[0].id).toBe('task-1');
    });
  });

  describe('closeTask', () => {
    it('should send tasks/close request', async () => {
      const closePromise = client.closeTask({ taskId: 'task-123' });

      const request = mockTransport.sentMessages.find(
        (m: JsonRpcMessage) => 'method' in m && (m as { method: string }).method === AcpMethod.TASK_CLOSE
      );
      expect(request).toBeDefined();

      const requestId = (request as { id: number }).id;
      mockTransport.simulateMessage({
        jsonrpc: '2.0',
        id: requestId,
        result: {},
      });

      await closePromise;
    });
  });

  describe('forkTask', () => {
    it('should send tasks/fork request', async () => {
      const forkPromise = client.forkTask({ taskId: 'task-123' });

      const request = mockTransport.sentMessages.find(
        (m: JsonRpcMessage) => 'method' in m && (m as { method: string }).method === AcpMethod.TASK_FORK
      );
      expect(request).toBeDefined();

      const requestId = (request as { id: number }).id;
      mockTransport.simulateMessage({
        jsonrpc: '2.0',
        id: requestId,
        result: {
          id: 'task-456',
          status: 'created',
        },
      });

      const result = await forkPromise;
      expect(result.id).toBe('task-456');
      expect(result.status).toBe('created');
    });
  });

  // ==========================================================================
  // Error Handling
  // ==========================================================================

  describe('error handling', () => {
    it('should reject on JSON-RPC error response', async () => {
      const connectPromise = client.connect({
        clientName: 'test',
        clientVersion: '1.0.0',
        capabilities: {},
      });

      const initRequest = mockTransport.sentMessages.find(
        (m: JsonRpcMessage) => 'method' in m && (m as { method: string }).method === AcpMethod.INITIALIZE
      );
      const requestId = (initRequest as { id: number }).id;
      mockTransport.simulateMessage({
        jsonrpc: '2.0',
        id: requestId,
        error: {
          code: -32601,
          message: 'Method not found',
        },
      });

      await expect(connectPromise).rejects.toThrow('Method not found');
    });

    it('should reject pending requests on close', async () => {
      const createPromise = client.createTask();

      // Close before response
      await client.close();

      await expect(createPromise).rejects.toThrow('Client closed');
    });
  });

  // ==========================================================================
  // Notifications
  // ==========================================================================

  describe('notifications', () => {
    it('should emit task:status event', () => {
      const handler = vi.fn();
      client.on('task:status', handler);

      mockTransport.simulateMessage({
        jsonrpc: '2.0',
        method: AcpNotification.TASK_STATUS,
        params: {
          taskId: 'task-123',
          status: 'completed',
        },
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({
        taskId: 'task-123',
        status: 'completed',
      });
    });

    it('should emit task:message event', () => {
      const handler = vi.fn();
      client.on('task:message', handler);

      mockTransport.simulateMessage({
        jsonrpc: '2.0',
        method: AcpNotification.TASK_MESSAGE,
        params: {
          taskId: 'task-123',
          message: {
            role: 'assistant',
            content: { type: 'text', text: 'Hello!' },
          },
        },
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({
        taskId: 'task-123',
        message: {
          role: 'assistant',
          content: { type: 'text', text: 'Hello!' },
        },
      });
    });

    it('should emit task:artefact event', () => {
      const handler = vi.fn();
      client.on('task:artefact', handler);

      mockTransport.simulateMessage({
        jsonrpc: '2.0',
        method: AcpNotification.TASK_ARTEFACT,
        params: {
          taskId: 'task-123',
          name: 'report.md',
          kind: 'file',
          uri: 'file:///tmp/report.md',
        },
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({
        taskId: 'task-123',
        name: 'report.md',
        kind: 'file',
        uri: 'file:///tmp/report.md',
      });
    });
  });
});
