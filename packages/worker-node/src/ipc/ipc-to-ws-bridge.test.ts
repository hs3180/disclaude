/**
 * Tests for IPC-to-WebSocket Bridge (packages/worker-node/src/ipc/ipc-to-ws-bridge.ts)
 *
 * Tests request routing, timeout handling, response correlation,
 * unknown request types, and WebSocket lifecycle events.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { IpcRequest } from '@disclaude/core';

vi.mock('ws', () => {
  const mockFn = Object.assign(
    vi.fn(),
    { OPEN: 1, CLOSED: 3, CONNECTING: 0, CLOSING: 2 },
  );
  return {
    __esModule: true,
    default: mockFn,
    WebSocket: mockFn,
  };
});

vi.mock('@disclaude/core', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { createIpcToWsBridge } from './ipc-to-ws-bridge.js';

// --- Helpers ---

function createMockWsClient(overrides?: Record<string, unknown>) {
  return {
    readyState: 1 as number, // OPEN
    send: vi.fn(),
    on: vi.fn(),
    close: vi.fn(),
    ...overrides,
  };
}

/** Helper to create a typed IPC request for testing. */
function ipcRequest(req: { id: string; type: string; payload: Record<string, unknown> }): IpcRequest {
  return req as IpcRequest;
}

/** Get the requestId from the last sent WebSocket message */
function getLastSentRequestId(wsClient: ReturnType<typeof createMockWsClient>): string | undefined {
  const {calls} = wsClient.send.mock;
  if (!calls.length) {return undefined;}
  const sentData = calls[calls.length - 1]?.[0] as string;
  return JSON.parse(sentData)?.requestId;
}

// --- Tests ---

