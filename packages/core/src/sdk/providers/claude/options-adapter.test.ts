/**
 * Unit tests for Claude SDK Options Adapter
 *
 * Tests conversion between unified AgentQueryOptions and Claude SDK options.
 */

import { describe, it, expect, vi } from 'vitest';
import { adaptOptions, adaptInput } from './options-adapter.js';

// Mock the Claude SDK imports
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: vi.fn().mockReturnValue({ type: 'sdk', name: 'test', instance: {} }),
  tool: vi.fn((name, desc, params, handler) => ({ name, description: desc, parameters: params, handler })),
}));

describe('adaptOptions', () => {
  it('should return empty options when no fields are set', () => {
    const result = adaptOptions({} as any);
    expect(result).toEqual({ settingSources: undefined });
  });

  it('should map cwd option', () => {
    const result = adaptOptions({ cwd: '/project', settingSources: ['project'] });
    expect(result.cwd).toBe('/project');
  });

  it('should map model option', () => {
    const result = adaptOptions({ model: 'claude-3-opus', settingSources: ['project'] });
    expect(result.model).toBe('claude-3-opus');
  });

  it('should map permissionMode option', () => {
    const result = adaptOptions({ permissionMode: 'bypassPermissions', settingSources: ['project'] });
    expect(result.permissionMode).toBe('bypassPermissions');
  });

  it('should map settingSources', () => {
    const result = adaptOptions({ settingSources: ['project', 'user'] });
    expect(result.settingSources).toEqual(['project', 'user']);
  });

  it('should map allowedTools', () => {
    const tools = ['Bash', 'Read', 'Write'];
    const result = adaptOptions({ allowedTools: tools, settingSources: ['project'] });
    expect(result.allowedTools).toEqual(tools);
  });

  it('should map disallowedTools', () => {
    const tools = ['DangerousTool'];
    const result = adaptOptions({ disallowedTools: tools, settingSources: ['project'] });
    expect(result.disallowedTools).toEqual(tools);
  });

  it('should map env variables', () => {
    const env = { NODE_ENV: 'test', DEBUG: 'true' };
    const result = adaptOptions({ env, settingSources: ['project'] });
    expect(result.env).toEqual(env);
  });

  it('should extract API key from env and pass as apiKey', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-123' };
    const result = adaptOptions({ env, settingSources: ['project'] });
    expect(result.apiKey).toBe('sk-123');
  });

  it('should extract base URL from env and pass as apiBaseUrl', () => {
    const env = { ANTHROPIC_BASE_URL: 'https://custom.api.com' };
    const result = adaptOptions({ env, settingSources: ['project'] });
    expect(result.apiBaseUrl).toBe('https://custom.api.com');
  });

  it('should extract both API key and base URL from env', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-123', ANTHROPIC_BASE_URL: 'https://custom.api.com' };
    const result = adaptOptions({ env, settingSources: ['project'] });
    expect(result.apiKey).toBe('sk-123');
    expect(result.apiBaseUrl).toBe('https://custom.api.com');
  });

  it('should adapt MCP servers with stdio type', () => {
    const mcpServers: Record<string, any> = {
      'my-server': {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: { PORT: '3000' },
      },
    };

    const result = adaptOptions({ mcpServers, settingSources: ['project'] });
    expect(result.mcpServers).toBeDefined();
    const server = (result.mcpServers as any)['my-server'];
    expect(server.type).toBe('stdio');
    expect(server.command).toBe('node');
    expect(server.args).toEqual(['server.js']);
    expect(server.env).toEqual({ PORT: '3000' });
  });

  it('should adapt MCP servers with inline type', () => {
    const mcpServers: Record<string, any> = {
      'inline-server': {
        type: 'inline',
        name: 'test-server',
        version: '1.0.0',
        tools: [
          {
            name: 'myTool',
            description: 'A test tool',
            parameters: {},
            handler: () => {},
          },
        ],
      },
    };

    const result = adaptOptions({ mcpServers, settingSources: ['project'] });
    expect(result.mcpServers).toBeDefined();
    const server = (result.mcpServers as any)['inline-server'];
    // Should call createSdkMcpServer for inline servers
    expect(server).toBeDefined();
  });

  it('should pass through SDK inline MCP servers directly', () => {
    const sdkServer = { type: 'sdk', name: 'existing', instance: {} };
    const mcpServers: Record<string, any> = {
      'sdk-server': sdkServer,
    };

    const result = adaptOptions({ mcpServers, settingSources: ['project'] });
    expect((result.mcpServers as any)['sdk-server']).toBe(sdkServer);
  });

  it('should not set apiKey when env does not contain it', () => {
    const env = { OTHER_VAR: 'value' };
    const result = adaptOptions({ env, settingSources: ['project'] });
    expect(result.apiKey).toBeUndefined();
  });

  it('should not set apiBaseUrl when env does not contain it', () => {
    const env = { OTHER_VAR: 'value' };
    const result = adaptOptions({ env, settingSources: ['project'] });
    expect(result.apiBaseUrl).toBeUndefined();
  });

  it('should handle inline MCP server with no tools', () => {
    const mcpServers = {
      'empty-server': {
        type: 'inline' as const,
        name: 'empty',
        version: '1.0.0',
        tools: [],
      },
    };

    const result = adaptOptions({ mcpServers, settingSources: ['project'] });
    expect(result.mcpServers).toBeDefined();
  });

  it('should handle MCP servers with multiple entries', () => {
    const mcpServers: Record<string, any> = {
      'stdio-server': {
        type: 'stdio',
        command: 'node',
        args: [],
      },
      'inline-server': {
        type: 'inline',
        name: 'inline',
        version: '1.0.0',
        tools: [],
      },
    };

    const result = adaptOptions({ mcpServers, settingSources: ['project'] });
    expect(Object.keys(result.mcpServers as any)).toEqual(['stdio-server', 'inline-server']);
  });
});

describe('adaptInput', () => {
  it('should pass through string input directly', () => {
    const result = adaptInput('Hello, Claude!');
    expect(result).toBe('Hello, Claude!');
  });

  it('should convert UserInput array to SDK format', () => {
    const inputs = [
      { role: 'user' as const, content: 'First message' },
      { role: 'user' as const, content: 'Second message' },
    ];

    const result = adaptInput(inputs);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);

    const first = (result as any)[0];
    expect(first.type).toBe('user');
    expect(first.message.role).toBe('user');
    expect(first.message.content).toBe('First message');
    expect(first.parent_tool_use_id).toBeNull();
    expect(first.session_id).toBe('');
  });

  it('should handle empty UserInput array', () => {
    const result = adaptInput([]);
    expect(result).toEqual([]);
  });

  it('should handle UserInput with complex content', () => {
    const inputs: any[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
        ],
      },
    ];

    const result = adaptInput(inputs);
    const first = (result as any)[0];
    expect(first.message.content).toEqual(inputs[0].content);
  });
});
