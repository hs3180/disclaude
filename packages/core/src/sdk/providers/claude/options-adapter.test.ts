/**
 * Tests for Claude SDK options adapter.
 *
 * Verifies conversion of unified AgentQueryOptions to Claude SDK format.
 *
 * Issue #1617: Phase 2 - SDK providers test coverage.
 */

import { describe, it, expect } from 'vitest';
import { adaptOptions, adaptInput } from './options-adapter.js';

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

  it('should pass through SDK inline MCP server wrapper objects', () => {
    const sdkWrapper = {
      type: 'sdk',
      name: 'pre-created-server',
      instance: { some: 'instance' },
    };

    const result = adaptOptions({
      settingSources: ['project'],
      mcpServers: {
        'sdk-server': sdkWrapper as unknown as import('../../types.js').McpServerConfig,
      },
    });

    expect(result.mcpServers).toBeDefined();
    const server = (result.mcpServers as Record<string, unknown>)['sdk-server'];
    expect(server).toBe(sdkWrapper);
  });

  it('should adapt inline MCP servers with tools via SDK functions', () => {
    const result = adaptOptions({
      settingSources: ['project'],
      mcpServers: {
        'inline-server': {
          type: 'inline',
          name: 'inline-server',
          version: '1.0.0',
          tools: [
            {
              name: 'my-tool',
              description: 'A test tool',
              parameters: {} as never,
              handler: () => Promise.resolve('result'),
            },
          ],
        },
      },
    });

    expect(result.mcpServers).toBeDefined();
    const server = (result.mcpServers as Record<string, unknown>)['inline-server'];
    // Should be a result from createSdkMcpServer
    expect(server).toBeDefined();
    expect(typeof server).toBe('object');
  });

  it('should adapt inline MCP servers without tools via SDK functions', () => {
    const result = adaptOptions({
      settingSources: ['project'],
      mcpServers: {
        'empty-inline': {
          type: 'inline',
          name: 'empty-inline',
          version: '2.0.0',
        },
      },
    });

    expect(result.mcpServers).toBeDefined();
    const server = (result.mcpServers as Record<string, unknown>)['empty-inline'];
    expect(server).toBeDefined();
  });

  it('should adapt inline MCP servers with empty tools array', () => {
    const result = adaptOptions({
      settingSources: ['project'],
      mcpServers: {
        'no-tools': {
          type: 'inline',
          name: 'no-tools',
          version: '3.0.0',
          tools: [],
        },
      },
    });

    expect(result.mcpServers).toBeDefined();
    const server = (result.mcpServers as Record<string, unknown>)['no-tools'];
    expect(server).toBeDefined();
  });

  it('should handle mixed MCP server types', () => {
    const result = adaptOptions({
      settingSources: ['project'],
      mcpServers: {
        'stdio-srv': {
          type: 'stdio',
          name: 'stdio-srv',
          command: 'node',
        },
        'inline-srv': {
          type: 'inline',
          name: 'inline-srv',
          version: '1.0.0',
          tools: [],
        },
      },
    });

    expect(result.mcpServers).toBeDefined();
    const servers = result.mcpServers as Record<string, unknown>;
    expect(servers['stdio-srv']).toEqual({
      type: 'stdio',
      command: 'node',
      args: undefined,
      env: undefined,
    });
    expect(servers['inline-srv']).toBeDefined();
  });

  it('should adapt stdio MCP server without optional fields', () => {
    const result = adaptOptions({
      settingSources: ['project'],
      mcpServers: {
        'minimal-stdio': {
          type: 'stdio',
          name: 'minimal-stdio',
          command: 'node',
        },
      },
    });

    const server = (result.mcpServers as Record<string, unknown>)['minimal-stdio'];
    expect(server).toEqual({
      type: 'stdio',
      command: 'node',
      args: undefined,
      env: undefined,
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