describe('createIpcToWsBridge', () => {
  let getWsClient: Mock;
  let wsClient: ReturnType<typeof createMockWsClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    wsClient = createMockWsClient();
    getWsClient = vi.fn(() => wsClient);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // Basic Request Routing
  // =========================================================================

  describe('request routing', () => {
    it('should return error when WebSocket is not connected', async () => {
      getWsClient.mockReturnValue(undefined);
      const bridge = createIpcToWsBridge(getWsClient);

      const result = await bridge(ipcRequest({ id: 'req-1', type: 'sendMessage', payload: { chatId: 'c1', text: 'hello' } }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('not connected');
    });

    it('should return error when WebSocket is not in OPEN state', async () => {
      wsClient.readyState = 3; // CLOSED
      const bridge = createIpcToWsBridge(getWsClient);

      const result = await bridge(ipcRequest({ id: 'req-1', type: 'sendMessage', payload: {} }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('not connected');
    });

    it('should return error for unknown request type', async () => {
      const bridge = createIpcToWsBridge(getWsClient);

      const result = await bridge(ipcRequest({ id: 'req-1', type: 'unknownType', payload: {} }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown request type');
    });

    it('should send WebSocket message for sendMessage type', async () => {
      const bridge = createIpcToWsBridge(getWsClient);

      const responsePromise = bridge(ipcRequest({ id: 'req-1', type: 'sendMessage', payload: { chatId: 'c1', text: 'hello' } }));

      const requestId = getLastSentRequestId(wsClient);
      expect(requestId).toBeDefined();

      const sentData = wsClient.send.mock.calls[0]?.[0] as string;
      const sentMsg = JSON.parse(sentData);
      expect(sentMsg.type).toBe('feishu-api-request');
      expect(sentMsg.action).toBe('sendMessage');
      expect(sentMsg.params).toEqual({ chatId: 'c1', text: 'hello' });

      // Simulate response
      const messageHandler = wsClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'message',
      )?.[1] as Function;

      messageHandler!(Buffer.from(JSON.stringify({
        type: 'feishu-api-response',
        requestId,
        success: true,
        data: { messageId: 'msg-123' },
      })));

      const result = await responsePromise;
      expect(result.id).toBe('req-1');
      expect(result.success).toBe(true);
      expect(result.payload).toEqual({ messageId: 'msg-123' });
    });

    it('should route sendCard type correctly', async () => {
      const bridge = createIpcToWsBridge(getWsClient);

      const responsePromise = bridge(ipcRequest({ id: 'req-2', type: 'sendCard', payload: { chatId: 'c1', card: {} } }));

      const requestId = getLastSentRequestId(wsClient)!;
      expect(JSON.parse(wsClient.send.mock.calls[0]?.[0] as string).action).toBe('sendCard');

      const messageHandler = wsClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'message',
      )?.[1] as Function;
      messageHandler!(Buffer.from(JSON.stringify({
        type: 'feishu-api-response', requestId, success: true, data: {},
      })));

      const result = await responsePromise;
      expect(result.success).toBe(true);
    });

    it('should route uploadFile type correctly', async () => {
      const bridge = createIpcToWsBridge(getWsClient);

      const responsePromise = bridge(ipcRequest({ id: 'req-3', type: 'uploadFile', payload: { chatId: 'c1', filePath: '/tmp/file' } }));

      const requestId = getLastSentRequestId(wsClient)!;
      expect(JSON.parse(wsClient.send.mock.calls[0]?.[0] as string).action).toBe('uploadFile');

      const messageHandler = wsClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'message',
      )?.[1] as Function;
      messageHandler!(Buffer.from(JSON.stringify({
        type: 'feishu-api-response', requestId, success: true, data: { fileKey: 'fk_123' },
      })));

      const result = await responsePromise;
      expect(result.success).toBe(true);
    });
  });

  // =========================================================================
  // Response Correlation
  // =========================================================================

  describe('response correlation', () => {
    it('should correlate response to original request ID', async () => {
      const bridge = createIpcToWsBridge(getWsClient);

      const responsePromise = bridge(ipcRequest({ id: 'original-id', type: 'sendMessage', payload: { chatId: 'c1', text: 'hi' } }));

      const requestId = getLastSentRequestId(wsClient)!;
      const messageHandler = wsClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'message',
      )?.[1] as Function;
      messageHandler!(Buffer.from(JSON.stringify({
        type: 'feishu-api-response', requestId, success: true, data: 'ok',
      })));

      const result = await responsePromise;
      expect(result.id).toBe('original-id');
    });

    it('should handle error response from primary node', async () => {
      const bridge = createIpcToWsBridge(getWsClient);

      const responsePromise = bridge(ipcRequest({ id: 'req-err', type: 'sendMessage', payload: { chatId: 'c1', text: 'hi' } }));

      const requestId = getLastSentRequestId(wsClient)!;
      const messageHandler = wsClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'message',
      )?.[1] as Function;
      messageHandler!(Buffer.from(JSON.stringify({
        type: 'feishu-api-response', requestId, success: false, error: 'Rate limited',
      })));

      const result = await responsePromise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('Rate limited');
    });

    it('should ignore responses for unknown request IDs and timeout', async () => {
      const bridge = createIpcToWsBridge(getWsClient);

      const responsePromise = bridge(ipcRequest({ id: 'req-1', type: 'sendMessage', payload: { chatId: 'c1', text: 'hi' } }));

      // Send response for unknown request
      const messageHandler = wsClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'message',
      )?.[1] as Function;
      messageHandler!(Buffer.from(JSON.stringify({
        type: 'feishu-api-response', requestId: 'unknown-id', success: true, data: {},
      })));

      // Original request should timeout
      await vi.advanceTimersByTimeAsync(30000);
      await expect(responsePromise).rejects.toThrow('timeout');
    });
  });

  // =========================================================================
  // Timeout
  // =========================================================================

  describe('timeout handling', () => {
    it('should timeout after configured duration', async () => {
      const bridge = createIpcToWsBridge(getWsClient, { timeout: 5000 });

      const responsePromise = bridge(ipcRequest({ id: 'req-timeout', type: 'sendMessage', payload: { chatId: 'c1', text: 'hi' } }));

      await vi.advanceTimersByTimeAsync(5000);

      await expect(responsePromise).rejects.toThrow('timeout');
    });

    it('should use default timeout of 30000ms when not configured', async () => {
      const bridge = createIpcToWsBridge(getWsClient);

      const responsePromise = bridge(ipcRequest({ id: 'req-default', type: 'sendMessage', payload: { chatId: 'c1', text: 'hi' } }));

      await vi.advanceTimersByTimeAsync(29999);
      await vi.advanceTimersByTimeAsync(1);
      await expect(responsePromise).rejects.toThrow('timeout');
    });
  });

  // =========================================================================
  // WebSocket Lifecycle
  // =========================================================================

  describe('WebSocket lifecycle', () => {
    it('should reject pending requests when WebSocket closes', async () => {
      const bridge = createIpcToWsBridge(getWsClient);

      const responsePromise = bridge(ipcRequest({ id: 'req-close', type: 'sendMessage', payload: { chatId: 'c1', text: 'hi' } }));

      const closeHandler = wsClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'close',
      )?.[1] as Function;

      expect(closeHandler).toBeDefined();
      closeHandler!();

      await expect(responsePromise).rejects.toThrow('closed');
    });

    it('should handle invalid JSON in WebSocket message without throwing', async () => {
      const bridge = createIpcToWsBridge(getWsClient);

      const responsePromise = bridge(ipcRequest({ id: 'req-json', type: 'sendMessage', payload: { chatId: 'c1', text: 'hi' } }));

      const messageHandler = wsClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'message',
      )?.[1] as Function;

      expect(messageHandler).toBeDefined();

      // Send invalid JSON — should not throw
      expect(() => messageHandler!(Buffer.from('not json'))).not.toThrow();

      // Resolve the pending request
      const requestId = getLastSentRequestId(wsClient)!;
      messageHandler!(Buffer.from(JSON.stringify({
        type: 'feishu-api-response', requestId, success: true, data: {},
      })));

      const result = await responsePromise;
      expect(result.success).toBe(true);
    });

    it('should handle send error gracefully', async () => {
      wsClient.send.mockImplementation(() => {
        throw new Error('Send failed');
      });

      const bridge = createIpcToWsBridge(getWsClient);

      await expect(
        bridge(ipcRequest({ id: 'req-send-err', type: 'sendMessage', payload: { chatId: 'c1', text: 'hi' } }))
      ).rejects.toThrow('Send failed');
    });
  });

  // =========================================================================
  // Message Handler Attachment
  // =========================================================================

  describe('message handler attachment', () => {
    it('should attach message handler on first request', async () => {
      const bridge = createIpcToWsBridge(getWsClient);

      const responsePromise = bridge(ipcRequest({ id: 'req-1', type: 'sendMessage', payload: { chatId: 'c1', text: 'hi' } }));

      expect(wsClient.on).toHaveBeenCalledWith('message', expect.any(Function));
      expect(wsClient.on).toHaveBeenCalledWith('close', expect.any(Function));

      // Clean up
      const requestId = getLastSentRequestId(wsClient)!;
      const messageHandler = wsClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'message',
      )?.[1] as Function;
      messageHandler!(Buffer.from(JSON.stringify({
        type: 'feishu-api-response', requestId, success: true, data: {},
      })));
      await responsePromise;
    });

    it('should not attach duplicate message handlers on subsequent requests', async () => {
      const bridge = createIpcToWsBridge(getWsClient);

      // First request
      const p1 = bridge(ipcRequest({ id: 'req-1', type: 'sendMessage', payload: { chatId: 'c1', text: 'hi' } }));
      const messageHandler = wsClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'message',
      )?.[1] as Function;

      const requestId1 = getLastSentRequestId(wsClient)!;
      messageHandler!(Buffer.from(JSON.stringify({
        type: 'feishu-api-response', requestId: requestId1, success: true, data: {},
      })));
      await p1;

      const messageHandlerCountBefore = wsClient.on.mock.calls.filter(
        (call: any[]) => call[0] === 'message'
      ).length;

      // Second request
      const p2 = bridge(ipcRequest({ id: 'req-2', type: 'sendMessage', payload: { chatId: 'c1', text: 'hi' } }));
      const requestId2 = getLastSentRequestId(wsClient)!;
      messageHandler!(Buffer.from(JSON.stringify({
        type: 'feishu-api-response', requestId: requestId2, success: true, data: {},
      })));
      await p2;

      const messageHandlerCountAfter = wsClient.on.mock.calls.filter(
        (call: any[]) => call[0] === 'message'
      ).length;
      expect(messageHandlerCountAfter).toBe(messageHandlerCountBefore);
    });

    it('should re-attach handler when wsClient is undefined initially', async () => {
      // First call: no ws client
      getWsClient.mockReturnValue(undefined);
      const bridge = createIpcToWsBridge(getWsClient);

      const result = await bridge(ipcRequest({ id: 'req-1', type: 'sendMessage', payload: { chatId: 'c1', text: 'hi' } }));
      expect(result.success).toBe(false);

      // Second call: ws client available
      const newClient = createMockWsClient();
      getWsClient.mockReturnValue(newClient);

      const p2 = bridge(ipcRequest({ id: 'req-2', type: 'sendMessage', payload: { chatId: 'c1', text: 'hi' } }));
      expect(newClient.on).toHaveBeenCalledWith('message', expect.any(Function));
      expect(newClient.on).toHaveBeenCalledWith('close', expect.any(Function));

      // Resolve
      const requestId = getLastSentRequestId(newClient)!;
      const newMessageHandler = newClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'message',
      )?.[1] as Function;
      newMessageHandler!(Buffer.from(JSON.stringify({
        type: 'feishu-api-response', requestId, success: true, data: {},
      })));

      const result2 = await p2;
      expect(result2.success).toBe(true);
    });
  });
});
