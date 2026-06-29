/**
 * Tests for MCP Server CLI (packages/mcp-server/src/cli.ts)
 *
 * Issue #4128: handleRequest() is now a thin router — tool schemas live in
 * tools/tool-definitions.ts and validation/dispatch live in tools/tool-dispatch.ts.
 *
 * This file covers ONLY argument parsing and the JSON-RPC routing layer.
 * The dispatch layer is mocked, so the router is unit-tested in isolation with
 * no IPC, network, or tool side effects. Validation/dispatch behavior is
 * exercised in tools/tool-dispatch.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before imports
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  loadConfigFile: vi.fn(),
  setLoadedConfig: vi.fn(),
  getIpcSocketPath: vi.fn(() => '/tmp/test-ipc.sock'),
}));

vi.mock('./index.js', () => ({
  setMessageSentCallback: vi.fn(),
}));

// Mock the dispatch layer so the router is tested in isolation (no side effects).
// Dispatch/validation is covered directly in tools/tool-dispatch.test.ts.
vi.mock('./tools/tool-dispatch.js', () => ({
  dispatchToolCall: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
}));

// Import after mocks are set up
import { parseArgs, handleRequest } from './cli.js';
import { dispatchToolCall } from './tools/tool-dispatch.js';

function makeRequest(method: string, params?: Record<string, unknown>, id = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

describe('parseArgs', () => {
  it('should default to help command', () => {
    const result = parseArgs([]);
    expect(result.command).toBe('help');
  });

  it('should parse start command', () => {
    const result = parseArgs(['start']);
    expect(result.command).toBe('start');
  });

  it('should parse --config flag with value', () => {
    const result = parseArgs(['start', '--config', '/path/to/config.yaml']);
    expect(result.command).toBe('start');
    expect(result.configPath).toBe('/path/to/config.yaml');
  });

  it('should parse -c flag with value', () => {
    const result = parseArgs(['start', '-c', '/etc/disclaude.yaml']);
    expect(result.configPath).toBe('/etc/disclaude.yaml');
  });

  it('should parse --help flag', () => {
    const result = parseArgs(['--help']);
    expect(result.command).toBe('help');
  });

  it('should parse -h flag', () => {
    const result = parseArgs(['-h']);
    expect(result.command).toBe('help');
  });

  it('should ignore --config without value', () => {
    const result = parseArgs(['start', '--config']);
    expect(result.command).toBe('start');
    expect(result.configPath).toBeUndefined();
  });

  it('should handle start with config combined', () => {
    const result = parseArgs(['--config', 'my.yaml', 'start']);
    expect(result.command).toBe('start');
    expect(result.configPath).toBe('my.yaml');
  });

  it('should override start with help when --help is later', () => {
    const result = parseArgs(['start', '--help']);
    expect(result.command).toBe('help');
  });
});

describe('handleRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initialize', () => {
    it('should return MCP handshake with capabilities', async () => {
      const response = await handleRequest(makeRequest('initialize'));
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(1);
      expect(response.result).toBeDefined();
      expect(response.result).toEqual({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'channel-mcp', version: '0.0.1' },
      });
    });
  });

  describe('tools/list', () => {
    it('should return all 5 tool definitions (incl. push_to_agent)', async () => {
      const response = await handleRequest(makeRequest('tools/list'));
      expect(response.result).toBeDefined();
      const { tools } = response.result as { tools: { name: string }[] };
      expect(tools).toHaveLength(5);
      const names = tools.map((t) => t.name);
      expect(names).toContain('send_text');
      expect(names).toContain('send_card');
      expect(names).toContain('send_interactive');
      expect(names).toContain('send_file');
      expect(names).toContain('push_to_agent');
    });
  });

  describe('tools/call routing', () => {
    it('should delegate name and arguments to dispatchToolCall and wrap its result', async () => {
      vi.mocked(dispatchToolCall).mockResolvedValue({
        content: [{ type: 'text', text: 'Message sent' }],
      });
      const response = await handleRequest(
        makeRequest('tools/call', { name: 'send_text', arguments: { text: 'hi', chatId: 'oc_x' } }),
      );
      expect(dispatchToolCall).toHaveBeenCalledWith('send_text', { text: 'hi', chatId: 'oc_x' });
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(1);
      expect(response.result).toEqual({ content: [{ type: 'text', text: 'Message sent' }] });
    });

    it('should default missing arguments to an empty object', async () => {
      vi.mocked(dispatchToolCall).mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
      await handleRequest(makeRequest('tools/call', { name: 'send_text' }));
      expect(dispatchToolCall).toHaveBeenCalledWith('send_text', {});
    });

    it('should preserve the request id in the response', async () => {
      vi.mocked(dispatchToolCall).mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
      const response = await handleRequest(makeRequest('tools/call', { name: 'send_text' }, 42));
      expect(response.id).toBe(42);
    });
  });

  describe('unknown method', () => {
    it('should return a JSON-RPC error for unknown method', async () => {
      const response = await handleRequest(makeRequest('unknown/method'));
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32603);
      expect(response.error!.message).toContain('Unknown method');
    });
  });

  describe('error handling', () => {
    it('should wrap a dispatch rejection as a JSON-RPC error (-32603)', async () => {
      // dispatchToolCall rejects for unknown tools or propagates handler errors;
      // the router is responsible for translating that into a JSON-RPC error.
      vi.mocked(dispatchToolCall).mockRejectedValue(new Error('IPC connection refused'));
      const response = await handleRequest(
        makeRequest('tools/call', { name: 'send_text', arguments: { text: 'hi', chatId: 'oc_x' } }),
      );
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32603);
      expect(response.error!.message).toContain('IPC connection refused');
    });

    it('should wrap "Unknown tool" rejections from the dispatch layer', async () => {
      vi.mocked(dispatchToolCall).mockRejectedValue(new Error('Unknown tool: nope'));
      const response = await handleRequest(makeRequest('tools/call', { name: 'nope' }));
      expect(response.error).toBeDefined();
      expect(response.error!.message).toContain('Unknown tool');
    });

    it('should fall back to "Unknown error" for non-Error throws', async () => {
      vi.mocked(dispatchToolCall).mockRejectedValue('string thrown');
      const response = await handleRequest(makeRequest('tools/call', { name: 'send_text' }));
      expect(response.error).toBeDefined();
      expect(response.error!.message).toBe('Unknown error');
    });
  });
});
