/**
 * Tests for ACP client connection management.
 *
 * Issue #1333: ACP protocol infrastructure — PR A.
 */

import { describe, it, expect, vi } from 'vitest';
import { AcpClient } from '../acp-client.js';
import type { IAcpTransport, TransportEvents } from '../transport.js';
import { serializeMessage } from '../json-rpc.js';

/**
 * 创建模拟传输层
 */
function createMockTransport(): IAcpTransport & {
  sent: string[];
  simulateResponse: (id: number, result: unknown) => void;
  simulateErrorResponse: (id: number, code: number, message: string) => void;
  simulateNotification: (method: string, params: unknown) => void;
} {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  const transport = {
    sent: [] as string[],
    connected: true,
    send(message: unknown) {
      transport.sent.push(serializeMessage(message as Parameters<typeof serializeMessage>[0]).trim());
    },
    close() {
      // no-op
    },
    on<K extends keyof TransportEvents>(event: K, listener: (...args: TransportEvents[K]) => void) {
      if (!listeners.has(event)) {
        listeners.set(event, []);
      }
      listeners.get(event)?.push(listener as (...args: unknown[]) => void);
    },
    off<K extends keyof TransportEvents>(event: K, listener: (...args: TransportEvents[K]) => void) {
      const eventListeners = listeners.get(event);
      if (eventListeners) {
        const idx = eventListeners.indexOf(listener as (...args: unknown[]) => void);
        if (idx >= 0) {
          eventListeners.splice(idx, 1);
        }
      }
    },
    simulateResponse(id: number, result: unknown) {
      const responseHandlers = listeners.get('response') ?? [];
      for (const handler of responseHandlers) {
        handler({ jsonrpc: '2.0', id, result });
      }
    },
    simulateErrorResponse(id: number, code: number, message: string) {
      const responseHandlers = listeners.get('response') ?? [];
      for (const handler of responseHandlers) {
        handler({ jsonrpc: '2.0', id, error: { code, message } });
      }
    },
    simulateNotification(method: string, params: unknown) {
      const notifHandlers = listeners.get('notification') ?? [];
      for (const handler of notifHandlers) {
        handler({ jsonrpc: '2.0', method, params });
      }
    },
  };

  return transport;
}

/** Helper: initialize a client with default params */
function initClient(client: AcpClient, transport: ReturnType<typeof createMockTransport>) {
  const initPromise = client.initialize({
    clientInfo: { name: 'test', version: '1.0.0' },
    capabilities: {},
  });

  const sent = JSON.parse(transport.sent[0]);
  transport.simulateResponse(sent.id, {
    serverInfo: { name: 'server', version: '1.0' },
    capabilities: {},
  });

  return initPromise;
}

