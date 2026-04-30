/**
 * Tests for ClaudeSDKProvider class methods.
 *
 * Covers the provider's lifecycle, configuration validation,
 * MCP server creation, and query stream behavior.
 *
 * Issue #1617: Phase 2 - SDK provider test coverage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudeSDKProvider } from './provider.js';
import type { IAgentSDKProvider } from '../../interface.js';
import type { AgentQueryOptions, InlineToolDefinition, McpServerConfig } from '../../types.js';

// ============================================================================
// Helpers
// ============================================================================

function createTestOptions(overrides: Partial<AgentQueryOptions> = {}): AgentQueryOptions {
  return {
    settingSources: ['test'],
    ...overrides,
  };
}

async function* singleInput(text: string) {
  yield { role: 'user' as const, content: text };
}

// ============================================================================
// Tests
// ============================================================================

describe('ClaudeSDKProvider', () => {
  let provider: IAgentSDKProvider;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    vi.clearAllMocks();
    provider = new ClaudeSDKProvider();
  });

  afterEach(() => {
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  // ==========================================================================
  // Properties
  // ==========================================================================

  describe('properties', () => {
    it('should have name "claude"', () => {
      expect(provider.name).toBe('claude');
    });

    it('should have a version string', () => {
      expect(provider.version).toBeDefined();
      expect(typeof provider.version).toBe('string');
    });
  });

  // ==========================================================================
  // validateConfig
  // ==========================================================================

  describe('validateConfig', () => {
    it('should return true when ANTHROPIC_API_KEY is set', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      expect(provider.validateConfig()).toBe(true);
    });

    it('should return false when ANTHROPIC_API_KEY is not set', () => {
      delete process.env.ANTHROPIC_API_KEY;
      expect(provider.validateConfig()).toBe(false);
    });

    it('should return false when ANTHROPIC_API_KEY is empty string', () => {
      process.env.ANTHROPIC_API_KEY = '';
      expect(provider.validateConfig()).toBe(false);
    });
  });

  // ==========================================================================
  // getInfo
  // ==========================================================================

  describe('getInfo', () => {
    it('should return available info when API key is set', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      const info = provider.getInfo();

      expect(info.name).toBe('claude');
      expect(info.version).toBeDefined();
      expect(info.available).toBe(true);
      expect(info.unavailableReason).toBeUndefined();
    });

    it('should return unavailable info when API key is not set', () => {
      delete process.env.ANTHROPIC_API_KEY;
      const info = provider.getInfo();

      expect(info.name).toBe('claude');
      expect(info.available).toBe(false);
      expect(info.unavailableReason).toBe('ANTHROPIC_API_KEY not set');
    });
  });

  // ==========================================================================
  // dispose
  // ==========================================================================

  describe('dispose', () => {
    it('should mark provider as disposed', () => {
      provider.dispose();

      // Verify by attempting to queryStream - should throw
      expect(() =>
        provider.queryStream(singleInput('test'), createTestOptions())
      ).toThrow('Provider has been disposed');
    });
  });

  // ==========================================================================
  // queryStream
  // ==========================================================================

  describe('queryStream', () => {
    it('should throw when provider is disposed', () => {
      provider.dispose();

      expect(() =>
        provider.queryStream(singleInput('test'), createTestOptions())
      ).toThrow('Provider has been disposed');
    });

    it('should return a StreamQueryResult with handle and iterator', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      const result = provider.queryStream(singleInput('hello'), createTestOptions());

      expect(result).toBeDefined();
      expect(result.handle).toBeDefined();
      expect(result.iterator).toBeDefined();
      expect(typeof result.handle.close).toBe('function');
      expect(typeof result.handle.cancel).toBe('function');
    });

    it('should have sessionId as undefined', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      const result = provider.queryStream(singleInput('hello'), createTestOptions());

      expect(result.handle.sessionId).toBeUndefined();
    });

    it('should not throw when handle.close is called', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      const result = provider.queryStream(singleInput('hello'), createTestOptions());

      expect(() => result.handle.close()).not.toThrow();
    });

    it('should not throw when handle.cancel is called', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      const result = provider.queryStream(singleInput('hello'), createTestOptions());

      expect(() => result.handle.cancel()).not.toThrow();
    });
  });

  // ==========================================================================
  // createMcpServer
  // ==========================================================================

  describe('createMcpServer', () => {
    it('should create an inline MCP server with no tools', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';

      const config: McpServerConfig = {
        type: 'inline',
        name: 'test-server',
        version: '1.0.0',
        tools: [],
      };

      const result = provider.createMcpServer(config);
      expect(result).toBeDefined();
    });

    it('should create inline MCP server with tools', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';

      const toolDef: InlineToolDefinition = {
        name: 'test-tool',
        description: 'A test tool',
        parameters: {} as InlineToolDefinition['parameters'],
        handler: async () => await Promise.resolve('result'),
      };

      const config: McpServerConfig = {
        type: 'inline',
        name: 'test-server',
        version: '1.0.0',
        tools: [toolDef],
      };

      const result = provider.createMcpServer(config);
      expect(result).toBeDefined();
    });

    it('should throw for stdio type MCP server', () => {
      const config: McpServerConfig = {
        type: 'stdio',
        name: 'test-server',
        command: 'node',
        args: ['server.js'],
      };

      expect(() => provider.createMcpServer(config)).toThrow(
        'stdio MCP servers are not supported by ClaudeSDKProvider.createMcpServer',
      );
    });

    it('should handle inline MCP server with undefined tools', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';

      const config: McpServerConfig = {
        type: 'inline',
        name: 'test-server',
        version: '1.0.0',
        tools: undefined,
      };

      // Should not throw — creates with empty tools
      const result = provider.createMcpServer(config);
      expect(result).toBeDefined();
    });
  });

  // ==========================================================================
  // createInlineTool
  // ==========================================================================

  describe('createInlineTool', () => {
    it('should create a tool using SDK tool function', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';

      const definition: InlineToolDefinition = {
        name: 'my-tool',
        description: 'Does something useful',
        parameters: {} as InlineToolDefinition['parameters'],
        handler: async (params) => await Promise.resolve(`processed: ${JSON.stringify(params)}`),
      };

      const result = provider.createInlineTool(definition);
      expect(result).toBeDefined();
    });
  });

  // ==========================================================================
  // Interface compliance
  // ==========================================================================

  describe('IAgentSDKProvider compliance', () => {
    it('should implement all required interface methods', () => {
      expect(typeof provider.getInfo).toBe('function');
      expect(typeof provider.queryStream).toBe('function');
      expect(typeof provider.createInlineTool).toBe('function');
      expect(typeof provider.createMcpServer).toBe('function');
      expect(typeof provider.validateConfig).toBe('function');
      expect(typeof provider.dispose).toBe('function');
    });

    it('should have readonly name property', () => {
      expect(provider.name).toBe('claude');
    });

    it('should have readonly version property', () => {
      expect(typeof provider.version).toBe('string');
      expect(provider.version.length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // Edge cases
  // ==========================================================================

  describe('edge cases', () => {
    it('should handle multiple dispose calls', () => {
      provider.dispose();
      provider.dispose(); // Should not throw

      expect(() =>
        provider.queryStream(singleInput('test'), createTestOptions())
      ).toThrow('Provider has been disposed');
    });

    it('should handle getInfo after dispose', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      provider.dispose();

      // getInfo should still work — it only checks config, not disposed state
      const info = provider.getInfo();
      expect(info.available).toBe(true);
    });

    it('should handle validateConfig after dispose', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      provider.dispose();

      // validateConfig should still work
      expect(provider.validateConfig()).toBe(true);
    });

    it('should handle createMcpServer after dispose', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      provider.dispose();

      // createMcpServer doesn't check disposed state, only queryStream does
      const config: McpServerConfig = {
        type: 'inline',
        name: 'test-server',
        version: '1.0.0',
      };

      // Should not throw
      expect(() => provider.createMcpServer(config)).not.toThrow();
    });

    it('should handle createInlineTool after dispose', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      provider.dispose();

      const definition: InlineToolDefinition = {
        name: 'post-dispose-tool',
        description: 'Created after dispose',
        parameters: {} as InlineToolDefinition['parameters'],
        handler: async () => await Promise.resolve('ok'),
      };

      expect(() => provider.createInlineTool(definition)).not.toThrow();
    });
  });
});
