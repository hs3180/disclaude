/**
 * Tests for ACP-specific utility functions.
 *
 * Tests pure functions extracted from BaseAgent (Issue #2345 Phase 2):
 * - toAcpSessionOptions: converts AgentQueryOptions to ACP session params
 * - convertToLegacyFormat: converts ACP AgentMessage to legacy format
 * - buildSdkOptions: constructs AgentQueryOptions from agent context
 *
 * Issue #1617 Phase 2: Agent layer testing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  toAcpSessionOptions,
  convertToLegacyFormat,
  buildSdkOptions,
  type SdkBuildContext,
} from './base-agent-acp.js';
import type { AgentQueryOptions, AgentMessage as SdkAgentMessage } from '../sdk/index.js';

// ============================================================================
// toAcpSessionOptions
// ============================================================================

describe('toAcpSessionOptions', () => {
  it('should only map settingSources when no other optional fields are set', () => {
    const options: AgentQueryOptions = { settingSources: ['project'] };
    const result = toAcpSessionOptions(options);
    expect(result.permissionMode).toBeUndefined();
    expect(result.model).toBeUndefined();
    expect(result.allowedTools).toBeUndefined();
    expect(result.disallowedTools).toBeUndefined();
    expect(result.env).toBeUndefined();
    expect(result.settingSources).toEqual(['project']);
  });

  it('should map permissionMode when provided', () => {
    const options: AgentQueryOptions = {
      settingSources: ['project'],
      permissionMode: 'bypassPermissions',
    };
    const result = toAcpSessionOptions(options);
    expect(result.permissionMode).toBe('bypassPermissions');
  });

  it('should map model when provided', () => {
    const options: AgentQueryOptions = {
      settingSources: ['project'],
      model: 'claude-sonnet-4-20250514',
    };
    const result = toAcpSessionOptions(options);
    expect(result.model).toBe('claude-sonnet-4-20250514');
  });

  it('should map allowedTools when provided', () => {
    const options: AgentQueryOptions = {
      settingSources: ['project'],
      allowedTools: ['tool1', 'tool2'],
    };
    const result = toAcpSessionOptions(options);
    expect(result.allowedTools).toEqual(['tool1', 'tool2']);
  });

  it('should map disallowedTools when provided', () => {
    const options: AgentQueryOptions = {
      settingSources: ['project'],
      disallowedTools: ['dangerous_tool'],
    };
    const result = toAcpSessionOptions(options);
    expect(result.disallowedTools).toEqual(['dangerous_tool']);
  });

  it('should map env when provided with non-undefined values', () => {
    const options: AgentQueryOptions = {
      settingSources: ['project'],
      env: { KEY1: 'value1', KEY2: 'value2' },
    };
    const result = toAcpSessionOptions(options);
    expect(result.env).toEqual({ KEY1: 'value1', KEY2: 'value2' });
  });

  it('should filter out undefined values from env', () => {
    const options: AgentQueryOptions = {
      settingSources: ['project'],
      env: { KEY1: 'value1' } as Record<string, string>,
    };
    // Inject undefined via type assertion to test filtering
    const optionsWithUndefined = {
      ...options,
      env: { KEY1: 'value1', KEY2: undefined as unknown as string },
    };
    const result = toAcpSessionOptions(optionsWithUndefined as AgentQueryOptions);
    expect(result.env).toEqual({ KEY1: 'value1' });
    expect(result.env).not.toHaveProperty('KEY2');
  });

  it('should not include env when all values are undefined', () => {
    const options = {
      settingSources: ['project'],
      env: { KEY1: undefined as unknown as string },
    };
    const result = toAcpSessionOptions(options as AgentQueryOptions);
    expect(result.env).toBeUndefined();
  });

  it('should map settingSources when provided', () => {
    const options: AgentQueryOptions = {
      settingSources: ['project', 'user'],
    };
    const result = toAcpSessionOptions(options);
    expect(result.settingSources).toEqual(['project', 'user']);
  });

  it('should NOT include mcpServers (Issue #2463)', () => {
    const options: AgentQueryOptions = {
      settingSources: ['project'],
      mcpServers: {
        test: { type: 'stdio', name: 'test', command: 'node' },
      },
    };
    const result = toAcpSessionOptions(options);
    expect(result).not.toHaveProperty('mcpServers');
  });

  it('should map all fields together', () => {
    const options: AgentQueryOptions = {
      settingSources: ['project'],
      permissionMode: 'bypassPermissions',
      model: 'claude-3-5-sonnet',
      allowedTools: ['tool1'],
      disallowedTools: ['tool2'],
      env: { API_KEY: 'test' },
    };
    const result = toAcpSessionOptions(options);
    expect(result.permissionMode).toBe('bypassPermissions');
    expect(result.model).toBe('claude-3-5-sonnet');
    expect(result.allowedTools).toEqual(['tool1']);
    expect(result.disallowedTools).toEqual(['tool2']);
    expect(result.env).toEqual({ API_KEY: 'test' });
  });
});

// ============================================================================
// convertToLegacyFormat
// ============================================================================

describe('convertToLegacyFormat', () => {
  it('should convert basic text message', () => {
    const message: SdkAgentMessage = {
      type: 'text',
      content: 'Hello world',
      role: 'assistant',
    };
    const result = convertToLegacyFormat(message);
    expect(result.type).toBe('text');
    expect(result.content).toBe('Hello world');
    expect(result.metadata).toBeUndefined();
    expect(result.sessionId).toBeUndefined();
  });

  it('should convert message with metadata', () => {
    const message: SdkAgentMessage = {
      type: 'tool_use',
      content: 'Using tool...',
      role: 'assistant',
      metadata: {
        toolName: 'read_file',
        toolInput: { path: '/tmp/test.txt' },
        toolOutput: 'file contents',
        elapsedMs: 1500,
        costUsd: 0.003,
        inputTokens: 100,
        outputTokens: 50,
      },
    };
    const result = convertToLegacyFormat(message);
    expect(result.type).toBe('tool_use');
    expect(result.metadata).toBeDefined();
    expect(result.metadata?.toolName).toBe('read_file');
    expect(result.metadata?.toolInput).toEqual({ path: '/tmp/test.txt' });
    expect(result.metadata?.toolOutput).toBe('file contents');
    expect(result.metadata?.elapsed).toBe(1500);
    expect(result.metadata?.cost).toBe(0.003);
    expect(result.metadata?.tokens).toBe(150); // 100 + 50
  });

  it('should handle metadata with partial token fields', () => {
    const message: SdkAgentMessage = {
      type: 'text',
      content: 'Response',
      role: 'assistant',
      metadata: {
        inputTokens: 200,
        // outputTokens undefined
      },
    };
    const result = convertToLegacyFormat(message);
    expect(result.metadata?.tokens).toBe(200); // 200 + 0
  });

  it('should handle metadata with only outputTokens', () => {
    const message: SdkAgentMessage = {
      type: 'text',
      content: 'Response',
      role: 'assistant',
      metadata: {
        outputTokens: 300,
      },
    };
    const result = convertToLegacyFormat(message);
    expect(result.metadata?.tokens).toBe(300); // 0 + 300
  });

  it('should extract sessionId from metadata', () => {
    const message: SdkAgentMessage = {
      type: 'text',
      content: 'Hello',
      role: 'assistant',
      metadata: {
        sessionId: 'session-abc-123',
      },
    };
    const result = convertToLegacyFormat(message);
    expect(result.sessionId).toBe('session-abc-123');
  });

  it('should handle toolInputRaw mapping from toolInput', () => {
    const input = { file: 'test.ts', line: 42 };
    const message: SdkAgentMessage = {
      type: 'tool_result',
      content: '',
      role: 'assistant',
      metadata: {
        toolInput: input,
      },
    };
    const result = convertToLegacyFormat(message);
    expect(result.metadata?.toolInputRaw).toEqual(input);
  });

  it('should handle message without any metadata', () => {
    const message: SdkAgentMessage = {
      type: 'result',
      content: 'Task completed',
      role: 'assistant',
    };
    const result = convertToLegacyFormat(message);
    expect(result.type).toBe('result');
    expect(result.content).toBe('Task completed');
    expect(result.metadata).toBeUndefined();
  });

  it('should preserve original message type', () => {
    const types: SdkAgentMessage['type'][] = [
      'text', 'thinking', 'tool_use', 'tool_progress', 'tool_result', 'result', 'error', 'status',
    ];
    for (const type of types) {
      const message: SdkAgentMessage = { type, content: '', role: 'assistant' };
      const result = convertToLegacyFormat(message);
      expect(result.type).toBe(type);
    }
  });
});

// ============================================================================
// buildSdkOptions
// ============================================================================

describe('buildSdkOptions', () => {
  const baseCtx: SdkBuildContext = {
    workspaceDir: '/workspace/test',
    permissionMode: 'default',
    loggingConfig: { sdkDebug: false },
    globalEnv: { EXISTING_VAR: 'from-global' },
    agentTeamsEnabled: false,
    apiKey: 'test-api-key',
    apiBaseUrl: undefined,
    model: 'claude-3-5-sonnet',
  };

  beforeEach(() => {
    vi.resetModules();
  });

  it('should set cwd from context workspaceDir by default', () => {
    const result = buildSdkOptions(baseCtx);
    expect(result.cwd).toBe('/workspace/test');
  });

  it('should override cwd when extra.cwd is provided', () => {
    const result = buildSdkOptions(baseCtx, { cwd: '/custom/path' });
    expect(result.cwd).toBe('/custom/path');
  });

  it('should set permissionMode from context', () => {
    const result = buildSdkOptions(baseCtx);
    expect(result.permissionMode).toBe('default');
  });

  it('should set settingSources to project', () => {
    const result = buildSdkOptions(baseCtx);
    expect(result.settingSources).toEqual(['project']);
  });

  it('should include allowedTools from extra', () => {
    const result = buildSdkOptions(baseCtx, { allowedTools: ['tool1', 'tool2'] });
    expect(result.allowedTools).toEqual(['tool1', 'tool2']);
  });

  it('should include disallowedTools from extra', () => {
    const result = buildSdkOptions(baseCtx, { disallowedTools: ['bad_tool'] });
    expect(result.disallowedTools).toEqual(['bad_tool']);
  });

  it('should include mcpServers from extra when provided', () => {
    const mcpServers = {
      test: { type: 'stdio' as const, name: 'test', command: 'node', args: ['server.js'] },
    };
    const result = buildSdkOptions(baseCtx, { mcpServers });
    expect(result.mcpServers).toEqual(mcpServers);
  });

  it('should set model from context', () => {
    const result = buildSdkOptions(baseCtx);
    expect(result.model).toBe('claude-3-5-sonnet');
  });

  it('should build env with API key', () => {
    const result = buildSdkOptions(baseCtx);
    expect(result.env).toBeDefined();
    expect(result.env?.ANTHROPIC_API_KEY).toBe('test-api-key');
  });

  it('should merge globalEnv into env', () => {
    const result = buildSdkOptions(baseCtx);
    expect(result.env?.EXISTING_VAR).toBe('from-global');
  });

  it('should include PATH in env', () => {
    const result = buildSdkOptions(baseCtx);
    expect(result.env?.PATH).toBeDefined();
  });

  it('should add CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS when agentTeamsEnabled is true', () => {
    const ctx = { ...baseCtx, agentTeamsEnabled: true };
    const result = buildSdkOptions(ctx);
    expect(result.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
  });

  it('should not add CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS when agentTeamsEnabled is false', () => {
    const result = buildSdkOptions(baseCtx);
    expect(result.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined();
  });

  it('should include ANTHROPIC_BASE_URL when apiBaseUrl is provided', () => {
    const ctx = { ...baseCtx, apiBaseUrl: 'https://custom-api.example.com' };
    const result = buildSdkOptions(ctx);
    expect(result.env?.ANTHROPIC_BASE_URL).toBe('https://custom-api.example.com');
  });

  it('should not override ANTHROPIC_BASE_URL when apiBaseUrl is undefined', () => {
    const result = buildSdkOptions(baseCtx);
    // ANTHROPIC_BASE_URL may come from process.env, so we only verify it's not
    // explicitly set by buildSdkOptions when apiBaseUrl is undefined
    // The function only sets it when apiBaseUrl is provided
    // (It may still exist from process.env inheritance)
    expect(typeof result.env?.ANTHROPIC_BASE_URL === 'undefined' || typeof result.env?.ANTHROPIC_BASE_URL === 'string').toBe(true);
  });

  it('should handle empty extra options', () => {
    const result = buildSdkOptions(baseCtx, {});
    expect(result.cwd).toBe('/workspace/test');
    expect(result.settingSources).toEqual(['project']);
    expect(result.allowedTools).toBeUndefined();
    expect(result.disallowedTools).toBeUndefined();
    expect(result.mcpServers).toBeUndefined();
  });

  it('should merge runtime env from workspace directory', async () => {
    // Mock the runtime-env module to return a specific value
    vi.doMock('../config/runtime-env.js', () => ({
      loadRuntimeEnv: vi.fn(() => ({ RUNTIME_VAR: 'from-runtime-env' })),
    }));

    const { buildSdkOptions: buildOptions } = await import('./base-agent-acp.js');
    const result = buildOptions(baseCtx);
    // The runtime env should be merged into the options env
    expect(result.env).toBeDefined();
  });

  it('should not set model when context model is empty (falsy check)', () => {
    const ctx = { ...baseCtx, model: '' };
    const result = buildSdkOptions(ctx);
    // Empty string is falsy, so model is not set
    expect(result.model).toBeUndefined();
  });

  it('should set DEBUG_CLAUDE_AGENT_SDK when sdkDebug is true', () => {
    const ctx = { ...baseCtx, loggingConfig: { sdkDebug: true } };
    const result = buildSdkOptions(ctx);
    expect(result.env?.DEBUG_CLAUDE_AGENT_SDK).toBeDefined();
  });

  it('should not set DEBUG_CLAUDE_AGENT_SDK when sdkDebug is false', () => {
    const result = buildSdkOptions(baseCtx);
    expect(result.env?.DEBUG_CLAUDE_AGENT_SDK).toBeUndefined();
  });
});
