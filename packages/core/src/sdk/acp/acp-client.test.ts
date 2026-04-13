/**
 * ACP Client 测试
 *
 * 使用 MockTransport 驱动测试，覆盖完整 ACP 生命周期。
 * 不使用 vi.mock()，MockTransport 通过实现 IAcpTransport 接口进行依赖注入。
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcMessage,
} from './types.js';
import {
  AcpError,
  type IAcpTransport,
  type AcpMessageHandler,
  type AcpErrorHandler,
  type AcpCloseHandler,
} from './transport.js';
import { AcpClient, type AcpClientConfig } from './acp-client.js';

// ============================================================================
// MockTransport（复用 transport.test.ts 的模式）
// ============================================================================

/** 用于测试的 Mock Transport */
class MockTransport implements IAcpTransport {
  private _connected = false;
  private messageHandlers: AcpMessageHandler[] = [];
  private errorHandlers: AcpErrorHandler[] = [];
  private closeHandlers: AcpCloseHandler[] = [];
  public sentMessages: (JsonRpcRequest | JsonRpcNotification)[] = [];

  get connected(): boolean {
    return this._connected;
  }

  connect(): Promise<void> {
    this._connected = true;
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this._connected = false;
    return Promise.resolve();
  }

  send(message: JsonRpcRequest | JsonRpcNotification): void {
    if (!this._connected) {
      throw new AcpError('Transport is not connected');
    }
    this.sentMessages.push(message);
  }

