/**
 * Tests for Claude SDK options adapter.
 *
 * Verifies conversion of unified AgentQueryOptions to Claude SDK format.
 *
 * Issue #1617: Phase 2 - SDK providers test coverage.
 */

import { describe, it, expect, vi } from 'vitest';
import { adaptOptions, adaptInput } from './options-adapter.js';

// Mock the Claude Agent SDK for inline MCP server tests
const mockTool = vi.fn((_name: string, _desc: string, _params: unknown, handler: unknown) => ({
  type: 'sdk_tool',
  name: _name,
  handler,
}));
const mockCreateSdkMcpServer = vi.fn((config: { name: string; version: string; tools: unknown[] }) => ({
  type: 'sdk',
  name: config.name,
  instance: { name: config.name, tools: config.tools },
}));

// eslint-disable-next-line no-restricted-syntax -- Mocking SDK for unit test of adapter logic (no network calls)
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (name: string, desc: string, params: unknown, handler: unknown) => mockTool(name, desc, params, handler),
  createSdkMcpServer: (arg: { name: string; version: string; tools: unknown[] }) => mockCreateSdkMcpServer(arg),
}));

describe('adaptOptions', () => {
  it('should return empty options for minimal input', () => {
    const result = adaptOptions({
      settingSources: ['project'],
    });

    expect(result.settingSources).toEqual(['project']);
    expect(result.cwd).toBeUndefined();
    expect(result.model).toBeUndefined();
  });

  it('should pass through cwd and model', () => {
    const result = adaptOptions({
      settingSources: ['project'],
      cwd: '/workspace',
      model: 'claude-sonnet-4-20250514',
    });

    expect(result.cwd).toBe('/workspace');
    expect(result.model).toBe('claude-sonnet-4-20250514');
  });

  it('should pass through permission mode', () => {
    const result = adaptOptions({
      settingSources: ['project'],
      permissionMode: 'bypassPermissions',
    });

    expect(result.permissionMode).toBe('bypassPermissions');
  });

  it('should pass through allowedTools and disallowedTools', () => {
    const result = adaptOptions({
      settingSources: ['project'],
      allowedTools: ['tool1', 'tool2'],
      disallowedTools: ['tool3'],
    });

    expect(result.allowedTools).toEqual(['tool1', 'tool2']);
    expect(result.disallowedTools).toEqual(['tool3']);
  });

  it('should extract API key and base URL from env', () => {
    const result = adaptOptions({
      settingSources: ['project'],
      env: {
        ANTHROPIC_API_KEY: 'sk-123',
        ANTHROPIC_BASE_URL: 'https://api.example.com',
        OTHER_VAR: 'value',
      },
    });

    expect(result.apiKey).toBe('sk-123');
    expect(result.apiBaseUrl).toBe('https://api.example.com');
    expect(result.env).toEqual({
      ANTHROPIC_API_KEY: 'sk-123',
      ANTHROPIC_BASE_URL: 'https://api.example.com',
      OTHER_VAR: 'value',
    });
  });

  it('should pass through env without extracting when no API key', () => {
    const result = adaptOptions({
      settingSources: ['project'],
      env: {
        OTHER_VAR: 'value',
      },
    });

    expect(result.apiKey).toBeUndefined();
    expect(result.apiBaseUrl).toBeUndefined();
  });

  it('should adapt stdio MCP servers', () => {
    const result = adaptOptions({
      settingSources: ['project'],
      mcpServers: {
        'my-server': {
          type: 'stdio',
          name: 'my-server',
          command: 'npx',
          args: ['-y', 'my-mcp-server'],
          env: { PORT: '3000' },
        },
      },
    });

    expect(result.mcpServers).toBeDefined();
    const server = (result.mcpServers as Record<string, unknown>)['my-server'];
    expect(server).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'my-mcp-server'],
      env: { PORT: '3000' },
    });
  });

  it('should pass through stderr callback (Issue #2920)', () => {
    const stderrFn = (_data: string) => { /* test callback */ };
    const result = adaptOptions({
      settingSources: ['project'],
      stderr: stderrFn,
    });

    expect(result.stderr).toBe(stderrFn);
  });

  it('should not include stderr when not provided', () => {
    const result = adaptOptions({
      settingSources: ['project'],
    });

    expect(result.stderr).toBeUndefined();
  });

  it('should pass through systemPrompt preset (Issue #2890)', () => {
    const result = adaptOptions({
      settingSources: ['project'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
    });

    expect(result.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
    });
  });

  it('should pass through systemPrompt with append (Issue #2890)', () => {
    const result = adaptOptions({
      settingSources: ['project'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Extra instructions' },
    });

    expect(result.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'Extra instructions',
    });
  });

  it('should pass through string systemPrompt (Issue #2890)', () => {
    const result = adaptOptions({
      settingSources: ['project'],
      systemPrompt: 'You are a helpful assistant.',
    });

    expect(result.systemPrompt).toBe('You are a helpful assistant.');
  });

  it('should not include systemPrompt when not provided', () => {
    const result = adaptOptions({
      settingSources: ['project'],
    });

    expect(result.systemPrompt).toBeUndefined();
  });

  it('should pass through tools preset (Issue #2890)', () => {
    const result = adaptOptions({
      settingSources: ['project'],
      tools: { type: 'preset', preset: 'claude_code' },
    });

    expect(result.tools).toEqual({
      type: 'preset',
      preset: 'claude_code',
    });
  });

  it('should pass through tools as string array (Issue #2890)', () => {
    const result = adaptOptions({
      settingSources: ['project'],
      tools: ['Read', 'Write', 'Bash'],
    });

    expect(result.tools).toEqual(['Read', 'Write', 'Bash']);
  });

  it('should not include tools when not provided', () => {
    const result = adaptOptions({
      settingSources: ['project'],
    });

    expect(result.tools).toBeUndefined();
  });

  it('should pass through SDK inline MCP server wrapper objects', () => {
    // Simulate a pre-created SDK MCP server (already wrapped with createSdkMcpServer)
    const sdkServer = {
      type: 'sdk' as const,
      name: 'existing-server',
      instance: { name: 'existing-server' },
    };

    const result = adaptOptions({
      settingSources: ['project'],
      mcpServers: {
        'wrapped-server': sdkServer as any,
      },
    });

    expect(result.mcpServers).toBeDefined();
    expect((result.mcpServers as Record<string, unknown>)['wrapped-server']).toBe(sdkServer);
    // Should NOT call createSdkMcpServer for pre-wrapped objects
    expect(mockCreateSdkMcpServer).not.toHaveBeenCalled();
  });

  it('should adapt inline MCP server config with tools', () => {
    const handler = vi.fn();
    const result = adaptOptions({
      settingSources: ['project'],
      mcpServers: {
        'inline-server': {
          type: 'inline',
          name: 'inline-server',
          version: '1.0.0',
          tools: [{
            name: 'my-tool',
            description: 'A test tool',
            parameters: { type: 'object' as const, properties: {} },
            handler,
          }],
        },
      },
    });

    expect(result.mcpServers).toBeDefined();
    const _server = (result.mcpServers as Record<string, unknown>)['inline-server'];
    // Should have been converted via createSdkMcpServer
    expect(mockCreateSdkMcpServer).toHaveBeenCalledWith({
      name: 'inline-server',
      version: '1.0.0',
      tools: expect.arrayContaining([
        expect.objectContaining({ type: 'sdk_tool', name: 'my-tool' }),
      ]),
    });
    expect(mockTool).toHaveBeenCalledWith('my-tool', 'A test tool', { type: 'object', properties: {} }, handler);
  });

  it('should adapt inline MCP server config without tools', () => {
    mockCreateSdkMcpServer.mockClear();
    const result = adaptOptions({
      settingSources: ['project'],
      mcpServers: {
        'empty-server': {
          type: 'inline',
          name: 'empty-server',
          version: '1.0.0',
          tools: [],
        },
      },
    });

    expect(result.mcpServers).toBeDefined();
    // Should call createSdkMcpServer with empty tools array
    expect(mockCreateSdkMcpServer).toHaveBeenCalledWith({
      name: 'empty-server',
      version: '1.0.0',
      tools: [],
    });
  });
});

describe('adaptInput', () => {
  it('should pass through string input', () => {
    const result = adaptInput('Hello world');
    expect(result).toBe('Hello world');
  });

  it('should convert UserInput array to SDK format', () => {
    const result = adaptInput([
      { role: 'user', content: 'Hello' },
      { role: 'user', content: [{ type: 'text', text: 'Image caption' }, { type: 'image', data: 'abc123', mimeType: 'image/png' }] },
    ]);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);

    // First entry
    expect((result as unknown[])[0]).toEqual({
      type: 'user',
      message: { role: 'user', content: 'Hello' },
      parent_tool_use_id: null,
      session_id: '',
    });

    // Second entry
    expect((result as unknown[])[1]).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Image caption' }, { type: 'image', data: 'abc123', mimeType: 'image/png' }],
      },
      parent_tool_use_id: null,
      session_id: '',
    });
  });

  it('should handle empty UserInput array', () => {
    const result = adaptInput([]);
    expect(result).toEqual([]);
  });
});
