/**
 * ACP Provider Unit Tests
 *
 * Tests for the ACP (Agent Client Protocol) provider implementation.
 * Uses mocking for the ACP SDK subprocess and connection.
 *
 * @module sdk/providers/acp/acp-provider.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MessageBridge } from './types.js';
import { adaptACPUpdate, userInputToACPPrompt, formatStopReason } from './message-adapter.js';
import { adaptOptionsToSession, adaptMcpServers, parseACPConfigFromEnv } from './options-adapter.js';
import { ACPProvider } from './provider.js';

// ============================================================================
// MessageBridge Tests
// ============================================================================

describe('MessageBridge', () => {
  it('should push and consume messages in order', async () => {
    const bridge = new MessageBridge();
    const messages = [
      { type: 'text' as const, content: 'hello', role: 'assistant' as const },
      { type: 'text' as const, content: 'world', role: 'assistant' as const },
    ];

    bridge.push(messages[0]);
    bridge.push(messages[1]);
    bridge.finish();

    const first = await bridge.next();
    expect(first).toEqual(messages[0]);

    const second = await bridge.next();
    expect(second).toEqual(messages[1]);

    const third = await bridge.next();
    expect(third).toBeNull();
  });

  it('should resolve waiting consumers when messages arrive', async () => {
    const bridge = new MessageBridge();

    // Start waiting before pushing
    const nextPromise = bridge.next();

    // Push a message (should resolve the waiter)
    bridge.push({ type: 'text', content: 'delayed', role: 'assistant' });
    bridge.finish();

    const result = await nextPromise;
    expect(result?.content).toBe('delayed');
  });

  it('should return null after finish when buffer is empty', async () => {
    const bridge = new MessageBridge();
    bridge.finish();

    const result = await bridge.next();
    expect(result).toBeNull();
  });

  it('should ignore pushes after finish', async () => {
    const bridge = new MessageBridge();
    bridge.finish();

    bridge.push({ type: 'text', content: 'ignored', role: 'assistant' });

    const result = await bridge.next();
    expect(result).toBeNull();
  });

  it('should reset and allow new messages', async () => {
    const bridge = new MessageBridge();

    bridge.push({ type: 'text', content: 'first', role: 'assistant' });
    bridge.finish();

    const first = await bridge.next();
    expect(first?.content).toBe('first');
    const second = await bridge.next();
    expect(second).toBeNull();

    // Reset and push new messages
    bridge.reset();
    bridge.push({ type: 'text', content: 'second', role: 'assistant' });
    bridge.finish();

    const third = await bridge.next();
    expect(third?.content).toBe('second');
  });

  it('should report isFinished correctly', () => {
    const bridge = new MessageBridge();
    expect(bridge.isFinished).toBe(false);

    bridge.finish();
    expect(bridge.isFinished).toBe(true);

    bridge.reset();
    expect(bridge.isFinished).toBe(false);
  });
});

// ============================================================================
// Message Adapter Tests
// ============================================================================

describe('adaptACPUpdate', () => {
  it('should adapt agent_message_chunk to text message', async () => {
    const bridge = new MessageBridge();

    adaptACPUpdate(
      {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello world' },
          messageId: 'msg-123',
        },
      },
      bridge
    );
    bridge.finish();

    const msg = await bridge.next();
    expect(msg).not.toBeNull();
    expect(msg?.type).toBe('text');
    expect(msg?.content).toBe('Hello world');
    expect(msg?.metadata?.messageId).toBe('msg-123');
  });

  it('should adapt tool_call to tool_use message', async () => {
    const bridge = new MessageBridge();

    adaptACPUpdate(
      {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-1',
          title: 'Read file',
          kind: 'read',
          status: 'pending',
          rawInput: { path: '/test/file.ts' },
        },
      },
      bridge
    );
    bridge.finish();

    // Consume all messages
    const messages: Array<{ type: string; content: string; metadata?: { toolName?: string } }> = [];
    let msg = await bridge.next();
    while (msg) {
      messages.push(msg);
      msg = await bridge.next();
    }

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('tool_use');
    expect(messages[0].content).toContain('Reading');
    expect(messages[0].metadata?.toolName).toBe('Read file');
  });

  it('should adapt tool_call_update completed to tool_result', async () => {
    const bridge = new MessageBridge();

    adaptACPUpdate(
      {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-1',
          status: 'completed',
          content: [
            { type: 'content', content: { type: 'text', text: 'file contents here' } },
          ],
        },
      },
      bridge
    );
    bridge.finish();

    const messages: Array<{ type: string; content: string }> = [];
    let msg = await bridge.next();
    while (msg) {
      messages.push(msg);
      msg = await bridge.next();
    }

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('tool_result');
    expect(messages[0].content).toContain('file contents here');
  });

  it('should adapt tool_call_update failed to error', async () => {
    const bridge = new MessageBridge();

    adaptACPUpdate(
      {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-2',
          status: 'failed',
        },
      },
      bridge
    );
    bridge.finish();

    const messages: Array<{ type: string; content: string }> = [];
    let msg = await bridge.next();
    while (msg) {
      messages.push(msg);
      msg = await bridge.next();
    }

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('error');
    expect(messages[0].content).toContain('failed');
  });

  it('should skip user_message_chunk', async () => {
    const bridge = new MessageBridge();

    adaptACPUpdate(
      {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'user said this' },
        },
      },
      bridge
    );
    bridge.finish();

    const msg = await bridge.next();
    expect(msg).toBeNull();
  });

  it('should adapt plan to status message', async () => {
    const bridge = new MessageBridge();

    adaptACPUpdate(
      {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'plan',
          title: 'Step 1: Analyze code',
        },
      },
      bridge
    );
    bridge.finish();

    const messages: Array<{ type: string; content: string }> = [];
    let msg = await bridge.next();
    while (msg) {
      messages.push(msg);
      msg = await bridge.next();
    }

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('status');
    expect(messages[0].content).toContain('Step 1: Analyze code');
  });
});

describe('userInputToACPPrompt', () => {
  it('should convert string input to ACP prompt', () => {
    const result = userInputToACPPrompt('Hello world');
    expect(result).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  it('should convert UserInput array to ACP prompt', () => {
    const result = userInputToACPPrompt([
      { role: 'user', content: 'First message' },
      { role: 'user', content: [{ type: 'text', text: 'Second message' }] },
    ]);
    expect(result).toEqual([
      { type: 'text', text: 'First message' },
      { type: 'text', text: 'Second message' },
    ]);
  });

  it('should handle image content blocks', () => {
    const result = userInputToACPPrompt([
      {
        role: 'user',
        content: [
          { type: 'image', data: 'base64data', mimeType: 'image/png' },
        ],
      },
    ]);
    expect(result).toEqual([
      { type: 'text', text: '[non-text content]' },
    ]);
  });
});

describe('formatStopReason', () => {
  it('should format end_turn', () => {
    expect(formatStopReason('end_turn')).toBe('✅ Complete');
  });

  it('should format max_tokens', () => {
    expect(formatStopReason('max_tokens')).toContain('max tokens');
  });

  it('should format max_turn_requests', () => {
    expect(formatStopReason('max_turn_requests')).toContain('max turn requests');
  });

  it('should format refusal', () => {
    expect(formatStopReason('refusal')).toContain('refused');
  });

  it('should format cancelled', () => {
    expect(formatStopReason('cancelled')).toContain('cancelled');
  });
});

// ============================================================================
// Options Adapter Tests
// ============================================================================

describe('adaptOptionsToSession', () => {
  it('should convert options with cwd', () => {
    const result = adaptOptionsToSession({
      cwd: '/workspace',
      settingSources: ['test'],
    });
    expect(result.cwd).toBe('/workspace');
  });

  it('should convert options with MCP servers', () => {
    const result = adaptOptionsToSession({
      cwd: '/workspace',
      mcpServers: {
        'my-server': {
          type: 'stdio',
          name: 'my-server',
          command: 'node',
          args: ['server.js'],
        },
      },
      settingSources: ['test'],
    });
    expect(result.mcpServers).toHaveLength(1);
    expect(result.mcpServers?.[0].type).toBe('stdio');
    expect(result.mcpServers?.[0].command).toBe('node');
  });

  it('should handle empty options', () => {
    const result = adaptOptionsToSession({
      settingSources: ['test'],
    });
    expect(result.cwd).toBeUndefined();
    expect(result.mcpServers).toBeUndefined();
  });
});

describe('adaptMcpServers', () => {
  it('should convert stdio MCP servers', () => {
    const result = adaptMcpServers({
      'my-server': {
        type: 'stdio',
        name: 'my-server',
        command: 'npx',
        args: ['mcp-server'],
        env: { API_KEY: 'test' },
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'stdio',
      name: 'my-server',
      command: 'npx',
      args: ['mcp-server'],
      env: { API_KEY: 'test' },
    });
  });

  it('should skip inline MCP servers', () => {
    const result = adaptMcpServers({
      'inline-server': {
        type: 'inline',
        name: 'inline-server',
        version: '1.0.0',
      },
    });
    expect(result).toHaveLength(0);
  });
});

describe('parseACPConfigFromEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return null when ACP_PROVIDER_CONFIG is not set', () => {
    delete process.env.ACP_PROVIDER_CONFIG;
    expect(parseACPConfigFromEnv()).toBeNull();
  });

  it('should parse valid JSON config', () => {
    process.env.ACP_PROVIDER_CONFIG = JSON.stringify({
      agent: { command: 'claude', args: ['--dangerously-skip-permissions'] },
    });
    const config = parseACPConfigFromEnv();
    expect(config).not.toBeNull();
    expect(config?.agent.command).toBe('claude');
  });

  it('should return null for invalid JSON', () => {
    process.env.ACP_PROVIDER_CONFIG = 'not-json';
    expect(parseACPConfigFromEnv()).toBeNull();
  });
});

// ============================================================================
// ACPProvider Tests
// ============================================================================

describe('ACPProvider', () => {
  it('should create provider with default config', () => {
    const provider = new ACPProvider();
    expect(provider.name).toBe('acp');
    expect(provider.version).toBe('0.1.0');
  });

  it('should create provider with custom config', () => {
    const provider = new ACPProvider({
      agent: {
        command: 'codex',
        args: ['--full-auto'],
      },
    });
    expect(provider.name).toBe('acp');
    expect(provider.getInfo().available).toBe(true);
  });

  it('should return provider info', () => {
    const provider = new ACPProvider();
    const info = provider.getInfo();
    expect(info.name).toBe('acp');
    expect(info.version).toBe('0.1.0');
  });

  it('should validate config as true when ACP_PROVIDER_CONFIG is set', () => {
    process.env.ACP_PROVIDER_CONFIG = '{"agent":{"command":"claude"}}';
    const provider = new ACPProvider();
    expect(provider.validateConfig()).toBe(true);
    delete process.env.ACP_PROVIDER_CONFIG;
  });

  it('should throw on disposed provider queryOnce', async () => {
    const provider = new ACPProvider();
    provider.dispose();

    const gen = provider.queryOnce('test', { settingSources: ['test'] });
    await expect(gen.next()).rejects.toThrow('disposed');
  });

  it('should throw on disposed provider queryStream', () => {
    const provider = new ACPProvider();
    provider.dispose();

    expect(() =>
      provider.queryStream(
        (async function* () { /* empty */ })(),
        { settingSources: ['test'] }
      )
    ).toThrow('disposed');
  });

  it('should throw on createInlineTool', () => {
    const provider = new ACPProvider();
    expect(() =>
      provider.createInlineTool({
        name: 'test',
        description: 'test tool',
        parameters: {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        handler: () => Promise.resolve('result'),
      })
    ).toThrow('not supported by ACP provider');
  });

  it('should throw on createMcpServer for inline type', () => {
    const provider = new ACPProvider();
    expect(() =>
      provider.createMcpServer({
        type: 'inline',
        name: 'inline-server',
        version: '1.0.0',
      })
    ).toThrow('not supported by ACP provider');
  });

  it('should return config for stdio MCP server', () => {
    const provider = new ACPProvider();
    const result = provider.createMcpServer({
      type: 'stdio',
      name: 'test-server',
      command: 'node',
      args: ['server.js'],
    });
    expect(result).toEqual({
      type: 'stdio',
      name: 'test-server',
      command: 'node',
      args: ['server.js'],
    });
  });

  it('should dispose without errors', () => {
    const provider = new ACPProvider();
    expect(() => provider.dispose()).not.toThrow();
  });

  it('should be idempotent on dispose', () => {
    const provider = new ACPProvider();
    provider.dispose();
    expect(() => provider.dispose()).not.toThrow();
  });
});
