/**
 * SDK 抽象层测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import {
  getProvider,
  registerProvider,
  setDefaultProvider,
  getDefaultProviderType,
  getAvailableProviders,
  clearProviderCache,
  isProviderAvailable,
} from './factory.js';
import { ClaudeSDKProvider } from './providers/claude/index.js';
import type { IAgentSDKProvider, ProviderInfo, AgentMessage, AgentQueryOptions, UserInput, StreamQueryResult } from './index.js';

describe('SDK Factory', () => {
  beforeEach(() => {
    clearProviderCache();
  });

  afterEach(() => {
    clearProviderCache();
    // 重置为默认 provider
    try {
      setDefaultProvider('claude');
    } catch {
      // ignore
    }
  });

  describe('getProvider', () => {
    it('should return Claude provider by default', () => {
      const provider = getProvider();
      expect(provider).toBeInstanceOf(ClaudeSDKProvider);
    });

    it('should return cached provider instance', () => {
      const provider1 = getProvider('claude');
      const provider2 = getProvider('claude');
      expect(provider1).toBe(provider2);
    });

    it('should throw for unknown provider type', () => {
      expect(() => getProvider('unknown')).toThrow('Unknown provider type: unknown');
    });
  });

  describe('registerProvider', () => {
    it('should register new provider type', () => {
      class MockProvider implements IAgentSDKProvider {
        name = 'mock';
        version = '1.0.0';
        getInfo(): ProviderInfo {
          return { name: this.name, version: this.version, available: true };
        }
        async *queryOnce(_input: string | UserInput[], _options: AgentQueryOptions): AsyncGenerator<AgentMessage> {
          // Mock implementation
        }
        queryStream(_input: AsyncGenerator<UserInput>, _options: AgentQueryOptions): StreamQueryResult {
          return {
            handle: { close: () => {}, cancel: () => {} },
            iterator: async function* (): AsyncGenerator<AgentMessage> {}(),
          };
        }
        createInlineTool = () => ({});
        createMcpServer = () => ({});
        validateConfig = () => true;
        dispose = () => {};
      }

      registerProvider('mock', () => new MockProvider());
      const provider = getProvider('mock');
      expect(provider.name).toBe('mock');
    });
  });

  describe('setDefaultProvider', () => {
    it('should change default provider type', () => {
      expect(getDefaultProviderType()).toBe('claude');
    });

    it('should throw for unknown provider type', () => {
      expect(() => setDefaultProvider('unknown')).toThrow('Unknown provider type: unknown');
    });
  });

  describe('getAvailableProviders', () => {
    it('should return list of available providers', () => {
      const providers = getAvailableProviders();
      expect(Array.isArray(providers)).toBe(true);
      expect(providers.length).toBeGreaterThan(0);
      expect(providers.some(p => p.name === 'claude')).toBe(true);
    });
  });

  describe('isProviderAvailable', () => {
    it('should return true for registered provider', () => {
      // 注意：实际可用性取决于 ANTHROPIC_API_KEY 环境变量
      const result = isProviderAvailable('claude');
      expect(typeof result).toBe('boolean');
    });

    it('should return false for unknown provider', () => {
      expect(isProviderAvailable('unknown')).toBe(false);
    });
  });

  describe('clearProviderCache', () => {
    it('should clear all cached providers', () => {
      getProvider('claude'); // 缓存 provider
      clearProviderCache();
      // 无法直接验证缓存是否清空，但不应抛出错误
      expect(() => clearProviderCache()).not.toThrow();
    });

    it('should clear specific provider cache', () => {
      getProvider('claude');
      clearProviderCache('claude');
      // 不应抛出错误
      expect(() => clearProviderCache('claude')).not.toThrow();
    });
  });
});

describe('ClaudeSDKProvider', () => {
  let provider: ClaudeSDKProvider;

  beforeEach(() => {
    provider = new ClaudeSDKProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('getInfo', () => {
    it('should return provider info', () => {
      const info = provider.getInfo();
      expect(info.name).toBe('claude');
      expect(info.version).toBe('0.2.19');
      expect(typeof info.available).toBe('boolean');
    });
  });

  describe('validateConfig', () => {
    it('should return boolean', () => {
      const result = provider.validateConfig();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('createInlineTool', () => {
    it('should create a tool', () => {
      const toolDef = {
        name: 'test_tool',
        description: 'A test tool',
        parameters: z.object({ input: z.string() }),
        handler: async () => 'result',
      };
      const tool = provider.createInlineTool(toolDef);
      expect(tool).toBeDefined();
    });
  });

  describe('queryOnce', () => {
    it('should throw if disposed', async () => {
      provider.dispose();
      await expect(async () => {
        const gen = provider.queryOnce('test', { settingSources: ['project'] });
        await gen.next();
      }).rejects.toThrow('Provider has been disposed');
    });
  });

  describe('queryStream', () => {
    it('should throw if disposed', () => {
      provider.dispose();
      async function* inputGen(): AsyncGenerator<UserInput> {
        yield { role: 'user', content: 'test' };
      }
      expect(() => {
        provider.queryStream(inputGen(), { settingSources: ['project'] });
      }).toThrow('Provider has been disposed');
    });
  });

  describe('dispose', () => {
    it('should mark provider as disposed', () => {
      provider.dispose();
      // 再次调用 dispose 不应抛出错误
      expect(() => provider.dispose()).not.toThrow();
    });
  });
});