  onMessage(handler: AcpMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onError(handler: AcpErrorHandler): void {
    this.errorHandlers.push(handler);
  }

  onClose(handler: AcpCloseHandler): void {
    this.closeHandlers.push(handler);
  }

  /** 模拟收到 Agent 消息 */
  simulateMessage(message: JsonRpcMessage): void {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }

  /** 模拟发生错误 */
  simulateError(error: Error): void {
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }

  /** 模拟连接关闭 */
  simulateClose(): void {
    this._connected = false;
    for (const handler of this.closeHandlers) {
      handler();
    }
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/** 创建 JSON-RPC 成功响应 */
function successResponse(id: number | string, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

/** 创建 JSON-RPC 错误响应 */
function errorResponse(id: number | string, code: number, message: string): JsonRpcMessage {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** 创建 session/update 通知 */
function sessionUpdateNotification(update: unknown): JsonRpcNotification {
  return {
    jsonrpc: '2.0',
    method: 'session/update',
    params: { update },
  };
}

/** 创建默认测试客户端 */
function createTestClient(transport?: MockTransport, config?: Partial<AcpClientConfig>): {
  client: AcpClient;
  transport: MockTransport;
} {
  const t = transport ?? new MockTransport();
  const client = new AcpClient({
    transport: t,
    timeout: config?.timeout ?? 5000,
    ...config,
  });
  return { client, transport: t };
}

// ============================================================================
// 测试
// ============================================================================

describe('AcpClient', () => {
  // --------------------------------------------------------------------------
  // 初始状态
  // --------------------------------------------------------------------------
  describe('initial state', () => {
    it('starts disconnected', () => {
      const { client } = createTestClient();
      expect(client.state).toBe('disconnected');
    });
  });

  // --------------------------------------------------------------------------
  // connect()
  // --------------------------------------------------------------------------
  describe('connect', () => {
    it('sends initialize and transitions to connected', async () => {
      const { client, transport } = createTestClient();

      // 在 connect() 中，initialize 请求发送后需要响应
      const connectPromise = client.connect();

      // 等待 initialize 请求被发送
      await new Promise((resolve) => setTimeout(resolve, 10));

      // 验证发送了 initialize 请求
      expect(transport.sentMessages.length).toBe(1);
      const initReq = transport.sentMessages[0] as JsonRpcRequest;
      expect(initReq.method).toBe('initialize');
      expect(initReq.params).toEqual({
        protocolVersion: 1,
        clientCapabilities: {
          auth: { terminal: true },
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      });

      // 模拟服务端响应
      transport.simulateMessage(successResponse(initReq.id, { protocolVersion: 1 }));

      const capabilities = await connectPromise;
      expect(capabilities.protocolVersion).toBe(1);
      expect(client.state).toBe('connected');
    });

    it('throws if already connected', async () => {
      const { client, transport } = createTestClient();

      const connectPromise = client.connect();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const initReq = transport.sentMessages[0] as JsonRpcRequest;
      transport.simulateMessage(successResponse(initReq.id, {}));
      await connectPromise;

      await expect(client.connect()).rejects.toThrow('Already connected');
    });

    it('throws if connecting in progress', async () => {
      const { client } = createTestClient();

      void client.connect(); // Start connecting but don't resolve

      await expect(client.connect()).rejects.toThrow('Connection already in progress');
    });

    it('reverts to disconnected on initialize error', async () => {
      const { client, transport } = createTestClient();

      const connectPromise = client.connect();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const initReq = transport.sentMessages[0] as JsonRpcRequest;
      transport.simulateMessage(errorResponse(initReq.id, -32600, 'Invalid params'));

      await expect(connectPromise).rejects.toThrow('Invalid params');
      expect(client.state).toBe('disconnected');
    });
  });

  // --------------------------------------------------------------------------
  // createSession()
  // --------------------------------------------------------------------------
  describe('createSession', () => {
    it('sends session/new and returns session info', async () => {
      const { client, transport } = createTestClient();

      // Connect first
      const connectPromise = client.connect();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const initReq = transport.sentMessages[0] as JsonRpcRequest;
      transport.simulateMessage(successResponse(initReq.id, {}));
      await connectPromise;

      // Create session
      const sessionPromise = client.createSession('/workspace');
      await new Promise((resolve) => setTimeout(resolve, 10));

      const sessionReq = transport.sentMessages[1] as JsonRpcRequest;
      expect(sessionReq.method).toBe('session/new');
      expect(sessionReq.params).toEqual({ cwd: '/workspace', mcpServers: [] });

      transport.simulateMessage(successResponse(sessionReq.id, {
        sessionId: 'sess-1',
        models: { availableModels: [{ modelId: 'claude-3' }], currentModelId: 'claude-3' },
      }));

      const result = await sessionPromise;
      expect(result.sessionId).toBe('sess-1');
      expect(result.models.currentModelId).toBe('claude-3');
    });

    it('sends permission mode in _meta when provided', async () => {
      const { client, transport } = createTestClient();

      // Connect
      const connectPromise = client.connect();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const initReq = transport.sentMessages[0] as JsonRpcRequest;
      transport.simulateMessage(successResponse(initReq.id, {}));
      await connectPromise;

      // Create session with permission mode
      const sessionPromise = client.createSession('/workspace', {
        permissionMode: 'bypassPermissions',
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const sessionReq = transport.sentMessages[1] as JsonRpcRequest;
      expect(sessionReq.params).toEqual({
        cwd: '/workspace',
        mcpServers: [],
        _meta: {
          claudeCode: {
            options: { permissionMode: 'bypassPermissions' },
          },
        },
      });

      transport.simulateMessage(successResponse(sessionReq.id, {
        sessionId: 'sess-2',
        models: { availableModels: [], currentModelId: 'default' },
      }));

      await sessionPromise;
    });

    it('throws when not connected', async () => {
      const { client } = createTestClient();
      await expect(client.createSession('/workspace')).rejects.toThrow('Not connected');
    });
  });

  // --------------------------------------------------------------------------
  // sendPrompt()
  // --------------------------------------------------------------------------
  describe('sendPrompt', () => {
    async function connectClient(client: AcpClient, transport: MockTransport): Promise<void> {
      const connectPromise = client.connect();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const initReq = transport.sentMessages[0] as JsonRpcRequest;
      transport.simulateMessage(successResponse(initReq.id, {}));
      await connectPromise;
    }

    it('sends session/prompt and yields AgentMessages', async () => {
      const { client, transport } = createTestClient();
      await connectClient(client, transport);

      // Start sendPrompt — calling next() triggers the generator body
      const promptIter = client.sendPrompt('sess-1', [{ type: 'text', text: 'Hello' }]);
      const firstMsgPromise = promptIter.next();
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Find the prompt request (generator body has now executed)
      const promptReq = transport.sentMessages.find(
        (m) => (m as JsonRpcRequest).method === 'session/prompt',
      ) as JsonRpcRequest;
      expect(promptReq).toBeDefined();
      expect(promptReq.params).toEqual({
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'Hello' }],
      });

      // Simulate session/update notifications
      transport.simulateMessage(sessionUpdateNotification({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hi there!' },
      }));

      transport.simulateMessage(sessionUpdateNotification({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        toolName: 'Bash',
        content: { type: 'text', text: '{"command":"ls"}' },
      }));

      // Simulate prompt result
      transport.simulateMessage(successResponse(promptReq.id, {
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 50 },
      }));

      // Collect all messages
      const messages = [];
      messages.push((await firstMsgPromise).value);
      for await (const msg of promptIter) {
        messages.push(msg);
      }

      // Should have: text message, tool_use message, result message
      expect(messages.length).toBeGreaterThanOrEqual(3);
      expect(messages[0].type).toBe('text');
      expect(messages[0].content).toBe('Hi there!');
      expect(messages[1].type).toBe('tool_use');
      expect(messages[1].metadata!.toolName).toBe('Bash');
      expect(messages[messages.length - 1].type).toBe('result');
    });

    it('throws when not connected', async () => {
      const { client } = createTestClient();
      const iter = client.sendPrompt('sess-1', [{ type: 'text', text: 'Hello' }]);
      await expect(iter.next()).rejects.toThrow('Not connected');
    });

    it('handles error response from session/prompt', async () => {
      const { client, transport } = createTestClient();
      await connectClient(client, transport);

      const promptIter = client.sendPrompt('sess-1', [{ type: 'text', text: 'Hello' }]);
      const firstMsgPromise = promptIter.next();
      await new Promise((resolve) => setTimeout(resolve, 10));

      const promptReq = transport.sentMessages.find(
        (m) => (m as JsonRpcRequest).method === 'session/prompt',
      ) as JsonRpcRequest;

      // Simulate error response
      transport.simulateMessage(errorResponse(promptReq.id, -32603, 'Internal error'));

      await expect(firstMsgPromise).rejects.toThrow('Internal error');
    });
  });

  // --------------------------------------------------------------------------
  // cancelPrompt()
  // --------------------------------------------------------------------------
  describe('cancelPrompt', () => {
    it('sends session/cancel request', async () => {
      const { client, transport } = createTestClient();

      // Connect
      const connectPromise = client.connect();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const initReq = transport.sentMessages[0] as JsonRpcRequest;
      transport.simulateMessage(successResponse(initReq.id, {}));
      await connectPromise;

      // Cancel
      const cancelPromise = client.cancelPrompt('sess-1');
      await new Promise((resolve) => setTimeout(resolve, 10));

      const cancelReq = transport.sentMessages[1] as JsonRpcRequest;
      expect(cancelReq.method).toBe('session/cancel');
      expect(cancelReq.params).toEqual({ sessionId: 'sess-1' });

      transport.simulateMessage(successResponse(cancelReq.id, null));
      await cancelPromise;
    });

    it('throws when not connected', async () => {
      const { client } = createTestClient();
      await expect(client.cancelPrompt('sess-1')).rejects.toThrow('Not connected');
    });
  });

  // --------------------------------------------------------------------------
  // disconnect()
  // --------------------------------------------------------------------------
  describe('disconnect', () => {
    it('transitions to disconnected and cleans up', async () => {
      const { client, transport } = createTestClient();

      // Connect
      const connectPromise = client.connect();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const initReq = transport.sentMessages[0] as JsonRpcRequest;
      transport.simulateMessage(successResponse(initReq.id, {}));
      await connectPromise;

      expect(client.state).toBe('connected');

      await client.disconnect();

      expect(client.state).toBe('disconnected');
      expect(transport.connected).toBe(false);
    });

    it('is no-op when already disconnected', async () => {
      const { client } = createTestClient();
      await client.disconnect(); // Should not throw
      expect(client.state).toBe('disconnected');
    });

    it('rejects pending requests on disconnect', async () => {
      const { client, transport } = createTestClient();

      // Connect
      const connectPromise = client.connect();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const initReq = transport.sentMessages[0] as JsonRpcRequest;
      transport.simulateMessage(successResponse(initReq.id, {}));
      await connectPromise;

      // Start a createSession that won't be responded to
      const sessionPromise = client.createSession('/workspace');
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Disconnect while request is pending
      await client.disconnect();

      await expect(sessionPromise).rejects.toThrow('Client disconnecting');
    });
  });

  // --------------------------------------------------------------------------
  // Transport error/close handling
  // --------------------------------------------------------------------------
  describe('transport error handling', () => {
    it('rejects pending requests on transport error', async () => {
      const { client, transport } = createTestClient();

      // Connect
      const connectPromise = client.connect();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const initReq = transport.sentMessages[0] as JsonRpcRequest;
      transport.simulateMessage(successResponse(initReq.id, {}));
      await connectPromise;

      // Start a pending request
      const sessionPromise = client.createSession('/workspace');
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Simulate transport error
      transport.simulateError(new Error('Connection reset'));

      await expect(sessionPromise).rejects.toThrow('Transport error');
    });

    it('transitions to disconnected on transport close', async () => {
      const { client, transport } = createTestClient();

      // Connect
      const connectPromise = client.connect();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const initReq = transport.sentMessages[0] as JsonRpcRequest;
      transport.simulateMessage(successResponse(initReq.id, {}));
      await connectPromise;

      expect(client.state).toBe('connected');

      // Simulate transport close
      transport.simulateClose();

      expect(client.state).toBe('disconnected');
    });

    it('terminates active prompt streams on transport close', async () => {
      const { client, transport } = createTestClient();

      // Connect
      const connectPromise = client.connect();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const initReq = transport.sentMessages[0] as JsonRpcRequest;
      transport.simulateMessage(successResponse(initReq.id, {}));
      await connectPromise;

      // Start a prompt — call next() to trigger the generator body
      const promptIter = client.sendPrompt('sess-1', [{ type: 'text', text: 'Hello' }]);
      const firstMsgPromise = promptIter.next();
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Simulate transport close
      transport.simulateClose();

      // The pending next() should reject with Transport closed
      await expect(firstMsgPromise).rejects.toThrow('Transport closed');
    });
  });

  // --------------------------------------------------------------------------
  // Permission request handling
  // --------------------------------------------------------------------------
  describe('permission request handling', () => {
    it('auto-approves when no callback is set', async () => {
      const { client, transport } = createTestClient();

      // Connect
      const connectPromise = client.connect();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const initReq = transport.sentMessages[0] as JsonRpcRequest;
      transport.simulateMessage(successResponse(initReq.id, {}));
      await connectPromise;

      // Simulate permission request notification
      transport.simulateMessage({
        jsonrpc: '2.0',
        method: 'session/request_permission',
        params: { capability: 'bash', path: '/tmp/test.sh' },
      });

      // Wait for async handling
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should have sent auto-approve response
      const permResp = transport.sentMessages.find(
        (m) => !('id' in m) && (m as JsonRpcNotification).method === 'session/request_permission_response',
      ) as JsonRpcNotification | undefined;
      expect(permResp).toBeDefined();
      expect(permResp!.params).toEqual({
        outcome: { selected: true, optionId: 'allow' },
      });
    });

    it('delegates to callback when set', async () => {
      const callback = vi.fn().mockResolvedValue({
        outcome: { selected: true, optionId: 'deny' },
      });
      const { client, transport } = createTestClient(undefined, {
        onPermissionRequest: callback,
      });

      // Connect
      const connectPromise = client.connect();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const initReq = transport.sentMessages[0] as JsonRpcRequest;
      transport.simulateMessage(successResponse(initReq.id, {}));
      await connectPromise;

      // Simulate permission request
      transport.simulateMessage({
        jsonrpc: '2.0',
        method: 'session/request_permission',
        params: { capability: 'edit', path: '/workspace/file.ts' },
      });

      // Wait for async handling
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(callback).toHaveBeenCalledWith({
        capability: 'edit',
        path: '/workspace/file.ts',
      });

      const permResp = transport.sentMessages.find(
        (m) => !('id' in m) && (m as JsonRpcNotification).method === 'session/request_permission_response',
      ) as JsonRpcNotification | undefined;
      expect(permResp).toBeDefined();
      expect(permResp!.params).toEqual({
        outcome: { selected: true, optionId: 'deny' },
      });
    });

    it('denies permission when callback throws', async () => {
      const callback = vi.fn().mockRejectedValue(new Error('User rejected'));
      const { client, transport } = createTestClient(undefined, {
        onPermissionRequest: callback,
      });

      // Connect
      const connectPromise = client.connect();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const initReq = transport.sentMessages[0] as JsonRpcRequest;
      transport.simulateMessage(successResponse(initReq.id, {}));
      await connectPromise;

      // Simulate permission request
      transport.simulateMessage({
        jsonrpc: '2.0',
        method: 'session/request_permission',
        params: { capability: 'bash' },
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const permResp = transport.sentMessages.find(
        (m) => !('id' in m) && (m as JsonRpcNotification).method === 'session/request_permission_response',
      ) as JsonRpcNotification | undefined;
      expect(permResp).toBeDefined();
      expect(permResp!.params).toEqual({
        outcome: { selected: true, optionId: 'deny' },
      });
    });
  });

  // --------------------------------------------------------------------------
  // Timeout handling
  // --------------------------------------------------------------------------
  describe('timeout', () => {
    it('rejects request on timeout', async () => {
      const { client } = createTestClient(undefined, { timeout: 100 });

      const connectPromise = client.connect();
      // Don't respond — let it timeout

      await expect(connectPromise).rejects.toThrow('Request timeout');
      expect(client.state).toBe('disconnected');
    });
  });

  // --------------------------------------------------------------------------
  // Unknown notifications
  // --------------------------------------------------------------------------
  describe('unknown notifications', () => {
    it('ignores unknown notification methods', async () => {
      const { client, transport } = createTestClient();

      // Connect
      const connectPromise = client.connect();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const initReq = transport.sentMessages[0] as JsonRpcRequest;
      transport.simulateMessage(successResponse(initReq.id, {}));
      await connectPromise;

      // Send unknown notification — should not throw
      transport.simulateMessage({
        jsonrpc: '2.0',
        method: 'custom/notification',
        params: { data: 'test' },
      });

      // Client should still be connected
      expect(client.state).toBe('connected');
    });
  });
});
