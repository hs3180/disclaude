import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import { buildMcpServers, collectInlineMcpInstances } from './mcp-setup.js';

// Issue #4459 (part 10): mcp-setup no longer imports @disclaude/core (the
// external stdio MCP loader was removed). The mock pins that: if the module
// ever regains a Config dependency this mock will make the import fail loud.
vi.mock('@disclaude/core', () => {
  throw new Error(
    'mcp-setup must not import @disclaude/core after #4459 part 10 (external stdio MCP loader removed)',
  );
});

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

  it('should return empty object when skipChannelMcp=true', () => {
    const callbacks = { getCapabilities: vi.fn() };
    const result = buildMcpServers('test-chat', callbacks, true, logger);

    expect(result).toEqual({});
    // skipChannelMcp=true → capabilities lookup is skipped
    expect(callbacks.getCapabilities).not.toHaveBeenCalled();
  });

  it('should include channel-mcp when getCapabilities returns undefined', () => {
    const callbacks = { getCapabilities: vi.fn(() => undefined) };
    const result = buildMcpServers('test-chat', callbacks, false, logger);

    expect(result).toHaveProperty('channel-mcp');
    expect(result['channel-mcp']).toEqual({ type: 'inline' });
    expect(callbacks.getCapabilities).toHaveBeenCalledWith('test-chat');
    // Issue #4280 (part 5): no ipcSocket field in the log — PrimaryNode no
    // longer sets DISCLAUDE_WORKER_IPC_SOCKET (no IPC server); the MCP tools
    // reach it over REST.
    expect(logger.info).toHaveBeenCalledWith('Configured channel MCP server (inline transport)');
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

  // Issue #4459 (part 10): external stdio MCP servers were removed — config
  // tools.mcpServers is no longer read. Even a hypothetical stray entry must
  // never reappear in the built server set (config typing no longer allows it,
  // but the behavioral contract is pinned here too).
  it('should never include external stdio servers (loader removed, #4459 part 10)', () => {
    const callbacks = { getCapabilities: vi.fn(() => ({ supportedMcpTools: ['send_text'] })) };
    const result = buildMcpServers('test-chat', callbacks, false, logger);

    expect(Object.keys(result)).toEqual(['channel-mcp']);
    expect(JSON.stringify(result)).not.toContain('stdio');
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
