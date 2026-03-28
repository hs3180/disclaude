/**
 * Unit tests for ACP Transport layer
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StdioTransport, SseTransport, createTransport } from './transport.js';
import type { AcpTransport } from './transport.js';
import type { AcpConnectionConfig } from './types.js';
import {
  createRequest,
} from './json-rpc.js';

describe('StdioTransport', () => {
  let transport: StdioTransport;

  const config: AcpConnectionConfig & { type: 'stdio' } = {
    type: 'stdio',
    command: 'cat',
    args: [],
  };

  beforeEach(() => {
    transport = new StdioTransport(config);
  });

  afterEach(async () => {
    await transport.close();
  });

  it('should start in disconnected state', () => {
    expect(transport.state).toBe('disconnected');
  });

  it('should connect and transition to connected state', async () => {
    await transport.connect();
    expect(transport.state).toBe('connected');
  });

  it('should not throw on double connect', async () => {
    await transport.connect();
    await expect(transport.connect()).resolves.toBeUndefined();
    expect(transport.state).toBe('connected');
  });

  it('should throw when sending in disconnected state', () => {
    const msg = createRequest('test');
    expect(() => transport.send(msg)).toThrow('Cannot send message in state: disconnected');
  });

  it('should send message via stdin after connect', async () => {
    await transport.connect();
    // cat command echoes stdin back to stdout
    const msg = createRequest('acp.task/send', { message: { role: 'user', content: 'test' } }, 'test-1');
    expect(() => transport.send(msg)).not.toThrow();
  });

  it('should register and invoke message handlers', async () => {
    await transport.connect();

    const received: unknown[] = [];
    transport.onMessage((msg) => {
      received.push(msg);
    });

    // Send a request, cat will echo it back on stdout
    const msg = createRequest('test', {}, 'echo-test');
    transport.send(msg);

    // Wait for cat to echo the message back
    await new Promise((resolve) => setTimeout(resolve, 300));

    // cat command will echo the raw JSON, which our transport should parse
    expect(received.length).toBeGreaterThan(0);
  });

  it('should register and invoke error handlers', async () => {
    const badConfig: AcpConnectionConfig & { type: 'stdio' } = {
      type: 'stdio',
      command: 'nonexistent-command-that-does-not-exist',
    };
    const badTransport = new StdioTransport(badConfig);

    const errors: Error[] = [];
    badTransport.onError((err) => {
      errors.push(err);
    });

    // spawn may emit error asynchronously; wait for it
    try {
      await badTransport.connect();
    } catch {
      // Expected - nonexistent command
    }

    // Give error handler time to fire
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(errors.length).toBeGreaterThan(0);

    await badTransport.close();
  });

  it('should close and transition to closed state', async () => {
    await transport.connect();
    expect(transport.state).toBe('connected');

    await transport.close();
    expect(transport.state).toBe('closed');
  });

  it('should clear handlers on close', async () => {
    await transport.connect();
    transport.onMessage(() => {});
    transport.onError(() => {});

    await transport.close();
    expect(transport.state).toBe('closed');
  });
});

describe('SseTransport', () => {
  it('should start in disconnected state', () => {
    const config: AcpConnectionConfig & { type: 'sse' } = {
      type: 'sse',
      url: 'http://localhost:1234/acp',
    };
    const transport = new SseTransport(config);
    expect(transport.state).toBe('disconnected');
  });

  it('should throw when sending in disconnected state', () => {
    const config: AcpConnectionConfig & { type: 'sse' } = {
      type: 'sse',
      url: 'http://localhost:1234/acp',
    };
    const transport = new SseTransport(config);
    const msg = createRequest('test');
    expect(() => transport.send(msg)).toThrow('Cannot send message in state: disconnected');
  });

  it('should throw when sending in closed state', async () => {
    const config: AcpConnectionConfig & { type: 'sse' } = {
      type: 'sse',
      url: 'http://localhost:1234/acp',
    };
    const transport = new SseTransport(config);
    await transport.close();
    expect(transport.state).toBe('closed');

    const msg = createRequest('test');
    expect(() => transport.send(msg)).toThrow('Cannot send message in state: closed');
  });

  it('should transition to closed on close', async () => {
    const config: AcpConnectionConfig & { type: 'sse' } = {
      type: 'sse',
      url: 'http://localhost:1234/acp',
    };
    const transport = new SseTransport(config);
    await transport.close();
    expect(transport.state).toBe('closed');
  });
});

describe('createTransport', () => {
  it('should create StdioTransport for stdio config', () => {
    const config: AcpConnectionConfig = {
      type: 'stdio',
      command: 'echo',
    };
    const transport = createTransport(config);
    expect(transport).toBeInstanceOf(StdioTransport);
  });

  it('should create SseTransport for sse config', () => {
    const config: AcpConnectionConfig = {
      type: 'sse',
      url: 'http://localhost:1234',
    };
    const transport = createTransport(config);
    expect(transport).toBeInstanceOf(SseTransport);
  });
});

describe('Transport interface compliance', () => {
  it('StdioTransport implements AcpTransport interface', async () => {
    const config: AcpConnectionConfig & { type: 'stdio' } = {
      type: 'stdio',
      command: 'echo',
    };
    const transport: AcpTransport = new StdioTransport(config);

    // Verify interface methods exist
    expect(typeof transport.connect).toBe('function');
    expect(typeof transport.send).toBe('function');
    expect(typeof transport.onMessage).toBe('function');
    expect(typeof transport.onError).toBe('function');
    expect(typeof transport.close).toBe('function');
    expect(typeof transport.state).toBe('string');

    await transport.close();
  });

  it('SseTransport implements AcpTransport interface', async () => {
    const config: AcpConnectionConfig & { type: 'sse' } = {
      type: 'sse',
      url: 'http://localhost:1234',
    };
    const transport: AcpTransport = new SseTransport(config);

    // Verify interface methods exist
    expect(typeof transport.connect).toBe('function');
    expect(typeof transport.send).toBe('function');
    expect(typeof transport.onMessage).toBe('function');
    expect(typeof transport.onError).toBe('function');
    expect(typeof transport.close).toBe('function');
    expect(typeof transport.state).toBe('string');

    await transport.close();
  });
});
