/**
 * Tests for ACP Transport Layer
 *
 * Verifies transport creation, message handling,
 * and connection lifecycle for stdio and SSE transports.
 *
 * Issue #1333: ACP protocol infrastructure
 */

import { describe, it, expect } from 'vitest';
import { createTransport, StdioTransport, SSETransport } from './transport.js';
import type { AcpStdioConfig, AcpSseConfig } from './types.js';

// ============================================================================
// Transport Factory
// ============================================================================

describe('createTransport', () => {
  it('should create StdioTransport for stdio config', () => {
    const config: AcpStdioConfig = {
      type: 'stdio',
      command: 'echo',
      args: ['hello'],
    };

    const transport = createTransport(config);
    expect(transport).toBeInstanceOf(StdioTransport);
  });

  it('should create SSETransport for sse config', () => {
    const config: AcpSseConfig = {
      type: 'sse',
      url: 'http://localhost:3000/acp',
    };

    const transport = createTransport(config);
    expect(transport).toBeInstanceOf(SSETransport);
  });

  it('should throw for unknown transport type', () => {
    const config = {
      type: 'websocket',
    } as unknown as AcpStdioConfig;

    expect(() => createTransport(config)).toThrow('Unknown transport type: websocket');
  });
});

// ============================================================================
// StdioTransport
// ============================================================================

describe('StdioTransport', () => {
  it('should report not connected initially', () => {
    const transport = new StdioTransport({
      type: 'stdio',
      command: 'echo',
    });

    expect(transport.connected).toBe(false);
  });

  it('should throw on send when not connected', async () => {
    const transport = new StdioTransport({
      type: 'stdio',
      command: 'echo',
    });

    await expect(transport.send({ jsonrpc: '2.0', method: 'test', id: 1 }))
      .rejects.toThrow('Transport not connected');
  });
});

// ============================================================================
// SSETransport
// ============================================================================

describe('SSETransport', () => {
  it('should report not connected initially', () => {
    const transport = new SSETransport({
      type: 'sse',
      url: 'http://localhost:3000/acp',
    });

    expect(transport.connected).toBe(false);
  });

  it('should throw on send when not connected', async () => {
    const transport = new SSETransport({
      type: 'sse',
      url: 'http://localhost:3000/acp',
    });

    await expect(transport.send({ jsonrpc: '2.0', method: 'test', id: 1 }))
      .rejects.toThrow('Transport not connected');
  });

  it('should accept custom headers config', () => {
    const config: AcpSseConfig = {
      type: 'sse',
      url: 'http://localhost:3000/acp',
      headers: {
        Authorization: 'Bearer token123',
      },
    };

    const transport = new SSETransport(config);
    expect(transport.connected).toBe(false);
  });
});
