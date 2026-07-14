import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Config } from '@disclaude/core';
import type { Logger } from 'pino';
import { buildMcpServers, collectInlineMcpInstances } from './mcp-setup.js';

vi.mock('@disclaude/core', () => ({
  Config: {
    getMcpServersConfig: vi.fn(() => null),
  },
}));

vi.mock('@disclaude/mcp-server', () => ({
  createChannelMcpServer: vi.fn(() => ({ type: 'inline' })),
}));

const createMockLogger = (): Logger =>
  ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }) as unknown as Logger;

describe('buildMcpServers', () => {
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createMockLogger();
  });

  it('should return empty object when skipChannelMcp=true and no external config', () => {
    const callbacks = { getCapabilities: vi.fn() };
    const result = buildMcpServers('test-chat', callbacks, true, logger);

    expect(result).toEqual({});
    // skipChannelMcp=true → capabilities lookup is skipped
    expect(callbacks.getCapabilities).not.toHaveBeenCalled();
    // external config is still merged unconditionally; default mock returns null → empty result
    expect(Config.getMcpServersConfig).toHaveBeenCalledTimes(1);
  });

  it('should include channel-mcp when getCapabilities returns undefined', () => {
    const callbacks = { getCapabilities: vi.fn(() => undefined) };
    const result = buildMcpServers('test-chat', callbacks, false, logger);

    expect(result).toHaveProperty('channel-mcp');
    expect(result['channel-mcp']).toEqual({ type: 'inline' });
    expect(callbacks.getCapabilities).toHaveBeenCalledWith('test-chat');
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ ipcSocket: process.env.DISCLAUDE_WORKER_IPC_SOCKET }),
      'Configured channel MCP server (inline transport)',
    );
  });

  it('should include channel-mcp when supportedMcpTools contains a context tool', () => {
    const callbacks = {
      getCapabilities: vi.fn(() => ({ supportedMcpTools: ['send_text', 'other'] })),
    };
    const result = buildMcpServers('test-chat', callbacks, false, logger);

    expect(result).toHaveProperty('channel-mcp');
  });

  it('should include channel-mcp when supportedMcpTools contains send_interactive', () => {
    const callbacks = {
      getCapabilities: vi.fn(() => ({ supportedMcpTools: ['send_interactive'] })),
    };
    const result = buildMcpServers('test-chat', callbacks, false, logger);

    expect(result).toHaveProperty('channel-mcp');
  });

  it('should NOT include channel-mcp when supportedMcpTools is an empty array', () => {
    const callbacks = {
      getCapabilities: vi.fn(() => ({ supportedMcpTools: [] })),
    };
    const result = buildMcpServers('test-chat', callbacks, false, logger);

    expect(result).not.toHaveProperty('channel-mcp');
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('should NOT include channel-mcp when supportedMcpTools has no context tools', () => {
    const callbacks = {
      getCapabilities: vi.fn(() => ({ supportedMcpTools: ['some_other_tool'] })),
    };
    const result = buildMcpServers('test-chat', callbacks, false, logger);

    expect(result).not.toHaveProperty('channel-mcp');
  });

  it('should include channel-mcp when supportedMcpTools is undefined (capability present but no MCP tools)', () => {
    const callbacks = {
      getCapabilities: vi.fn(() => ({ supportedMcpTools: undefined })),
    };
    const result = buildMcpServers('test-chat', callbacks, false, logger);

    // supportedMcpTools === undefined → shouldIncludeContextMcp = true (defaults to include)
    expect(result).toHaveProperty('channel-mcp');
  });

  it('should merge external MCP servers from config', () => {
    (Config as any).getMcpServersConfig.mockReturnValueOnce({
      'my-server': { command: 'node', args: ['./server.js'], env: { FOO: 'bar' } },
    });

    const callbacks = {
      getCapabilities: vi.fn(() => ({ supportedMcpTools: [] })),
    };
    const result = buildMcpServers('test-chat', callbacks, false, logger);

    expect(result).not.toHaveProperty('channel-mcp');
    expect(result).toHaveProperty('my-server');
    expect(result['my-server']).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['./server.js'],
      env: { FOO: 'bar' },
    });
  });

  it('should merge external MCP servers with defaults when env is missing', () => {
    (Config as any).getMcpServersConfig.mockReturnValueOnce({
      'minimal-server': { command: 'python', args: ['-m', 'server'] },
    });

    const callbacks = {
      getCapabilities: vi.fn(() => ({ supportedMcpTools: [] })),
    };
    const result = buildMcpServers('test-chat', callbacks, false, logger);

    expect(result).toHaveProperty('minimal-server');
    expect(result['minimal-server']).toEqual({
      type: 'stdio',
      command: 'python',
      args: ['-m', 'server'],
    });
  });

  it('should include both channel-mcp and external servers when applicable', () => {
    (Config as any).getMcpServersConfig.mockReturnValueOnce({
      'ext-server': { command: 'node', args: ['ext.js'] },
    });

    const callbacks = {
      getCapabilities: vi.fn(() => ({ supportedMcpTools: ['send_text'] })),
    };
    const result = buildMcpServers('test-chat', callbacks, false, logger);

    expect(result).toHaveProperty('channel-mcp');
    expect(result).toHaveProperty('ext-server');
    expect(Object.keys(result)).toEqual(['channel-mcp', 'ext-server']);
  });
});

describe('collectInlineMcpInstances (Issue #4302)', () => {
  // Production inline servers come from the SDK's createSdkMcpServer, which
  // returns a `{ type: 'sdk', name, instance }` wrapper (see
  // ClaudeSDKProvider.createMcpServer -> createSdkMcpServer). Fixtures mirror
  // that shape; collectInlineMcpInstances duck-types on `.instance.close` and
  // ignores `type`, but the contract is pinned to the real shape here.
  it('extracts the .instance from inline MCP server wrappers ({ type: "sdk", instance })', () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const instance = { close };
    const mcpServers = {
      'channel-mcp': { type: 'sdk', name: 'channel-mcp', instance },
    };
    const instances = collectInlineMcpInstances(mcpServers);
    expect(instances).toHaveLength(1);
    expect(instances[0]).toBe(instance);
  });

  it('skips stdio external-server configs (no .instance — SDK-spawned subprocess)', () => {
    const mcpServers = {
      'channel-mcp': { type: 'sdk', name: 'channel-mcp', instance: { close: vi.fn() } },
      'ext-server': { type: 'stdio', command: 'node', args: ['ext.js'] },
    };
    const instances = collectInlineMcpInstances(mcpServers);
    expect(instances).toHaveLength(1);
  });

  it('returns empty for an inline wrapper whose .instance has no close()', () => {
    const mcpServers = { broken: { type: 'sdk', instance: {} } };
    expect(collectInlineMcpInstances(mcpServers)).toEqual([]);
  });

  it('returns empty when there are no inline instances', () => {
    expect(collectInlineMcpInstances({})).toEqual([]);
    expect(collectInlineMcpInstances({ ext: { type: 'stdio', command: 'x' } })).toEqual([]);
  });
});
