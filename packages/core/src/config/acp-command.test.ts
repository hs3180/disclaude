/**
 * Tests for resolveAcpCommand() in packages/core/src/config/index.ts
 *
 * Covers:
 * - Config override via agent.acpCommand (highest priority)
 * - Detection of claude-agent-acp command (preferred)
 * - Fallback to claude --agent-acp when dedicated binary not found
 * - Error when neither command is available
 *
 * Uses vi.mock for child_process to avoid actual command execution.
 *
 * @see Issue #2349
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// We need to mock child_process before importing the module under test
const mockExecFileSync = vi.fn();

// Mock loader.js as required by config module
vi.mock('./loader.js', () => ({
  loadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
  getConfigFromFile: vi.fn(() => ({
    env: {},
    logging: { level: 'info', pretty: false, rotate: false, sdkDebug: false },
    agent: { provider: 'glm' as const },
    glm: { apiKey: 'test-key', model: 'glm-4' },
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

describe('resolveAcpCommand', () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  it('prefers claude-agent-acp when available', () => {
    // First call: commandExists('claude-agent-acp') → succeeds
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'claude-agent-acp') {
        return '/usr/local/bin/claude-agent-acp';
      }
      return '';
    });

    const result = resolveAcpCommand();
    expect(result).toEqual({ command: 'claude-agent-acp', args: [] });
  });

  it('falls back to claude --agent-acp when claude-agent-acp not found but claude supports it', () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'claude-agent-acp') {
        throw new Error('not found');
      }
      if (cmd === 'which' && args[0] === 'claude') {
        return '/usr/local/bin/claude';
      }
      if (cmd === 'claude' && args[0] === '--help') {
        return 'Usage: claude [options]\n  --agent-acp    Start ACP mode\n';
      }
      return '';
    });

    const result = resolveAcpCommand();
    expect(result).toEqual({ command: 'claude', args: ['--agent-acp'] });
  });

  it('throws error when neither command is available', () => {
    mockExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === 'which') {
        throw new Error('not found');
      }
      return '';
    });

    expect(() => resolveAcpCommand()).toThrow('No ACP-compatible agent command found');
  });

  it('throws error when claude exists but does not support --agent-acp', () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'claude-agent-acp') {
        throw new Error('not found');
      }
      if (cmd === 'which' && args[0] === 'claude') {
        return '/usr/local/bin/claude';
      }
      if (cmd === 'claude' && args[0] === '--help') {
        return 'Usage: claude [options]\n  --print    Print output\n';
      }
      return '';
    });

    expect(() => resolveAcpCommand()).toThrow('No ACP-compatible agent command found');
  });

  it('throws error when claude --help fails', () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'claude-agent-acp') {
        throw new Error('not found');
      }
      if (cmd === 'which' && args[0] === 'claude') {
        return '/usr/local/bin/claude';
      }
      if (cmd === 'claude') {
        throw new Error('claude command failed');
      }
      return '';
    });

    expect(() => resolveAcpCommand()).toThrow('No ACP-compatible agent command found');
  });

  it('uses config override when provided, skipping auto-detection', () => {
    // Even though claude-agent-acp would be found, config override takes priority
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'claude-agent-acp') {
        return '/usr/local/bin/claude-agent-acp';
      }
      return '';
    });

    const result = resolveAcpCommand('/custom/path/to/acp-agent');
    expect(result).toEqual({ command: '/custom/path/to/acp-agent', args: [] });
    // Should not have called 'which' since config override skips detection
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('uses config override even when no other command is available', () => {
    // All which calls fail, but config override skips detection entirely
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });

    const result = resolveAcpCommand('my-custom-acp-binary');
    expect(result).toEqual({ command: 'my-custom-acp-binary', args: [] });
  });

  it('falls back to auto-detection when config override is undefined', () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'claude-agent-acp') {
        return '/usr/local/bin/claude-agent-acp';
      }
      return '';
    });

    const result = resolveAcpCommand(undefined);
    expect(result).toEqual({ command: 'claude-agent-acp', args: [] });
  });

  // ==========================================================================
  // OpenAI provider-specific tests (Issue #1333)
  // ==========================================================================

  describe('OpenAI provider resolution', () => {
    it('resolves codex --agent-acp when provider is openai and codex supports it', () => {
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'which' && args[0] === 'codex') {
          return '/usr/local/bin/codex';
        }
        if (cmd === 'codex' && args[0] === '--help') {
          return 'Usage: codex [options]\n  --agent-acp    Start ACP mode\n';
        }
        return '';
      });

      const result = resolveAcpCommand(undefined, 'openai');
      expect(result).toEqual({ command: 'codex', args: ['--agent-acp'] });
    });

    it('resolves openai-agent-acp when codex not found but dedicated binary exists', () => {
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'which' && args[0] === 'codex') {
          throw new Error('not found');
        }
        if (cmd === 'which' && args[0] === 'openai-agent-acp') {
          return '/usr/local/bin/openai-agent-acp';
        }
        return '';
      });

      const result = resolveAcpCommand(undefined, 'openai');
      expect(result).toEqual({ command: 'openai-agent-acp', args: [] });
    });

    it('falls through to claude-agent-acp when no OpenAI binary available', () => {
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'which' && args[0] === 'codex') {
          throw new Error('not found');
        }
        if (cmd === 'which' && args[0] === 'openai-agent-acp') {
          throw new Error('not found');
        }
        if (cmd === 'which' && args[0] === 'claude-agent-acp') {
          return '/usr/local/bin/claude-agent-acp';
        }
        return '';
      });

      const result = resolveAcpCommand(undefined, 'openai');
      expect(result).toEqual({ command: 'claude-agent-acp', args: [] });
    });

    it('config override takes priority over OpenAI provider detection', () => {
      mockExecFileSync.mockImplementation(() => '');

      const result = resolveAcpCommand('/custom/openai-acp-binary', 'openai');
      expect(result).toEqual({ command: '/custom/openai-acp-binary', args: [] });
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('throws error with OpenAI hint when provider is openai and no command found', () => {
      mockExecFileSync.mockImplementation((cmd: string) => {
        if (cmd === 'which') {
          throw new Error('not found');
        }
        return '';
      });

      expect(() => resolveAcpCommand(undefined, 'openai')).toThrow(/For OpenAI.*codex/);
    });
  });
});
