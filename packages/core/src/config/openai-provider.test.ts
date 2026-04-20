/**
 * Tests for OpenAI provider support (Issue #1333).
 *
 * Covers:
 * - OpenAI ACP command resolution (openai.acpCommand > openai-agent-acp > codex --acp)
 * - Provider-specific command routing (openai, glm, anthropic)
 * - OpenAI config types
 *
 * Uses vi.mock for child_process to avoid actual command execution.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFileSync = vi.fn();

// Mock loader.js with OpenAI config (matching existing test pattern)
vi.mock('./loader.js', () => ({
  loadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
  getConfigFromFile: vi.fn(() => ({
    env: {},
    logging: { level: 'info', pretty: false, rotate: false, sdkDebug: false },
    agent: { provider: 'openai' as const },
    openai: { apiKey: 'sk-test-openai-key', model: 'gpt-4o' },
    feishu: { appId: 'test-app-id', appSecret: 'test-secret' },
    workspace: { dir: '/test/workspace' },
  })),
  validateConfig: vi.fn(() => true),
  getPreloadedConfig: vi.fn(() => null),
}));

vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

import { resolveAcpCommand } from './index.js';
import type { OpenAiConfig } from './types.js';

describe('OpenAI Provider ACP Command Resolution (Issue #1333)', () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  // ==========================================================================
  // OpenAI Provider
  // ==========================================================================

  describe('provider=openai', () => {
    it('prefers openai-agent-acp when available', () => {
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'which' && args[0] === 'openai-agent-acp') {
          return '/usr/local/bin/openai-agent-acp';
        }
        throw new Error('not found');
      });

      const result = resolveAcpCommand(undefined, 'openai');
      expect(result).toEqual({ command: 'openai-agent-acp', args: [] });
    });

    it('falls back to codex --acp when openai-agent-acp not found', () => {
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'which' && args[0] === 'openai-agent-acp') {
          throw new Error('not found');
        }
        if (cmd === 'which' && args[0] === 'codex') {
          return '/usr/local/bin/codex';
        }
        if (cmd === 'codex' && args[0] === '--help') {
          return 'Usage: codex [options]\n  --acp    Start ACP mode\n';
        }
        throw new Error('not found');
      });

      const result = resolveAcpCommand(undefined, 'openai');
      expect(result).toEqual({ command: 'codex', args: ['--acp'] });
    });

    it('throws OpenAI-specific error when no command found', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('not found');
      });

      expect(() => resolveAcpCommand(undefined, 'openai')).toThrow(
        'No OpenAI ACP-compatible agent command found',
      );
    });

    it('throws error when codex exists but does not support --acp', () => {
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'which' && args[0] === 'openai-agent-acp') {
          throw new Error('not found');
        }
        if (cmd === 'which' && args[0] === 'codex') {
          return '/usr/local/bin/codex';
        }
        if (cmd === 'codex' && args[0] === '--help') {
          return 'Usage: codex [options]\n  --print    Print output\n';
        }
        throw new Error('not found');
      });

      expect(() => resolveAcpCommand(undefined, 'openai')).toThrow(
        'No OpenAI ACP-compatible agent command found',
      );
    });

    it('throws error when codex --help fails', () => {
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'which' && args[0] === 'openai-agent-acp') {
          throw new Error('not found');
        }
        if (cmd === 'which' && args[0] === 'codex') {
          return '/usr/local/bin/codex';
        }
        if (cmd === 'codex') {
          throw new Error('codex command failed');
        }
        throw new Error('not found');
      });

      expect(() => resolveAcpCommand(undefined, 'openai')).toThrow(
        'No OpenAI ACP-compatible agent command found',
      );
    });
  });

  // ==========================================================================
  // GLM Provider (falls through to Anthropic resolution)
  // ==========================================================================

  describe('provider=glm', () => {
    it('resolves using Anthropic ACP command (claude-agent-acp)', () => {
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'which' && args[0] === 'claude-agent-acp') {
          return '/usr/local/bin/claude-agent-acp';
        }
        return '';
      });

      const result = resolveAcpCommand(undefined, 'glm');
      expect(result).toEqual({ command: 'claude-agent-acp', args: [] });
    });

    it('uses config override for GLM provider', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('not found');
      });

      const result = resolveAcpCommand('/custom/agent-acp', 'glm');
      expect(result).toEqual({ command: '/custom/agent-acp', args: [] });
    });
  });

  // ==========================================================================
  // Anthropic Provider (default behavior)
  // ==========================================================================

  describe('provider=anthropic', () => {
    it('resolves claude-agent-acp when available', () => {
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'which' && args[0] === 'claude-agent-acp') {
          return '/usr/local/bin/claude-agent-acp';
        }
        return '';
      });

      const result = resolveAcpCommand(undefined, 'anthropic');
      expect(result).toEqual({ command: 'claude-agent-acp', args: [] });
    });

    it('does NOT try OpenAI commands for Anthropic provider', () => {
      // Only openai-agent-acp exists, but provider is anthropic
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'which' && args[0] === 'openai-agent-acp') {
          return '/usr/local/bin/openai-agent-acp';
        }
        if (cmd === 'which') {
          throw new Error('not found');
        }
        return '';
      });

      // Should throw because no Anthropic ACP command found
      expect(() => resolveAcpCommand(undefined, 'anthropic')).toThrow(
        'No ACP-compatible agent command found',
      );
    });
  });

  // ==========================================================================
  // Config Override Priority
  // ==========================================================================

  describe('config override priority', () => {
    it('config override takes priority for Anthropic provider', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('not found');
      });

      const result = resolveAcpCommand('/custom/acp-agent', 'anthropic');
      expect(result).toEqual({ command: '/custom/acp-agent', args: [] });
      // Should not have called 'which' since config override skips detection
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('config override takes priority even for OpenAI provider', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('not found');
      });

      // For OpenAI, the agent.acpCommand config override still takes effect
      const result = resolveAcpCommand('/my-openai-agent', 'openai');
      expect(result).toEqual({ command: '/my-openai-agent', args: [] });
    });
  });
});

// ==========================================================================
// OpenAiConfig Type Tests
// ==========================================================================

describe('OpenAiConfig interface (Issue #1333)', () => {
  it('should accept valid OpenAI configuration', () => {
    const config: OpenAiConfig = {
      apiKey: 'sk-test-key',
      model: 'gpt-4o',
      apiBaseUrl: 'https://api.openai.com/v1',
      acpCommand: 'python -m openai_agents --acp',
    };

    expect(config.apiKey).toBe('sk-test-key');
    expect(config.model).toBe('gpt-4o');
    expect(config.apiBaseUrl).toBe('https://api.openai.com/v1');
    expect(config.acpCommand).toBe('python -m openai_agents --acp');
  });

  it('should accept minimal OpenAI configuration', () => {
    const config: OpenAiConfig = {
      apiKey: 'sk-test-key',
    };

    expect(config.apiKey).toBe('sk-test-key');
    expect(config.model).toBeUndefined();
    expect(config.apiBaseUrl).toBeUndefined();
    expect(config.acpCommand).toBeUndefined();
  });

  it('should accept empty configuration', () => {
    const config: OpenAiConfig = {};

    expect(config.apiKey).toBeUndefined();
    expect(config.model).toBeUndefined();
  });
});
