/**
 * Unit tests for BaseAgent
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseAgent, type SdkOptionsExtra, type IteratorYieldResult } from './base-agent.js';
import { setRuntimeContext, clearRuntimeContext, type BaseAgentConfig } from './types.js';

// Create a concrete implementation of BaseAgent for testing
class TestAgent extends BaseAgent {
  readonly testProperty = 'test';

  constructor(config: BaseAgentConfig) {
    super(config);
  }

  protected getAgentName(): string {
    return 'TestAgent';
  }

  // Expose protected methods for testing
  testCreateSdkOptions(extra: SdkOptionsExtra = {}) {
    return this.createSdkOptions(extra);
  }

  testFormatMessage(parsed: IteratorYieldResult['parsed']) {
    return this.formatMessage(parsed);
  }

  testHandleIteratorError(error: unknown, operation: string) {
    return this.handleIteratorError(error, operation);
  }
}

// Minimal mock for SDK provider
const mockSdkProvider = {
  queryOnce: vi.fn(),
  queryStream: vi.fn(),
};

// Mock the SDK module
vi.mock('../sdk/index.js', () => ({
  getProvider: () => mockSdkProvider,
  IAgentSDKProvider: class {},
}));

// Mock buildSdkEnv to return a simple env object
vi.mock('../utils/sdk.js', () => ({
  buildSdkEnv: (apiKey: string, apiBaseUrl: string | undefined, globalEnv: Record<string, string>, sdkDebug: boolean) => ({
    ANTHROPIC_API_KEY: apiKey,
    ...(apiBaseUrl ? { ANTHROPIC_BASE_URL: apiBaseUrl } : {}),
    ...globalEnv,
    ...(sdkDebug ? { SDK_DEBUG: 'true' } : {}),
  }),
}));

// Mock loadRuntimeEnv to return empty env
vi.mock('../config/runtime-env.js', () => ({
  loadRuntimeEnv: () => ({}),
}));

describe('BaseAgent', () => {
  let agent: TestAgent;
  let config: BaseAgentConfig;

  beforeEach(() => {
    config = {
      apiKey: 'test-api-key',
      model: 'claude-3-5-sonnet-20241022',
      provider: 'anthropic',
    };
    agent = new TestAgent(config);
  });

  afterEach(() => {
    clearRuntimeContext();
  });

  describe('constructor', () => {
    it('should create a BaseAgent with correct config', () => {
      expect(agent).toBeDefined();
      expect(agent.apiKey).toBe('test-api-key');
      expect(agent.model).toBe('claude-3-5-sonnet-20241022');
      expect(agent.provider).toBe('anthropic');
    });

    it('should default permissionMode to bypassPermissions', () => {
      expect(agent.permissionMode).toBe('bypassPermissions');
    });

    it('should use explicit permissionMode from config', () => {
      const strictAgent = new TestAgent({ ...config, permissionMode: 'default' });
      expect(strictAgent.permissionMode).toBe('default');
    });

    it('should default provider to anthropic when no runtime context', () => {
      const noProviderConfig: BaseAgentConfig = {
        apiKey: 'key',
        model: 'model',
      };
      const noProviderAgent = new TestAgent(noProviderConfig);
      expect(noProviderAgent.provider).toBe('anthropic');
    });

    it('should use runtime context provider if set', () => {
      setRuntimeContext({
        getWorkspaceDir: () => '/workspace',
        getAgentConfig: () => ({ apiKey: 'key', model: 'model', provider: 'glm' }),
        getLoggingConfig: () => ({ sdkDebug: false }),
        getGlobalEnv: () => ({}),
        isAgentTeamsEnabled: () => false,
      });

      const ctxAgent = new TestAgent({ apiKey: 'key', model: 'model' });
      expect(ctxAgent.provider).toBe('glm');
    });
  });

  describe('dispose', () => {
    it('should be idempotent', () => {
      // Not initialized, so dispose is a no-op
      agent.dispose();
      agent.dispose();
      // Should not throw
    });
  });

  describe('createSdkOptions', () => {
    it('should create options with default settings', () => {
      const options = agent.testCreateSdkOptions();

      expect(options).toBeDefined();
      expect(options.permissionMode).toBe('bypassPermissions');
      expect(options.env).toBeDefined();
      expect(options.env?.ANTHROPIC_API_KEY).toBe('test-api-key');
    });

    it('should include model if specified', () => {
      const options = agent.testCreateSdkOptions();
      expect(options.model).toBe('claude-3-5-sonnet-20241022');
    });

    it('should add allowedTools when specified', () => {
      const options = agent.testCreateSdkOptions({
        allowedTools: ['Read', 'Write'],
      });
      expect(options.allowedTools).toEqual(['Read', 'Write']);
    });

    it('should add disallowedTools when specified', () => {
      const options = agent.testCreateSdkOptions({
        disallowedTools: ['Bash'],
      });
      expect(options.disallowedTools).toEqual(['Bash']);
    });

    it('should add mcpServers when specified', () => {
      const mcpServers = { 'test-server': { command: 'node', args: ['server.js'] } };
      const options = agent.testCreateSdkOptions({ mcpServers });
      expect(options.mcpServers).toEqual(mcpServers);
    });

    it('should include CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS when enabled', () => {
      setRuntimeContext({
        getWorkspaceDir: () => '/workspace',
        getAgentConfig: () => ({ apiKey: 'key', model: 'model', provider: 'anthropic' }),
        getLoggingConfig: () => ({ sdkDebug: false }),
        getGlobalEnv: () => ({}),
        isAgentTeamsEnabled: () => true,
      });

      const options = agent.testCreateSdkOptions();
      expect(options.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
    });

    it('should merge extra env vars into SDK environment (Issue #1641)', () => {
      const options = agent.testCreateSdkOptions({
        env: { DISCLAUDE_CHAT_ID: 'oc_abc123def456' },
      });

      expect(options.env).toBeDefined();
      expect(options.env?.DISCLAUDE_CHAT_ID).toBe('oc_abc123def456');
    });

    it('should allow extra env vars to coexist with runtime env', () => {
      setRuntimeContext({
        getWorkspaceDir: () => '/workspace',
        getAgentConfig: () => ({ apiKey: 'key', model: 'model', provider: 'anthropic' }),
        getLoggingConfig: () => ({ sdkDebug: false }),
        getGlobalEnv: () => ({ MY_GLOBAL_VAR: 'global_value' }),
        isAgentTeamsEnabled: () => false,
      });

      const options = agent.testCreateSdkOptions({
        env: { DISCLAUDE_CHAT_ID: 'oc_test123' },
      });

      expect(options.env?.MY_GLOBAL_VAR).toBe('global_value');
      expect(options.env?.DISCLAUDE_CHAT_ID).toBe('oc_test123');
    });
  });

  describe('formatMessage', () => {
    it('should format a simple message correctly', () => {
      const parsed = {
        type: 'text',
        content: 'Hello, world!',
      };

      const message = agent.testFormatMessage(parsed);
      expect(message.content).toBe('Hello, world!');
      expect(message.role).toBe('assistant');
      expect(message.messageType).toBe('text');
    });

    it('should include metadata when present', () => {
      const parsed = {
        type: 'tool_use',
        content: 'Using tool',
        metadata: {
          toolName: 'Read',
          toolInput: { file: '/test.ts' },
          toolOutput: 'file content',
          elapsed: 100,
          cost: 0.01,
          tokens: 50,
        },
      };

      const message = agent.testFormatMessage(parsed);
      expect(message.metadata).toBeDefined();
      expect(message.metadata?.toolName).toBe('Read');
    });
  });

  describe('handleIteratorError', () => {
    it('should handle Error instances', () => {
      const error = new Error('SDK connection failed');
      const message = agent.testHandleIteratorError(error, 'testOperation');

      expect(message.content).toContain('SDK connection failed');
      expect(message.role).toBe('assistant');
      expect(message.messageType).toBe('error');
    });

    it('should handle non-Error values', () => {
      const message = agent.testHandleIteratorError('string error', 'testOperation');

      expect(message.content).toContain('string error');
      expect(message.messageType).toBe('error');
    });

    it('should handle unknown error types', () => {
      const message = agent.testHandleIteratorError(42, 'testOperation');

      expect(message.content).toContain('42');
    });
  });
});
