/**
 * ACP 选项适配器单元测试
 *
 * @see Issue #1333 - 支持OpenAI Agent
 */

import { describe, it, expect } from 'vitest';
import { adaptOptionsToAcp } from './options-adapter.js';
import type { AgentQueryOptions } from '../../types.js';

describe('ACP Options Adapter', () => {
  it('should return undefined for empty options', () => {
    const options: AgentQueryOptions = {
      settingSources: ['default'],
    };
    const result = adaptOptionsToAcp(options);
    expect(result).toBeUndefined();
  });

  it('should adapt cwd option', () => {
    const options: AgentQueryOptions = {
      cwd: '/workspace/project',
      settingSources: ['default'],
    };
    const result = adaptOptionsToAcp(options);
    expect(result?.cwd).toBe('/workspace/project');
  });

  it('should adapt model option', () => {
    const options: AgentQueryOptions = {
      model: 'gpt-4o',
      settingSources: ['default'],
    };
    const result = adaptOptionsToAcp(options);
    expect(result?.model).toBe('gpt-4o');
  });

  it('should adapt allowedTools', () => {
    const options: AgentQueryOptions = {
      allowedTools: ['Read', 'Write', 'Bash'],
      settingSources: ['default'],
    };
    const result = adaptOptionsToAcp(options);
    expect(result?.allowedTools).toEqual(['Read', 'Write', 'Bash']);
  });

  it('should adapt disallowedTools', () => {
    const options: AgentQueryOptions = {
      disallowedTools: ['AskUserQuestion'],
      settingSources: ['default'],
    };
    const result = adaptOptionsToAcp(options);
    expect(result?.disallowedTools).toEqual(['AskUserQuestion']);
  });

  it('should adapt stdio MCP servers', () => {
    const options: AgentQueryOptions = {
      mcpServers: {
        'my-server': {
          type: 'stdio',
          name: 'my-server',
          command: 'node',
          args: ['./server.js'],
          env: { PORT: '3000' },
        },
      },
      settingSources: ['default'],
    };
    const result = adaptOptionsToAcp(options);
    expect(result?.mcpServers).toBeDefined();
    expect(result!.mcpServers!['my-server'].type).toBe('stdio');
    expect(result!.mcpServers!['my-server'].command).toBe('node');
    expect(result!.mcpServers!['my-server'].args).toEqual(['./server.js']);
  });

  it('should adapt env variables', () => {
    const options: AgentQueryOptions = {
      env: {
        OPENAI_API_KEY: 'sk-test',
        NODE_ENV: 'production',
      },
      settingSources: ['default'],
    };
    const result = adaptOptionsToAcp(options);
    expect(result?.env?.OPENAI_API_KEY).toBe('sk-test');
    expect(result?.env?.NODE_ENV).toBe('production');
  });

  it('should combine multiple options correctly', () => {
    const options: AgentQueryOptions = {
      cwd: '/workspace',
      model: 'gpt-4o',
      allowedTools: ['Read'],
      disallowedTools: ['Write'],
      env: { API_KEY: 'test' },
      settingSources: ['default'],
    };
    const result = adaptOptionsToAcp(options);
    expect(result?.cwd).toBe('/workspace');
    expect(result?.model).toBe('gpt-4o');
    expect(result?.allowedTools).toEqual(['Read']);
    expect(result?.disallowedTools).toEqual(['Write']);
    expect(result?.env?.API_KEY).toBe('test');
  });
});
