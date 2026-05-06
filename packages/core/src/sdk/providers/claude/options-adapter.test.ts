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

  it('should pass through includePartialMessages when true (Issue #2890)', () => {
    const result = adaptOptions({
      settingSources: ['project'],
      includePartialMessages: true,
    });

    expect(result.includePartialMessages).toBe(true);
  });

  it('should pass through includePartialMessages when false (Issue #2890)', () => {
    const result = adaptOptions({
      settingSources: ['project'],
      includePartialMessages: false,
    });

    expect(result.includePartialMessages).toBe(false);
  });

  it('should not include includePartialMessages when not provided (Issue #2890)', () => {
    const result = adaptOptions({
      settingSources: ['project'],
    });

    expect(result.includePartialMessages).toBeUndefined();
  });

  it('should pass through settingSources as user, project, local (Issue #2890)', () => {
    const result = adaptOptions({
      settingSources: ['user', 'project', 'local'],
    });

    expect(result.settingSources).toEqual(['user', 'project', 'local']);
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
