/**
 * ACP Provider 单元测试
 *
 * 测试 ACPProvider 的接口实现和基本行为。
 * 不实际连接 ACP 服务端，通过验证接口契约来确保实现正确。
 *
 * @see Issue #1333 - 支持OpenAI Agent
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AcpProvider, type AcpProviderConfig } from './provider.js';
import type { IAgentSDKProvider } from '../../interface.js';
import type { AgentQueryOptions, UserInput, InlineToolDefinition } from '../../types.js';

describe('AcpProvider', () => {
  let provider: AcpProvider;

  beforeEach(() => {
    const config: AcpProviderConfig = {
      transport: {
        type: 'stdio',
        command: 'echo',
        connectionTimeout: 1000,
      },
      name: 'test-acp',
    };
    provider = new AcpProvider(config);
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('interface contract', () => {
    it('should implement IAgentSDKProvider', () => {
      const iface: IAgentSDKProvider = provider;
      expect(iface).toBeDefined();
    });

    it('should have required properties', () => {
      expect(provider.name).toBe('test-acp');
      expect(provider.version).toBeDefined();
      expect(typeof provider.version).toBe('string');
    });
  });

  describe('getInfo', () => {
    it('should return provider info', () => {
      const info = provider.getInfo();
      expect(info.name).toBe('test-acp');
      expect(info.version).toBe(provider.version);
      expect(typeof info.available).toBe('boolean');
    });

    it('should report as available (config-based validation)', () => {
      const info = provider.getInfo();
      expect(info.available).toBe(true);
    });
  });

  describe('validateConfig', () => {
    it('should return true for valid config', () => {
      expect(provider.validateConfig()).toBe(true);
    });
  });

  describe('createInlineTool', () => {
    it('should return tool definition object', () => {
      const definition: InlineToolDefinition = {
        name: 'test_tool',
        description: 'A test tool',
        parameters: {} as InlineToolDefinition['parameters'],
        handler: (() => 'result') as unknown as InlineToolDefinition['handler'],
      };
      const tool = provider.createInlineTool(definition);
      expect(typeof tool).toBe('object');
      expect(tool).not.toBeNull();
      if (tool && typeof tool === 'object') {
        expect((tool as Record<string, unknown>).name).toBe('test_tool');
        expect((tool as Record<string, unknown>).description).toBe('A test tool');
      }
    });
  });

  describe('createMcpServer', () => {
    it('should return stdio config for stdio MCP server', () => {
      const config = {
        type: 'stdio' as const,
        name: 'test-server',
        command: 'node',
        args: ['./server.js'],
        env: { PORT: '3000' },
      };
      const server = provider.createMcpServer(config);
      expect(typeof server).toBe('object');
      if (server && typeof server === 'object') {
        expect((server as Record<string, unknown>).type).toBe('stdio');
        expect((server as Record<string, unknown>).command).toBe('node');
      }
    });

    it('should return inline config for inline MCP server', () => {
      const config = {
        type: 'inline' as const,
        name: 'inline-server',
        version: '1.0.0',
      };
      const server = provider.createMcpServer(config);
      expect(typeof server).toBe('object');
    });
  });

  describe('dispose', () => {
    it('should not throw when disposing', () => {
      expect(() => provider.dispose()).not.toThrow();
    });

    it('should not throw when disposing twice', () => {
      provider.dispose();
      expect(() => provider.dispose()).not.toThrow();
    });

    it('should throw when using disposed provider', async () => {
      provider.dispose();
      const gen = provider.queryOnce('test', { settingSources: ['default'] });
      await expect(async () => {
        for await (const _msg of gen) {
          // Should not reach here
        }
      }).rejects.toThrow('disposed');
    });
  });

  describe('queryOnce', () => {
    it('should throw when connection fails (no ACP server)', async () => {
      // echo 命令会立即退出，导致连接失败
      const options: AgentQueryOptions = { settingSources: ['default'] };
      const gen = provider.queryOnce('Hello', options);

      await expect(async () => {
        for await (const _msg of gen) {
          // Should not reach here
        }
      }).rejects.toThrow();
    });
  });

  describe('queryStream', () => {
    it('should return StreamQueryResult with handle and iterator', () => {
      const options: AgentQueryOptions = { settingSources: ['default'] };
      async function* input(): AsyncGenerator<UserInput> {
        yield { role: 'user', content: 'Hello' };
      }

      const result = provider.queryStream(input(), options);
      expect(result.handle).toBeDefined();
      expect(result.iterator).toBeDefined();
      expect(typeof result.handle.close).toBe('function');
      expect(typeof result.handle.cancel).toBe('function');
    });

    it('should clean up when handle.close is called', () => {
      const options: AgentQueryOptions = { settingSources: ['default'] };
      async function* input(): AsyncGenerator<UserInput> {
        yield { role: 'user', content: 'Hello' };
      }

      const result = provider.queryStream(input(), options);
      expect(() => result.handle.close()).not.toThrow();
    });
  });

  describe('with custom name', () => {
    it('should use default name when not provided', () => {
      const defaultProvider = new AcpProvider({
        transport: { type: 'stdio', command: 'echo' },
      });
      expect(defaultProvider.name).toBe('acp');
      defaultProvider.dispose();
    });
  });
});
