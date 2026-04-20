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

/** 创建 session/update 通知（包含 sessionId 用于路由） */
function sessionUpdateNotification(sessionId: string, update: unknown): JsonRpcNotification {
  return {
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update },
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

/**
 * 让出执行权，等待微任务队列处理完毕。
 *
 * 比 setTimeout(resolve, 10) 更可靠，因为：
 * - 不依赖实际时钟（消除 CI 环境下的 flaky 测试）
 * - MockTransport 的 send() 是同步的，消息在调用时已入队
 * - 只需让出一次让 Promise 链有机会执行即可
 */
function yieldOnce(): Promise<void> {
  return new Promise<void>((resolve) => queueMicrotask(resolve));
}

/** 连接客户端的辅助函数（复用连接逻辑） */
async function connectClient(client: AcpClient, transport: MockTransport): Promise<void> {
  const connectPromise = client.connect();
  await yieldOnce();
  const initReq = transport.sentMessages[0] as JsonRpcRequest;
  transport.simulateMessage(successResponse(initReq.id, {}));
  await connectPromise;
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

      // 让出执行权，等待 sendRequest 完成
      await yieldOnce();

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
      await yieldOnce();
      const initReq = transport.sentMessages[0] as JsonRpcRequest;
      transport.simulateMessage(successResponse(initReq.id, {}));
      await connectPromise;

      await expect(client.connect()).rejects.toThrow('Already connected');
    });

    it('throws if connecting in progress', async () => {
      const { client } = createTestClient();

      const firstConnectPromise = client.connect(); // Start connecting but don't resolve
      await yieldOnce();

      await expect(client.connect()).rejects.toThrow('Connection already in progress');

      // 清理：防止 firstConnectPromise 的 5000ms timeout 在后续测试中触发 unhandled rejection
      firstConnectPromise.catch(() => {});
      await client.disconnect();
    });

    it('reverts to disconnected on initialize error', async () => {
      const { client, transport } = createTestClient();

      const connectPromise = client.connect();
      await yieldOnce();
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
      await connectClient(client, transport);

      // Create session
      const sessionPromise = client.createSession('/workspace');
      await yieldOnce();

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
      await connectClient(client, transport);

      // Create session with permission mode
      const sessionPromise = client.createSession('/workspace', {
        permissionMode: 'bypassPermissions',
      });
      await yieldOnce();

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
    it('sends session/prompt and yields AgentMessages', async () => {
      const { client, transport } = createTestClient();
      await connectClient(client, transport);

      // Start sendPrompt — calling next() triggers the generator body
      const promptIter = client.sendPrompt('sess-1', [{ type: 'text', text: 'Hello' }]);
      const firstMsgPromise = promptIter.next();
      await yieldOnce();

      // Find the prompt request (generator body has now executed)
      const promptReq = transport.sentMessages.find(
        (m) => (m as JsonRpcRequest).method === 'session/prompt',
      ) as JsonRpcRequest;
      expect(promptReq).toBeDefined();
      expect(promptReq.params).toEqual({
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'Hello' }],
      });

      // Simulate session/update notifications with sessionId for routing
      transport.simulateMessage(sessionUpdateNotification('sess-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hi there!' },
      }));

      transport.simulateMessage(sessionUpdateNotification('sess-1', {
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
      await yieldOnce();

      const promptReq = transport.sentMessages.find(
        (m) => (m as JsonRpcRequest).method === 'session/prompt',
      ) as JsonRpcRequest;

      // Simulate error response
      transport.simulateMessage(errorResponse(promptReq.id, -32603, 'Internal error'));

      await expect(firstMsgPromise).rejects.toThrow('Internal error');
    });

    it('rejects concurrent prompts for the same session (P2)', async () => {
      const { client, transport } = createTestClient();
      await connectClient(client, transport);

      // Start first prompt — call next() to trigger generator body
      const promptIter1 = client.sendPrompt('sess-1', [{ type: 'text', text: 'First' }]);
      const firstNextPromise = promptIter1.next();
      await yieldOnce();

      // Second prompt for the same session should throw
      const promptIter2 = client.sendPrompt('sess-1', [{ type: 'text', text: 'Second' }]);
      await expect(promptIter2.next()).rejects.toThrow('A prompt is already active for session sess-1');

      // 清理：附加 catch handler 防止 disconnect 导致的 unhandled rejection
      firstNextPromise.catch(() => {});
      await client.disconnect();
    });

    it('allows concurrent prompts for different sessions', async () => {
      const { client, transport } = createTestClient();
      await connectClient(client, transport);

      // Start first prompt on sess-1
      const iter1 = client.sendPrompt('sess-1', [{ type: 'text', text: 'Hello 1' }]);
      const p1 = iter1.next();
      await yieldOnce();

      // Start second prompt on sess-2 — should succeed
      const iter2 = client.sendPrompt('sess-2', [{ type: 'text', text: 'Hello 2' }]);
      const p2 = iter2.next();
      await yieldOnce();

      // Find both prompt requests
      const promptReqs = transport.sentMessages.filter(
        (m) => (m as JsonRpcRequest).method === 'session/prompt',
      );
      expect(promptReqs.length).toBe(2);

      // Send update to sess-1
      transport.simulateMessage(sessionUpdateNotification('sess-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Response 1' },
      }));

      // Send update to sess-2
      transport.simulateMessage(sessionUpdateNotification('sess-2', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Response 2' },
      }));

      // Complete both prompts
      const req1 = promptReqs[0] as JsonRpcRequest;
      const req2 = promptReqs[1] as JsonRpcRequest;
      transport.simulateMessage(successResponse(req1.id, {
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      }));
      transport.simulateMessage(successResponse(req2.id, {
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      }));

      // Collect messages from both iterators
      const msgs1 = [(await p1).value];
      for await (const msg of iter1) { msgs1.push(msg); }

      const msgs2 = [(await p2).value];
      for await (const msg of iter2) { msgs2.push(msg); }

      // Verify each iterator only got its own session's messages
      expect(msgs1.some(m => m.content === 'Response 1')).toBe(true);
      expect(msgs1.some(m => m.content === 'Response 2')).toBe(false);
      expect(msgs2.some(m => m.content === 'Response 2')).toBe(true);
      expect(msgs2.some(m => m.content === 'Response 1')).toBe(false);
    });

    it('ignores session/update for inactive session', async () => {
      const { client, transport } = createTestClient();
      await connectClient(client, transport);

      // Send update for a session with no active prompt — should not throw
      transport.simulateMessage(sessionUpdateNotification('sess-nonexistent', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Orphan message' },
      }));

      // Client should still be connected (no crash)
      expect(client.state).toBe('connected');
    });
  });

  // --------------------------------------------------------------------------
  // cancelPrompt()
  // --------------------------------------------------------------------------
  describe('cancelPrompt', () => {
    it('sends session/cancel request', async () => {
      const { client, transport } = createTestClient();
      await connectClient(client, transport);

      // Cancel
      const cancelPromise = client.cancelPrompt('sess-1');
      await yieldOnce();

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
      await connectClient(client, transport);

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
      await connectClient(client, transport);

      // Start a createSession that won't be responded to
      const sessionPromise = client.createSession('/workspace');
      await yieldOnce();

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
      await connectClient(client, transport);

      // Start a pending request
      const sessionPromise = client.createSession('/workspace');
      await yieldOnce();

      // Simulate transport error
      transport.simulateError(new Error('Connection reset'));

      await expect(sessionPromise).rejects.toThrow('Transport error');
    });

    it('transitions to disconnected on transport close', async () => {
      const { client, transport } = createTestClient();
      await connectClient(client, transport);

      expect(client.state).toBe('connected');

      // Simulate transport close
      transport.simulateClose();

      expect(client.state).toBe('disconnected');
    });

    it('terminates active prompt streams on transport close', async () => {
      const { client, transport } = createTestClient();
      await connectClient(client, transport);

      // Start a prompt — call next() to trigger the generator body
      const promptIter = client.sendPrompt('sess-1', [{ type: 'text', text: 'Hello' }]);
      const firstMsgPromise = promptIter.next();
      await yieldOnce();

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
      await connectClient(client, transport);

      // Simulate permission request notification
      transport.simulateMessage({
        jsonrpc: '2.0',
        method: 'session/request_permission',
        params: { capability: 'bash', path: '/tmp/test.sh' },
      });

      // 让出执行权，等待异步处理完成
      await yieldOnce();

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
      await connectClient(client, transport);

      // Simulate permission request
      transport.simulateMessage({
        jsonrpc: '2.0',
        method: 'session/request_permission',
        params: { capability: 'edit', path: '/workspace/file.ts' },
      });

      // 让出执行权，等待异步回调完成
      await yieldOnce();
      await yieldOnce();

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
      await connectClient(client, transport);

      // Simulate permission request
      transport.simulateMessage({
        jsonrpc: '2.0',
        method: 'session/request_permission',
        params: { capability: 'bash' },
      });

      // 让出执行权，等待异步回调完成
      await yieldOnce();
      await yieldOnce();

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
    it('rejects and cleans up on request failure (covers timeout path)', async () => {
      const { client, transport } = createTestClient();
      await connectClient(client, transport);

      // Start a request that will fail (simulates timeout error path)
      const sessionPromise = client.createSession('/workspace');
      await yieldOnce();

      // Simulate timeout-like error response
      const sessionReq = transport.sentMessages[1] as JsonRpcRequest;
      transport.simulateMessage(errorResponse(sessionReq.id, -1, 'Request timeout: session/new (id=1)'));

      await expect(sessionPromise).rejects.toThrow('Request timeout');
      expect(client.state).toBe('connected'); // Client remains connected, only the request fails
    });
  });

  // --------------------------------------------------------------------------
  // Unknown notifications
  // --------------------------------------------------------------------------
  describe('unknown notifications', () => {
    it('ignores unknown notification methods', async () => {
      const { client, transport } = createTestClient();
      await connectClient(client, transport);

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

  // --------------------------------------------------------------------------
  // Text chunk aggregation (Issue #2532)
  // --------------------------------------------------------------------------
  describe('text chunk aggregation (Issue #2532)', () => {
    it('aggregates consecutive text chunks into a single message', async () => {
      const { client, transport } = createTestClient();
      await connectClient(client, transport);

      const promptIter = client.sendPrompt('sess-1', [{ type: 'text', text: 'Hello' }]);
      const firstMsgPromise = promptIter.next();
      await yieldOnce();

      // Send multiple text chunks (simulating token-level streaming)
      transport.simulateMessage(sessionUpdateNotification('sess-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hel' },
      }));
      transport.simulateMessage(sessionUpdateNotification('sess-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'lo ' },
      }));
      transport.simulateMessage(sessionUpdateNotification('sess-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'wor' },
      }));
      transport.simulateMessage(sessionUpdateNotification('sess-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'ld!' },
      }));

      // Flush by sending a non-text event
      transport.simulateMessage(sessionUpdateNotification('sess-1', {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        toolName: 'Bash',
        content: { type: 'text', text: '{"command":"ls"}' },
      }));

      // Complete the prompt
      const promptReq = transport.sentMessages.find(
        (m) => (m as JsonRpcRequest).method === 'session/prompt',
      ) as JsonRpcRequest;
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

      // Should have: 1 aggregated text, 1 tool_use, 1 result
      const textMessages = messages.filter(m => m.type === 'text');
      expect(textMessages).toHaveLength(1);
      expect(textMessages[0].content).toBe('Hello world!');

      const toolMessages = messages.filter(m => m.type === 'tool_use');
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0].metadata!.toolName).toBe('Bash');

      expect(messages[messages.length - 1].type).toBe('result');
    });

    it('aggregates thinking chunks into a single message', async () => {
      const { client, transport } = createTestClient();
      await connectClient(client, transport);

      const promptIter = client.sendPrompt('sess-1', [{ type: 'text', text: 'Think' }]);
      const firstMsgPromise = promptIter.next();
      await yieldOnce();

      // Send multiple thinking chunks
      transport.simulateMessage(sessionUpdateNotification('sess-1', {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Let me ' },
      }));
      transport.simulateMessage(sessionUpdateNotification('sess-1', {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'think...' },
      }));

      // Flush with a tool_call
      transport.simulateMessage(sessionUpdateNotification('sess-1', {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        toolName: 'Read',
      }));

      // Complete the prompt
      const promptReq = transport.sentMessages.find(
        (m) => (m as JsonRpcRequest).method === 'session/prompt',
      ) as JsonRpcRequest;
      transport.simulateMessage(successResponse(promptReq.id, {
        stopReason: 'end_turn',
        usage: { inputTokens: 50, outputTokens: 25 },
      }));

      const messages = [];
      messages.push((await firstMsgPromise).value);
      for await (const msg of promptIter) {
        messages.push(msg);
      }

      const thinkingMessages = messages.filter(m => m.type === 'thinking');
      expect(thinkingMessages).toHaveLength(1);
      expect(thinkingMessages[0].content).toBe('Let me think...');
    });

    it('flushes buffered text when prompt completes (no trailing event)', async () => {
      const { client, transport } = createTestClient();
      await connectClient(client, transport);

      const promptIter = client.sendPrompt('sess-1', [{ type: 'text', text: 'Hello' }]);
      const firstMsgPromise = promptIter.next();
      await yieldOnce();

      // Send text chunks with no trailing non-text event
      transport.simulateMessage(sessionUpdateNotification('sess-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Only ' },
      }));
      transport.simulateMessage(sessionUpdateNotification('sess-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'text.' },
      }));

      // Complete the prompt immediately
      const promptReq = transport.sentMessages.find(
        (m) => (m as JsonRpcRequest).method === 'session/prompt',
      ) as JsonRpcRequest;
      transport.simulateMessage(successResponse(promptReq.id, {
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      }));

      const messages = [];
      messages.push((await firstMsgPromise).value);
      for await (const msg of promptIter) {
        messages.push(msg);
      }

      // Text should be flushed before result
      const textMessages = messages.filter(m => m.type === 'text');
      expect(textMessages).toHaveLength(1);
      expect(textMessages[0].content).toBe('Only text.');
    });

    it('passes through image content in chunks without aggregation', async () => {
      const { client, transport } = createTestClient();
      await connectClient(client, transport);

      const promptIter = client.sendPrompt('sess-1', [{ type: 'text', text: 'Image' }]);
      const firstMsgPromise = promptIter.next();
      await yieldOnce();

      // Send image content in agent_message_chunk — should not be aggregated
      transport.simulateMessage(sessionUpdateNotification('sess-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', data: 'base64data', mimeType: 'image/png' },
      }));

      // Complete
      const promptReq = transport.sentMessages.find(
        (m) => (m as JsonRpcRequest).method === 'session/prompt',
      ) as JsonRpcRequest;
      transport.simulateMessage(successResponse(promptReq.id, {
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      }));

      const messages = [];
      messages.push((await firstMsgPromise).value);
      for await (const msg of promptIter) {
        messages.push(msg);
      }

      // Image chunk should pass through directly (not aggregated)
      const textMessages = messages.filter(m => m.type === 'text');
      expect(textMessages.length).toBeGreaterThanOrEqual(1);
      expect(textMessages[0].content).toContain('image');
    });
  });
});
