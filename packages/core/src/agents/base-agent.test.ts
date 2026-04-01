/**
 * Unit tests for BaseAgent
 *
 * Issue #1617 Phase 2: Tests for BaseAgent core methods including
 * runtime context helpers, SDK options building, message formatting,
 * and error handling.
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

  testGetWorkspaceDir() {
    return this.getWorkspaceDir();
  }

  testGetLoggingConfig() {
    return this.getLoggingConfig();
  }

  testGetGlobalEnv() {
    return this.getGlobalEnv();
  }

  testIsAgentTeamsEnabled() {
    return this.isAgentTeamsEnabled();
  }

  testConvertToLegacyFormat(message: Parameters<BaseAgent['convertToLegacyFormat']>[0]) {
    return (this as unknown as { convertToLegacyFormat: BaseAgent['convertToLegacyFormat'] }).convertToLegacyFormat(message);
  }

  // Expose initialized for dispose testing
  get testInitialized() {
    return this.initialized;
  }

  set testInitialized(val: boolean) {
    this.initialized = val;
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

    it('should store apiBaseUrl when provided', () => {
      const agentWithUrl = new TestAgent({ ...config, apiBaseUrl: 'https://custom.api.com' });
      expect(agentWithUrl.apiBaseUrl).toBe('https://custom.api.com');
    });
  });

  describe('dispose', () => {
    it('should be idempotent', () => {
      // Not initialized, so dispose is a no-op
      agent.dispose();
      agent.dispose();
      // Should not throw
    });

    it('should mark agent as not initialized after dispose', () => {
      agent.testInitialized = true;
      agent.dispose();
      expect(agent.testInitialized).toBe(false);
    });

    it('should be safe to call dispose multiple times when initialized', () => {
      agent.testInitialized = true;
      agent.dispose();
      agent.dispose();
      agent.dispose();
      expect(agent.testInitialized).toBe(false);
    });
  });

  describe('getWorkspaceDir', () => {
    it('should return workspace dir from runtime context when available', () => {
      setRuntimeContext({
        getWorkspaceDir: () => '/custom/workspace',
        getAgentConfig: () => ({ apiKey: 'key', model: 'model', provider: 'anthropic' }),
        getLoggingConfig: () => ({ sdkDebug: false }),
        getGlobalEnv: () => ({}),
        isAgentTeamsEnabled: () => false,
      });

      expect(agent.testGetWorkspaceDir()).toBe('/custom/workspace');
    });
  });

  describe('getLoggingConfig', () => {
    it('should return logging config from runtime context', () => {
      setRuntimeContext({
        getWorkspaceDir: () => '/workspace',
        getAgentConfig: () => ({ apiKey: 'key', model: 'model', provider: 'anthropic' }),
        getLoggingConfig: () => ({ sdkDebug: true }),
        getGlobalEnv: () => ({}),
        isAgentTeamsEnabled: () => false,
      });

      const logConfig = agent.testGetLoggingConfig();
      expect(logConfig.sdkDebug).toBe(true);
    });

    it('should return sdkDebug false from runtime context', () => {
      setRuntimeContext({
        getWorkspaceDir: () => '/workspace',
        getAgentConfig: () => ({ apiKey: 'key', model: 'model', provider: 'anthropic' }),
        getLoggingConfig: () => ({ sdkDebug: false }),
        getGlobalEnv: () => ({}),
        isAgentTeamsEnabled: () => false,
      });

      const logConfig = agent.testGetLoggingConfig();
      expect(logConfig.sdkDebug).toBe(false);
    });
  });

  describe('getGlobalEnv', () => {
    it('should return global env from runtime context', () => {
      setRuntimeContext({
        getWorkspaceDir: () => '/workspace',
        getAgentConfig: () => ({ apiKey: 'key', model: 'model', provider: 'anthropic' }),
        getLoggingConfig: () => ({ sdkDebug: false }),
        getGlobalEnv: () => ({ MY_VAR: 'value', ANOTHER_VAR: '123' }),
        isAgentTeamsEnabled: () => false,
      });

      const env = agent.testGetGlobalEnv();
      expect(env.MY_VAR).toBe('value');
      expect(env.ANOTHER_VAR).toBe('123');
    });

    it('should return empty object when no runtime context', () => {
      const env = agent.testGetGlobalEnv();
      expect(env).toEqual({});
    });
  });

  describe('isAgentTeamsEnabled', () => {
    it('should return true when runtime context enables it', () => {
      setRuntimeContext({
        getWorkspaceDir: () => '/workspace',
        getAgentConfig: () => ({ apiKey: 'key', model: 'model', provider: 'anthropic' }),
        getLoggingConfig: () => ({ sdkDebug: false }),
        getGlobalEnv: () => ({}),
        isAgentTeamsEnabled: () => true,
      });

      expect(agent.testIsAgentTeamsEnabled()).toBe(true);
    });

    it('should return false when runtime context disables it', () => {
      setRuntimeContext({
        getWorkspaceDir: () => '/workspace',
        getAgentConfig: () => ({ apiKey: 'key', model: 'model', provider: 'anthropic' }),
        getLoggingConfig: () => ({ sdkDebug: false }),
        getGlobalEnv: () => ({}),
        isAgentTeamsEnabled: () => false,
      });

      expect(agent.testIsAgentTeamsEnabled()).toBe(false);
    });

    it('should return false when no runtime context', () => {
      expect(agent.testIsAgentTeamsEnabled()).toBe(false);
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

    it('should use custom cwd when provided', () => {
      const options = agent.testCreateSdkOptions({ cwd: '/custom/dir' });
      expect(options.cwd).toBe('/custom/dir');
    });

    it('should include settingSources in options', () => {
      const options = agent.testCreateSdkOptions();
      expect(options.settingSources).toEqual(['project']);
    });

    it('should merge global env into SDK env', () => {
      setRuntimeContext({
        getWorkspaceDir: () => '/workspace',
        getAgentConfig: () => ({ apiKey: 'key', model: 'model', provider: 'anthropic' }),
        getLoggingConfig: () => ({ sdkDebug: false }),
        getGlobalEnv: () => ({ CUSTOM_ENV: 'test_value' }),
        isAgentTeamsEnabled: () => false,
      });

      const options = agent.testCreateSdkOptions();
      expect(options.env?.CUSTOM_ENV).toBe('test_value');
    });

    it('should not include model when model is empty string', () => {
      const noModelAgent = new TestAgent({ apiKey: 'key', model: '', provider: 'anthropic' });
      const options = noModelAgent.testCreateSdkOptions();
      expect(options.model).toBeUndefined();
    });

    it('should pass apiBaseUrl to buildSdkEnv', () => {
      const agentWithUrl = new TestAgent({ ...config, apiBaseUrl: 'https://custom.api.com' });
      const options = agentWithUrl.testCreateSdkOptions();
      expect(options.env?.ANTHROPIC_BASE_URL).toBe('https://custom.api.com');
    });

    it('should enable SDK_DEBUG in env when logging config has sdkDebug true', () => {
      setRuntimeContext({
        getWorkspaceDir: () => '/workspace',
        getAgentConfig: () => ({ apiKey: 'key', model: 'model', provider: 'anthropic' }),
        getLoggingConfig: () => ({ sdkDebug: true }),
        getGlobalEnv: () => ({}),
        isAgentTeamsEnabled: () => false,
      });

      const options = agent.testCreateSdkOptions();
      expect(options.env?.SDK_DEBUG).toBe('true');
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

    it('should format tool_result type correctly', () => {
      const parsed = {
        type: 'tool_result',
        content: 'Result output here',
      };

      const message = agent.testFormatMessage(parsed);
      expect(message.messageType).toBe('tool_result');
      expect(message.content).toBe('Result output here');
    });

    it('should pass through metadata with sessionId to agent message', () => {
      const parsed = {
        type: 'text',
        content: 'Hello',
        metadata: {
          sessionId: 'session-abc-123',
          toolName: 'Read',
        },
      };

      const message = agent.testFormatMessage(parsed);
      expect(message.metadata).toBeDefined();
      expect(message.metadata?.sessionId).toBe('session-abc-123');
      expect(message.metadata?.toolName).toBe('Read');
    });

    it('should handle empty content', () => {
      const parsed = {
        type: 'text',
        content: '',
      };

      const message = agent.testFormatMessage(parsed);
      expect(message.content).toBe('');
      expect(message.messageType).toBe('text');
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

    it('should include error message from Error instance', () => {
      const message = agent.testHandleIteratorError(new Error('fail'), 'queryOnce');
      // The returned content only includes error.message, not agent name
      expect(message.content).toContain('fail');
      expect(message.content).toMatch(/^❌ Error:/);
    });

    it('should handle null error', () => {
      const message = agent.testHandleIteratorError(null, 'testOp');
      expect(message.content).toContain('null');
      expect(message.messageType).toBe('error');
    });

    it('should handle undefined error', () => {
      const message = agent.testHandleIteratorError(undefined, 'testOp');
      expect(message.content).toContain('undefined');
      expect(message.messageType).toBe('error');
    });

    it('should use String() for non-Error values in error content', () => {
      const objError = { code: 500, message: 'Internal' };
      const message = agent.testHandleIteratorError(objError, 'operation');
      // String({code: 500, message: 'Internal'}) => '[object Object]'
      expect(message.content).toContain('[object Object]');
    });
  });

  describe('convertToLegacyFormat', () => {
    it('should convert SDK message with full metadata', () => {
      const sdkMessage = {
        type: 'tool_use',
        content: 'Using Read tool',
        metadata: {
          toolName: 'Read',
          toolInput: { file: '/path/to/file.ts' },
          toolOutput: 'file contents here',
          elapsedMs: 150,
          costUsd: 0.005,
          inputTokens: 100,
          outputTokens: 50,
          sessionId: 'sess-123',
        },
      };

      const parsed = agent.testConvertToLegacyFormat(sdkMessage);
      expect(parsed.type).toBe('tool_use');
      expect(parsed.content).toBe('Using Read tool');
      expect(parsed.metadata).toBeDefined();
      expect(parsed.metadata?.toolName).toBe('Read');
      expect(parsed.metadata?.toolInput).toEqual({ file: '/path/to/file.ts' });
      expect(parsed.metadata?.toolOutput).toBe('file contents here');
      expect(parsed.metadata?.elapsed).toBe(150);
      expect(parsed.metadata?.cost).toBe(0.005);
      expect(parsed.metadata?.tokens).toBe(150); // 100 + 50
      expect(parsed.sessionId).toBe('sess-123');
    });

    it('should handle message without metadata', () => {
      const sdkMessage = {
        type: 'text',
        content: 'Simple text response',
      };

      const parsed = agent.testConvertToLegacyFormat(sdkMessage);
      expect(parsed.type).toBe('text');
      expect(parsed.content).toBe('Simple text response');
      expect(parsed.metadata).toBeUndefined();
      expect(parsed.sessionId).toBeUndefined();
    });

    it('should handle message with metadata but missing optional token fields', () => {
      const sdkMessage = {
        type: 'tool_result',
        content: 'Result',
        metadata: {
          toolName: 'Bash',
          toolInput: { command: 'ls' },
          toolOutput: 'file1.txt\nfile2.txt',
          elapsedMs: 200,
          costUsd: 0.001,
        },
      };

      const parsed = agent.testConvertToLegacyFormat(sdkMessage);
      expect(parsed.metadata?.tokens).toBe(0); // defaults to 0 for missing tokens
    });

    it('should handle message with sessionId but no metadata', () => {
      const sdkMessage = {
        type: 'text',
        content: 'Hello',
        metadata: {
          sessionId: 'session-xyz',
        },
      };

      const parsed = agent.testConvertToLegacyFormat(sdkMessage);
      expect(parsed.sessionId).toBe('session-xyz');
      expect(parsed.metadata).toBeDefined();
      expect(parsed.metadata?.toolName).toBeUndefined();
    });
  });
});
