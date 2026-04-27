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

  it('should NOT add system tools for Anthropic endpoint', () => {
    const result = adaptOptions({
      settingSources: ['project'],
      cwd: '/workspace',
      env: {
        ANTHROPIC_API_KEY: 'sk-123',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      },
    });

    expect(result.tools).toBeUndefined();
    expect(result.mcpServers).toBeUndefined();
  });

  it('should add system tools MCP server for non-Anthropic endpoint', () => {
    const result = adaptOptions({
      settingSources: ['project'],
      cwd: '/workspace',
      env: {
        ANTHROPIC_API_KEY: 'sk-123',
        ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
      },
    });

    // Should disable built-in tools
    expect(result.tools).toEqual([]);

    // Should add system-tools-compat MCP server
    expect(result.mcpServers).toBeDefined();
    const mcpServers = result.mcpServers as Record<string, unknown>;
    expect(mcpServers['system-tools-compat']).toBeDefined();
  });

  it('should preserve existing MCP servers when adding system tools', () => {
    const result = adaptOptions({
      settingSources: ['project'],
      cwd: '/workspace',
      env: {
        ANTHROPIC_API_KEY: 'sk-123',
        ANTHROPIC_BASE_URL: 'https://my-custom-api.example.com',
      },
      mcpServers: {
        'my-server': {
          type: 'stdio',
          name: 'my-server',
          command: 'npx',
          args: ['-y', 'my-mcp-server'],
        },
      },
    });

    expect(result.tools).toEqual([]);
    const mcpServers = result.mcpServers as Record<string, unknown>;
    expect(mcpServers['my-server']).toBeDefined();
    expect(mcpServers['system-tools-compat']).toBeDefined();
  });

  it('should use process.cwd() when cwd option is not set', () => {
    const result = adaptOptions({
      settingSources: ['project'],
      env: {
        ANTHROPIC_API_KEY: 'sk-123',
        ANTHROPIC_BASE_URL: 'https://custom-api.example.com',
      },
    });

    expect(result.tools).toEqual([]);
    const mcpServers = result.mcpServers as Record<string, unknown>;
    expect(mcpServers['system-tools-compat']).toBeDefined();
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
