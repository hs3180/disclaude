/**
 * Tests for ACP transport layer.
 *
 * Issue #1333: ACP protocol infrastructure — PR A.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StdioTransport } from '../transport.js';
import { serializeMessage, createRequest, createNotification, resetIdCounter } from '../json-rpc.js';

/**
 * 创建模拟的可读流
 */
function createMockReadableStream(): NodeJS.ReadableStream & {
  _handlers: Record<string, Array<(data: unknown) => void>>;
  simulateData: (data: string) => void;
  simulateEnd: () => void;
  simulateError: (err: Error) => void;
} {
  const handlers: Record<string, Array<(data: unknown) => void>> = {
    data: [],
    end: [],
    error: [],
  };

  const stream = {
    on(event: string, handler: (data: unknown) => void) {
      if (!handlers[event]) {
        handlers[event] = [];
      }
      handlers[event].push(handler);
      return stream;
    },
    removeListener(event: string, _handler: unknown) {
      handlers[event] = [];
      return stream;
    },
    simulateData(data: string) {
      for (const h of handlers.data ?? []) {
        h(Buffer.from(data));
      }
    },
    simulateEnd() {
      for (const h of handlers.end ?? []) {
        (h as () => void)();
      }
    },
    simulateError(err: Error) {
      for (const h of handlers.error ?? []) {
        h(err);
      }
    },
  } as unknown as NodeJS.ReadableStream & {
    _handlers: Record<string, Array<(data: unknown) => void>>;
    simulateData: (data: string) => void;
    simulateEnd: () => void;
    simulateError: (err: Error) => void;
  };

  return stream;
}

/**
 * 创建模拟的可写流
 */
function createMockWritableStream(): NodeJS.WritableStream & {
  written: string[];
} {
  const result = {
    written: [] as string[],
    write(data: string) {
      result.written.push(data);
      return true;
    },
  };

  return result as unknown as NodeJS.WritableStream & { written: string[] };
}

describe('StdioTransport', () => {
  let mockReadable: ReturnType<typeof createMockReadableStream>;
  let mockWritable: ReturnType<typeof createMockWritableStream>;
  let transport: StdioTransport;

  beforeEach(() => {
    resetIdCounter();
    mockReadable = createMockReadableStream();
    mockWritable = createMockWritableStream();
    mockWritable.written = [];
    transport = new StdioTransport({
      stdin: mockWritable,
      stdout: mockReadable,
    });
  });

  afterEach(() => {
    transport.close();
  });

  describe('start', () => {
    it('should set connected to true', () => {
      expect(transport.connected).toBe(false);
      transport.start();
      expect(transport.connected).toBe(true);
    });

    it('should be idempotent', () => {
      transport.start();
      transport.start();
      expect(transport.connected).toBe(true);
    });
  });

  describe('send', () => {
    it('should throw if not connected', () => {
      expect(() => transport.send(createRequest('test'))).toThrow('not connected');
    });

    it('should write serialized message to writable stream', () => {
      transport.start();

      const request = createRequest('initialize', { key: 'value' }, 1);
      transport.send(request);

      expect(mockWritable.written).toHaveLength(1);
      expect(mockWritable.written[0]).toBe(serializeMessage(request));
    });

    it('should write notification messages', () => {
      transport.start();

      const notification = createNotification('sessionUpdate', { data: 42 });
      transport.send(notification);

      expect(mockWritable.written).toHaveLength(1);
      expect(mockWritable.written[0]).toContain('"method":"sessionUpdate"');
    });
  });

  describe('receive messages', () => {
    it('should emit "response" for JSON-RPC responses with id', () => {
      transport.start();

      const handler = vi.fn();
      transport.on('response', handler);

      const response = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { sessionId: 'abc' },
      });
      mockReadable.simulateData(`${response}\n`);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: { sessionId: 'abc' },
      });
    });

    it('should emit "notification" for JSON-RPC notifications without id', () => {
      transport.start();

      const handler = vi.fn();
      transport.on('notification', handler);

      const notification = JSON.stringify({
        jsonrpc: '2.0',
        method: 'sessionUpdate',
        params: { sessionId: 'abc' },
      });
      mockReadable.simulateData(`${notification}\n`);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].method).toBe('sessionUpdate');
    });

    it('should emit "error" for malformed JSON', () => {
      transport.start();

      const handler = vi.fn();
      transport.on('error', handler);

      mockReadable.simulateData('not valid json\n');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toBeInstanceOf(Error);
    });

    it('should emit "error" for invalid JSON-RPC messages', () => {
      transport.start();

      const handler = vi.fn();
      transport.on('error', handler);

      mockReadable.simulateData('{"id":1,"method":"test"}\n');

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should handle multiple messages in a single chunk', () => {
      transport.start();

      const responseHandler = vi.fn();
      transport.on('response', responseHandler);

      const batch =
        '{"jsonrpc":"2.0","id":1,"result":{}}\n' +
        '{"jsonrpc":"2.0","id":2,"result":{}}\n';

      mockReadable.simulateData(batch);

      expect(responseHandler).toHaveBeenCalledTimes(2);
    });

    it('should handle messages split across chunks', () => {
      transport.start();

      const responseHandler = vi.fn();
      transport.on('response', responseHandler);

      // Split a message across two chunks
      mockReadable.simulateData('{"jsonrpc":"2.0","id":1,"res');
      mockReadable.simulateData('ult":{}}\n');

      expect(responseHandler).toHaveBeenCalledTimes(1);
    });

    it('should skip empty lines', () => {
      transport.start();

      const responseHandler = vi.fn();
      transport.on('response', responseHandler);

      mockReadable.simulateData('\n\n{"jsonrpc":"2.0","id":1,"result":{}}\n\n');

      expect(responseHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('close', () => {
    it('should set connected to false', () => {
      transport.start();
      transport.close();
      expect(transport.connected).toBe(false);
    });

    it('should emit "close" event', () => {
      transport.start();

      const handler = vi.fn();
      transport.on('close', handler);
      transport.close();

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should be idempotent', () => {
      transport.start();
      transport.close();
      transport.close();
    });

    it('should emit "close" when readable stream ends', () => {
      transport.start();

      const handler = vi.fn();
      transport.on('close', handler);
      mockReadable.simulateEnd();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(transport.connected).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should emit "error" when readable stream errors', () => {
      transport.start();

      const handler = vi.fn();
      transport.on('error', handler);

      mockReadable.simulateError(new Error('Stream error'));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].message).toBe('Stream error');
    });
  });
});
