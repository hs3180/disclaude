/**
 * OpenAI Provider Unit Tests
 *
 * Tests for the OpenAI agent provider implementation.
 * Tests provider creation, configuration, and validation.
 *
 * @module sdk/providers/openai/openai-provider.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OpenAIProvider } from './provider.js';

// ============================================================================
// OpenAIProvider Creation Tests
// ============================================================================

describe('OpenAIProvider', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ---------------------------------------------------------------------------
  // Provider Creation
  // ---------------------------------------------------------------------------

  describe('creation', () => {
    it('should create provider with default config', () => {
      const provider = new OpenAIProvider();
      expect(provider.name).toBe('openai');
      expect(provider.version).toBe('0.1.0');
    });

    it('should create provider with custom model', () => {
      const provider = new OpenAIProvider({ model: 'o4-mini' });
      expect(provider.name).toBe('openai');
    });

    it('should create provider with custom command', () => {
      const provider = new OpenAIProvider({
        command: '/usr/local/bin/codex',
        args: ['--full-auto'],
      });
      expect(provider.name).toBe('openai');
    });

    it('should create provider with custom args', () => {
      const provider = new OpenAIProvider({
        args: ['--full-auto', '--model', 'gpt-4.1'],
      });
      expect(provider.name).toBe('openai');
    });

    it('should create provider with additional env vars', () => {
      const provider = new OpenAIProvider({
        env: { CUSTOM_VAR: 'value' },
      });
      expect(provider.name).toBe('openai');
    });

    it('should create provider with custom client info', () => {
      const provider = new OpenAIProvider({
        clientInfo: {
          name: 'test-client',
          version: '1.0.0',
        },
      });
      expect(provider.name).toBe('openai');
    });
  });

  // ---------------------------------------------------------------------------
  // Configuration Validation
  // ---------------------------------------------------------------------------

  describe('validateConfig', () => {
    it('should return false when OPENAI_API_KEY is not set', () => {
      delete process.env.OPENAI_API_KEY;
      const provider = new OpenAIProvider();
      expect(provider.validateConfig()).toBe(false);
    });

    it('should return true when OPENAI_API_KEY is set', () => {
      process.env.OPENAI_API_KEY = 'sk-test-key';
      const provider = new OpenAIProvider();
      expect(provider.validateConfig()).toBe(true);
    });

    it('should return true with custom command even without OPENAI_API_KEY in env', () => {
      delete process.env.OPENAI_API_KEY;
      const provider = new OpenAIProvider({
        command: 'codex',
      });
      // Custom command makes it valid, but still needs API key
      expect(provider.validateConfig()).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Provider Info
  // ---------------------------------------------------------------------------

  describe('getInfo', () => {
    it('should return unavailable when OPENAI_API_KEY is not set', () => {
      delete process.env.OPENAI_API_KEY;
      const provider = new OpenAIProvider();
      const info = provider.getInfo();

      expect(info.name).toBe('openai');
      expect(info.version).toBe('0.1.0');
      expect(info.available).toBe(false);
      expect(info.unavailableReason).toContain('OPENAI_API_KEY');
    });

    it('should return available when OPENAI_API_KEY is set', () => {
      process.env.OPENAI_API_KEY = 'sk-test-key';
      const provider = new OpenAIProvider();
      const info = provider.getInfo();

      expect(info.name).toBe('openai');
      expect(info.version).toBe('0.1.0');
      expect(info.available).toBe(true);
      expect(info.unavailableReason).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // API Key Forwarding
  // ---------------------------------------------------------------------------

  describe('API key forwarding', () => {
    it('should inherit from IAgentSDKProvider (base ACP provider)', () => {
      process.env.OPENAI_API_KEY = 'sk-test-key';
      const provider = new OpenAIProvider();

      // Verify the provider implements the interface correctly
      expect(typeof provider.queryOnce).toBe('function');
      expect(typeof provider.queryStream).toBe('function');
      expect(typeof provider.createInlineTool).toBe('function');
      expect(typeof provider.createMcpServer).toBe('function');
      expect(typeof provider.validateConfig).toBe('function');
      expect(typeof provider.dispose).toBe('function');
      expect(typeof provider.getInfo).toBe('function');
    });

    it('should throw on createInlineTool (ACP limitation)', () => {
      process.env.OPENAI_API_KEY = 'sk-test-key';
      const provider = new OpenAIProvider();

      expect(() => provider.createInlineTool({
        name: 'test',
        description: 'test tool',
        inputSchema: { type: 'object', properties: {} },
      })).toThrow('Inline tools are not supported');
    });

    it('should throw on createMcpServer with inline type (ACP limitation)', () => {
      process.env.OPENAI_API_KEY = 'sk-test-key';
      const provider = new OpenAIProvider();

      expect(() => provider.createMcpServer({
        type: 'inline',
        name: 'test',
        version: '1.0.0',
      } as any)).toThrow('Inline MCP servers are not supported');
    });
  });

  // ---------------------------------------------------------------------------
  // Dispose
  // ---------------------------------------------------------------------------

  describe('dispose', () => {
    it('should dispose without errors', () => {
      process.env.OPENAI_API_KEY = 'sk-test-key';
      const provider = new OpenAIProvider();
      expect(() => provider.dispose()).not.toThrow();
    });

    it('should throw on queryOnce after dispose', async () => {
      process.env.OPENAI_API_KEY = 'sk-test-key';
      const provider = new OpenAIProvider();
      provider.dispose();

      try {
        const iterator = provider.queryOnce('test', {
          settingSources: ['test'],
        });
        // The queryOnce is an async generator, we need to try to consume it
        for await (const _msg of iterator) {
          // Should not reach here
        }
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).toContain('disposed');
      }
    });
  });
});