describe('AcpClient', () => {
  describe('initialize', () => {
    it('should send initialize request and return server info', async () => {
      const transport = createMockTransport();
      const client = new AcpClient({ transport });

      try {
        const initPromise = client.initialize({
          clientInfo: { name: 'disclaude', version: '1.0.0' },
          capabilities: { streaming: true },
        });

        expect(transport.sent).toHaveLength(1);
        const sent = JSON.parse(transport.sent[0]);
        expect(sent.method).toBe('initialize');
        expect(sent.params.clientInfo.name).toBe('disclaude');

        transport.simulateResponse(sent.id, {
          serverInfo: { name: 'claude-acp', version: '0.1.0' },
          capabilities: { protocolVersion: ['2025-01-01'] },
        });

        const result = await initPromise;
        expect(result.serverInfo.name).toBe('claude-acp');
        expect(result.serverInfo.version).toBe('0.1.0');
        expect(result.capabilities.protocolVersion).toEqual(['2025-01-01']);
      } finally {
        client.close();
      }
    });

    it('should set isInitialized after successful init', async () => {
      const transport = createMockTransport();
      const client = new AcpClient({ transport });

      try {
        expect(client.isInitialized).toBe(false);

        await initClient(client, transport);
        expect(client.isInitialized).toBe(true);
      } finally {
        client.close();
      }
    });

    it('should store server capabilities', async () => {
      const transport = createMockTransport();
      const client = new AcpClient({ transport });

      try {
        const initPromise = client.initialize({
          clientInfo: { name: 'test', version: '1.0.0' },
          capabilities: {},
        });

        const sent = JSON.parse(transport.sent[0]);
        transport.simulateResponse(sent.id, {
          serverInfo: { name: 'server', version: '1.0' },
          capabilities: {
            protocolVersion: ['2025-01-01'],
            sessions: { loadSession: true, forkSession: false },
          },
        });

        await initPromise;
        expect(client.capabilities?.protocolVersion).toEqual(['2025-01-01']);
        expect(client.capabilities?.sessions?.loadSession).toBe(true);
      } finally {
        client.close();
      }
    });

    it('should reject duplicate initialization', async () => {
      const transport = createMockTransport();
      const client = new AcpClient({ transport });

      try {
        await initClient(client, transport);

        await expect(
          client.initialize({
            clientInfo: { name: 'test', version: '1.0.0' },
            capabilities: {},
          })
        ).rejects.toThrow('already initialized');
      } finally {
        client.close();
      }
    });

    it('should reject on error response', async () => {
      const transport = createMockTransport();
      const client = new AcpClient({ transport });

      try {
        const initPromise = client.initialize({
          clientInfo: { name: 'test', version: '1.0.0' },
          capabilities: {},
        });

        const sent = JSON.parse(transport.sent[0]);
        transport.simulateErrorResponse(sent.id, -32601, 'Method not found');

        await expect(initPromise).rejects.toThrow('Method not found');
      } finally {
        client.close();
      }
    });

    it('should reject on timeout', async () => {
      vi.useFakeTimers();

      const transport = createMockTransport();
      const client = new AcpClient({ transport, requestTimeoutMs: 5000 });

      try {
        const initPromise = client.initialize({
          clientInfo: { name: 'test', version: '1.0.0' },
          capabilities: {},
        });

        vi.advanceTimersByTime(6000);

        await expect(initPromise).rejects.toThrow('timed out');
      } finally {
        vi.useRealTimers();
        client.close();
      }
    });
  });

  describe('session methods', () => {
    it('should reject if not initialized', async () => {
      const transport = createMockTransport();
      const client = new AcpClient({ transport });

      try {
        await expect(client.newSession()).rejects.toThrow('not initialized');
      } finally {
        client.close();
      }
    });

    it('newSession should send request and return sessionId', async () => {
      const transport = createMockTransport();
      const client = new AcpClient({ transport });

      try {
        await initClient(client, transport);
        transport.sent = [];

        const promise = client.newSession({ metadata: { project: 'test' } });

        const sent = JSON.parse(transport.sent[0]);
        expect(sent.method).toBe('newSession');
        expect(sent.params.metadata.project).toBe('test');

        transport.simulateResponse(sent.id, { sessionId: 'session-123' });

        const result = await promise;
        expect(result.sessionId).toBe('session-123');
      } finally {
        client.close();
      }
    });

    it('listSessions should send request and return sessions', async () => {
      const transport = createMockTransport();
      const client = new AcpClient({ transport });

      try {
        await initClient(client, transport);
        transport.sent = [];

        const promise = client.listSessions({ filter: { limit: 10 } });

        const sent = JSON.parse(transport.sent[0]);
        expect(sent.method).toBe('listSessions');

        transport.simulateResponse(sent.id, {
          sessions: [
            { sessionId: 's1', createdAt: '2025-01-01' },
            { sessionId: 's2' },
          ],
        });

        const result = await promise;
        expect(result.sessions).toHaveLength(2);
        expect(result.sessions[0].sessionId).toBe('s1');
      } finally {
        client.close();
      }
    });

    it('closeSession should send request', async () => {
      const transport = createMockTransport();
      const client = new AcpClient({ transport });

      try {
        await initClient(client, transport);
        transport.sent = [];

        const promise = client.closeSession({ sessionId: 's1' });

        const sent = JSON.parse(transport.sent[0]);
        expect(sent.method).toBe('closeSession');

        transport.simulateResponse(sent.id, { closed: true });

        const result = await promise;
        expect(result.closed).toBe(true);
      } finally {
        client.close();
      }
    });
  });

  describe('prompt', () => {
    it('should send prompt request and return result', async () => {
      const transport = createMockTransport();
      const client = new AcpClient({ transport });

      try {
        await initClient(client, transport);
        transport.sent = [];

        const promise = client.prompt({
          sessionId: 'session-123',
          message: { role: 'user', content: 'Hello' },
          stream: false,
        });

        const sent = JSON.parse(transport.sent[0]);
        expect(sent.method).toBe('prompt');
        expect(sent.params.sessionId).toBe('session-123');
        expect(sent.params.message.content).toBe('Hello');

        transport.simulateResponse(sent.id, {
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 20 },
        });

        const result = await promise;
        expect(result.stopReason).toBe('end_turn');
        expect(result.usage.inputTokens).toBe(10);
        expect(result.usage.outputTokens).toBe(20);
      } finally {
        client.close();
      }
    });
  });

  describe('notifications', () => {
    it('should deliver sessionUpdate notifications to handlers', async () => {
      const transport = createMockTransport();
      const client = new AcpClient({ transport });

      try {
        await initClient(client, transport);

        const handler = vi.fn();
        client.onSessionUpdate(handler);

        transport.simulateNotification('sessionUpdate', {
          sessionId: 's1',
          update: { type: 'text', text: 'Hello!' },
        });

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0][0].sessionId).toBe('s1');
        expect((handler.mock.calls[0][0].update as { type: string; text: string }).text).toBe('Hello!');
      } finally {
        client.close();
      }
    });

    it('should support unsubscribing from notifications', async () => {
      const transport = createMockTransport();
      const client = new AcpClient({ transport });

      try {
        await initClient(client, transport);

        const handler = vi.fn();
        const unsubscribe = client.onSessionUpdate(handler);

        unsubscribe();

        transport.simulateNotification('sessionUpdate', {
          sessionId: 's1',
          update: { type: 'text', text: 'Hello!' },
        });

        expect(handler).not.toHaveBeenCalled();
      } finally {
        client.close();
      }
    });
  });

  describe('close', () => {
    it('should reject pending requests', async () => {
      const transport = createMockTransport();
      const client = new AcpClient({ transport });

      const initPromise = client.initialize({
        clientInfo: { name: 'test', version: '1.0.0' },
        capabilities: {},
      });

      // Don't respond - leave request pending
      client.close();

      await expect(initPromise).rejects.toThrow('Client closed');
    });

    it('should close the transport and reset state', async () => {
      const transport = createMockTransport();
      const client = new AcpClient({ transport });

      try {
        await initClient(client, transport);

        const transportSpy = vi.spyOn(transport, 'close');
        client.close();

        expect(transportSpy).toHaveBeenCalled();
        expect(client.isInitialized).toBe(false);
        expect(client.capabilities).toBeNull();
      } finally {
        // Already closed
      }
    });
  });
});
