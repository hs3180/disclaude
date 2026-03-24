/**
 * Claude ACP Provider Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ClaudeAcpProvider } from './claude-provider.js';
import { adaptStopReason } from './message-adapter.js';
import { AsyncMessageQueue, createStreamPair } from './stream-pair.js';
// ============================================================================
// adaptStopReason Tests
// ============================================================================

describe('adaptStopReason', () => {
  it('should map end_turn to Chinese description', () => {
    expect(adaptStopReason('end_turn')).toBe('正常完成');
  });

  it('should map max_tokens to Chinese description', () => {
    expect(adaptStopReason('max_tokens')).toBe('达到 token 上限');
  });

  it('should return original string for unknown reasons', () => {
    expect(adaptStopReason('unknown_reason')).toBe('unknown_reason');
  });
});

// ============================================================================
// AsyncMessageQueue Tests
// ============================================================================

describe('AsyncMessageQueue', () => {
  it('should push and pop messages in order', async () => {
    const queue = new AsyncMessageQueue<string>();
    queue.push('first');
    queue.push('second');
    queue.push('third');

    expect(await queue.next()).toBe('first');
    expect(await queue.next()).toBe('second');
    expect(await queue.next()).toBe('third');
  });

  it('should wait for messages when queue is empty', async () => {
    const queue = new AsyncMessageQueue<string>();

    // Start waiting for a message
    const promise = queue.next();

    // Push a message after a short delay
    setTimeout(() => queue.push('delayed'), 10);

    expect(await promise).toBe('delayed');
  });

  it('should return null when closed', async () => {
    const queue = new AsyncMessageQueue<string>();
    queue.close();

    expect(await queue.next()).toBeNull();
  });

  it('should return null after consuming remaining messages and closing', async () => {
    const queue = new AsyncMessageQueue<string>();
    queue.push('existing');
    queue.close();

    expect(await queue.next()).toBe('existing');
    expect(await queue.next()).toBeNull();
  });

  it('should resolve pending waiters on close', async () => {
    const queue = new AsyncMessageQueue<string>();

    const promise = queue.next();
    queue.close();

    expect(await promise).toBeNull();
  });

  it('should clear all messages', async () => {
    const queue = new AsyncMessageQueue<string>();
    queue.push('a');
    queue.push('b');
    queue.clear();
    queue.close();

    expect(await queue.next()).toBeNull();
  });
});

// ============================================================================
// Stream Pair Tests
// ============================================================================

describe('createStreamPair', () => {
  it('should create connected streams', async () => {
    const [agentStream, clientStream] = createStreamPair();

    // Both streams should be valid
    expect(agentStream.writable).toBeDefined();
    expect(agentStream.readable).toBeDefined();
    expect(clientStream.writable).toBeDefined();
    expect(clientStream.readable).toBeDefined();
  });
});

// ============================================================================
// ClaudeAcpProvider Tests
// ============================================================================

describe('ClaudeAcpProvider', () => {
  let provider: ClaudeAcpProvider;

  beforeEach(() => {
    provider = new ClaudeAcpProvider();
    // Ensure API key is set for tests
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    provider.dispose();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('should have correct name and version', () => {
    expect(provider.name).toBe('claude-acp');
    expect(provider.version).toBe('1.0.0');
  });

  it('should return provider info', () => {
    const info = provider.getInfo();

    expect(info.name).toBe('claude-acp');
    expect(info.version).toBe('1.0.0');
    expect(info.available).toBe(true);
  });

  it('should validate config with API key', () => {
    expect(provider.validateConfig()).toBe(true);
  });

  it('should fail validation without API key', () => {
    delete process.env.ANTHROPIC_API_KEY;
    const info = provider.getInfo();
    expect(info.available).toBe(false);
    expect(info.unavailableReason).toContain('ANTHROPIC_API_KEY');
  });

  it('should throw when disposed provider is initialized', async () => {
    provider.dispose();

    await expect(provider.initialize()).rejects.toThrow('disposed');
  });

  it('should create inline tool config', () => {
    const tool = provider.createInlineTool({
      name: 'test_tool',
      description: 'A test tool',
      parameters: {} as any,
      handler: async () => 'result',
    });

    expect(tool).toEqual({
      name: 'test_tool',
      description: 'A test tool',
      inputSchema: {},
    });
  });

  it('should create stdio MCP server config', () => {
    const server = provider.createMcpServer({
      type: 'stdio',
      name: 'test-server',
      command: 'node',
      args: ['server.js'],
    });

    expect(server).toEqual({
      name: 'test-server',
      command: 'node',
      args: ['server.js'],
      env: {},
    });
  });

  it('should create inline MCP server config', () => {
    const server = provider.createMcpServer({
      type: 'inline',
      name: 'inline-server',
      version: '1.0.0',
      tools: [
        {
          name: 'inline_tool',
          description: 'An inline tool',
          parameters: {} as any,
          handler: async () => 'result',
        },
      ],
    });

    expect(server).toEqual({
      name: 'inline-server',
      tools: [
        {
          name: 'inline_tool',
          description: 'An inline tool',
          inputSchema: {},
        },
      ],
    });
  });

  it('should handle double dispose gracefully', () => {
    provider.dispose();
    provider.dispose(); // Should not throw
  });
});
