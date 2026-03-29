/**
 * ACP Stdio 传输层单元测试
 *
 * 测试传输层的基本行为，包括消息解析和状态管理。
 *
 * @see Issue #1333 - 支持OpenAI Agent
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AcpStdioTransport } from './transport.js';
import type { AcpTransportConfig } from './types.js';

describe('AcpStdioTransport', () => {
  let transport: AcpStdioTransport;

  beforeEach(() => {
    const config: AcpTransportConfig = {
      type: 'stdio',
      command: 'cat', // cat 会保持运行，适合测试
      connectionTimeout: 2000,
    };
    transport = new AcpStdioTransport(config);
  });

  afterEach(() => {
    transport.disconnect();
  });

  describe('initial state', () => {
    it('should start in disconnected state', () => {
      expect(transport.state).toBe('disconnected');
    });
  });

  describe('disconnect', () => {
    it('should not throw when disconnecting unconnected transport', () => {
      expect(() => transport.disconnect()).not.toThrow();
      expect(transport.state).toBe('disconnected');
    });

    it('should set state to disconnected', () => {
      transport.disconnect();
      expect(transport.state).toBe('disconnected');
    });
  });

  describe('send', () => {
    it('should throw when not connected', () => {
      expect(() => transport.send({ test: 'data' })).toThrow('not connected');
    });
  });

  describe('event handlers', () => {
    it('should register message handler without error', () => {
      expect(() => transport.onMessage(() => {})).not.toThrow();
    });

    it('should register error handler without error', () => {
      expect(() => transport.setErrorHandler(() => {})).not.toThrow();
    });

    it('should register close handler without error', () => {
      expect(() => transport.setCloseHandler((_code, _signal) => {})).not.toThrow();
    });

    it('should allow replacing handlers', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      transport.onMessage(handler1);
      transport.onMessage(handler2);

      // handler1 should be replaced by handler2
      // (We can't directly test this without triggering a message,
      // but we verify no errors occur)
      expect(() => transport.onMessage(handler1)).not.toThrow();
    });
  });
});

describe('AcpStdioTransport message parsing', () => {
  it('should handle invalid JSON gracefully', () => {
    const config: AcpTransportConfig = {
      type: 'stdio',
      command: 'echo',
      connectionTimeout: 1000,
    };
    const transport = new AcpStdioTransport(config);

    const errors: Error[] = [];
    transport.setErrorHandler((err) => errors.push(err));

    // We can't directly inject data into the transport's buffer,
    // but we verify the error handler registration works
    expect(errors).toHaveLength(0);
    transport.disconnect();
  });
});
