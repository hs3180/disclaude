/**
 * GLM Provider 测试（智谱 AI）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GLMSDKProvider } from './provider.js';

describe('GLMSDKProvider', () => {
  let provider: GLMSDKProvider;

  beforeEach(() => {
    provider = new GLMSDKProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('getInfo', () => {
    it('should return provider info with correct name and version', () => {
      const info = provider.getInfo();
      expect(info.name).toBe('glm');
      expect(info.version).toBe('1.0.0');
    });

    it('should report unavailable when GLM_API_KEY is not set', () => {
      const originalKey = process.env.GLM_API_KEY;
      delete process.env.GLM_API_KEY;

      const info = provider.getInfo();
      expect(info.available).toBe(false);
      expect(info.unavailableReason).toBe('GLM_API_KEY not set');

      if (originalKey) {
        process.env.GLM_API_KEY = originalKey;
      }
    });

    it('should report available when GLM_API_KEY is set', () => {
      const originalKey = process.env.GLM_API_KEY;
      process.env.GLM_API_KEY = 'test-key';

      const info = provider.getInfo();
      expect(info.available).toBe(true);
      expect(info.unavailableReason).toBeUndefined();

      if (originalKey) {
        process.env.GLM_API_KEY = originalKey;
      } else {
        delete process.env.GLM_API_KEY;
      }
    });
  });

  describe('validateConfig', () => {
    it('should return false when API key is not set', () => {
      const originalKey = process.env.GLM_API_KEY;
      delete process.env.GLM_API_KEY;

      expect(provider.validateConfig()).toBe(false);

      if (originalKey) {
        process.env.GLM_API_KEY = originalKey;
      }
    });

    it('should return true when API key is set', () => {
      const originalKey = process.env.GLM_API_KEY;
      process.env.GLM_API_KEY = 'test-key';

      expect(provider.validateConfig()).toBe(true);

      if (originalKey) {
        process.env.GLM_API_KEY = originalKey;
      } else {
        delete process.env.GLM_API_KEY;
      }
    });
  });

  describe('dispose', () => {
    it('should mark provider as disposed', () => {
      provider.dispose();

      expect(async () => {
        for await (const _ of provider.queryOnce('test', {})) {
          // Should throw
        }
      }).rejects.toThrow('Provider has been disposed');
    });
  });

  describe('createInlineTool', () => {
    it('should create tool definition', () => {
      const tool = provider.createInlineTool({
        name: 'test_tool',
        description: 'A test tool',
        parameters: {} as never,
        handler: async () => 'result',
      });

      expect(tool).toEqual({
        type: 'function',
        function: {
          name: 'test_tool',
          description: 'A test tool',
          parameters: {},
        },
      });
    });
  });

  describe('createMcpServer', () => {
    it('should throw error for MCP server creation', () => {
      expect(() =>
        provider.createMcpServer({
          type: 'inline',
          name: 'test',
          version: '1.0',
        })
      ).toThrow('MCP servers are not supported by GLMSDKProvider');
    });
  });
});
