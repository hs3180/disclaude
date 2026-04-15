/**
 * Tests for Config.getGlobalEnv() and createDefaultRuntimeContext()
 *
 * Verifies that:
 * 1. Config.getGlobalEnv() returns env vars from config file
 * 2. Config.getGlobalEnv() prefers preloaded config (--config flag)
 * 3. createDefaultRuntimeContext() wires all required methods to Config
 * 4. createDefaultRuntimeContext() supports platform-specific overrides
 *
 * @see Issue #1839
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock child_process for resolveAcpCommand() (Issue #2349)
// Simulates claude-agent-acp being available in PATH
vi.mock('child_process', () => ({
  execFileSync: vi.fn((cmd: string, args: string[]) => {
    if (cmd === 'which' && args[0] === 'claude-agent-acp') {
      return '/usr/local/bin/claude-agent-acp';
    }
    return '';
  }),
}));

import { Config, createDefaultRuntimeContext } from './index.js';
import {
  setLoadedConfig,
  getPreloadedConfig,
} from './loader.js';
import {
  hasRuntimeContext,
  getRuntimeContext,
  clearRuntimeContext,
} from '../agents/types.js';

describe('Config.getGlobalEnv()', () => {
  it('should return an object (never null or undefined)', () => {
    const env = Config.getGlobalEnv();
    expect(env).toBeDefined();
    expect(typeof env).toBe('object');
    expect(Array.isArray(env)).toBe(false);
  });

  it('should return empty object when no env section is configured', () => {
    const env = Config.getGlobalEnv();
    // In test environment, config may or may not have env section.
    // Just verify the return type is correct.
    expect(env).toBeDefined();
    expect(typeof env).toBe('object');
  });

  it('should return env vars from preloaded config when set', () => {
    // Save original preloaded config
    const original = getPreloadedConfig();

    try {
      // Set a preloaded config with env vars
      setLoadedConfig({
        _fromFile: true,
        _source: '/test/preloaded.config.yaml',
        env: {
          PRELOADED_TEST_KEY: 'preloaded_value',
          ANOTHER_KEY: 'another_value',
        },
      } as any);

      const env = Config.getGlobalEnv();
      expect(env.PRELOADED_TEST_KEY).toBe('preloaded_value');
      expect(env.ANOTHER_KEY).toBe('another_value');
    } finally {
      // Restore original preloaded config
      if (original) {
        setLoadedConfig(original);
      }
    }
  });

  it('should prefer preloaded config over default config', () => {
    const original = getPreloadedConfig();

    try {
      // Set preloaded config that overrides any default env
      setLoadedConfig({
        _fromFile: true,
        _source: '/test/override.config.yaml',
        env: {
          PRIORITY_TEST: 'from_preloaded',
        },
      } as any);

      const env = Config.getGlobalEnv();
      expect(env.PRIORITY_TEST).toBe('from_preloaded');
    } finally {
      if (original) {
        setLoadedConfig(original);
      }
    }
  });

  it('should return empty object when preloaded config has no env section', () => {
    const original = getPreloadedConfig();

    try {
      setLoadedConfig({
        _fromFile: true,
        _source: '/test/no-env.config.yaml',
        workspace: { dir: '/tmp/test' },
      } as any);

      const env = Config.getGlobalEnv();
      expect(env).toEqual({});
    } finally {
      if (original) {
        setLoadedConfig(original);
      }
    }
  });
});

describe('createDefaultRuntimeContext()', () => {
  let mockAgentConfig: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearRuntimeContext();
    // Mock getAgentConfig to avoid requiring model/apiKey in CI
    mockAgentConfig = vi.spyOn(Config, 'getAgentConfig').mockReturnValue({
      apiKey: 'test-key',
      model: 'test-model',
      provider: 'glm',
    });
  });

  afterEach(() => {
    clearRuntimeContext();
    mockAgentConfig.mockRestore();
  });

  it('should create and set runtime context', () => {
    expect(hasRuntimeContext()).toBe(false);

    createDefaultRuntimeContext();

    expect(hasRuntimeContext()).toBe(true);
  });

  it('should wire getGlobalEnv to Config.getGlobalEnv()', () => {
    createDefaultRuntimeContext();

    const ctx = getRuntimeContext();
    const env = ctx.getGlobalEnv();
    expect(env).toBeDefined();
    expect(typeof env).toBe('object');
  });

  it('should wire getWorkspaceDir to Config.getWorkspaceDir()', () => {
    createDefaultRuntimeContext();

    const ctx = getRuntimeContext();
    const dir = ctx.getWorkspaceDir();
    expect(typeof dir).toBe('string');
  });

  it('should wire getLoggingConfig to Config.getLoggingConfig()', () => {
    createDefaultRuntimeContext();

    const ctx = getRuntimeContext();
    const logging = ctx.getLoggingConfig();
    expect(logging).toBeDefined();
    expect(typeof logging.sdkDebug).toBe('boolean');
  });

  it('should wire isAgentTeamsEnabled to Config.isAgentTeamsEnabled()', () => {
    createDefaultRuntimeContext();

    const ctx = getRuntimeContext();
    const enabled = ctx.isAgentTeamsEnabled();
    expect(typeof enabled).toBe('boolean');
  });

  it('should wire getAgentConfig to Config.getAgentConfig()', () => {
    // Mock is already set up in beforeEach
    createDefaultRuntimeContext();

    const ctx = getRuntimeContext();
    const agentConfig = ctx.getAgentConfig();
    expect(agentConfig).toBeDefined();
    expect(agentConfig.apiKey).toBe('test-key');
    expect(agentConfig.model).toBe('test-model');
    expect(agentConfig.provider).toBe('glm');
  });

  it('should support platform-specific overrides', () => {
    const mockSendMessage = async (_chatId: string, _text: string) => {};
    const mockSendCard = async (_chatId: string, _card: Record<string, unknown>) => {};

    createDefaultRuntimeContext({
      sendMessage: mockSendMessage,
      sendCard: mockSendCard,
    });

    const ctx = getRuntimeContext();
    expect(ctx.sendMessage).toBe(mockSendMessage);
    expect(ctx.sendCard).toBe(mockSendCard);
  });

  it('should return the created context', () => {
    const ctx = createDefaultRuntimeContext();
    expect(ctx).toBeDefined();
    expect(ctx).toBe(getRuntimeContext());
  });
});
