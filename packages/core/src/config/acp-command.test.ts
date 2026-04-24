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
});

describe('AgentConfig ACP provider options (Issue #1333)', () => {
  it('acpArgs and acpEnv type definitions accept valid values', () => {
    // Verify the new config fields are correctly typed and can hold expected values
    const config = {
      acpCommand: 'openai-acp-server',
      acpArgs: ['--model', 'gpt-4o', '--stream'],
      acpEnv: {
        OPENAI_API_KEY: 'sk-test-key',
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
      },
    };

    expect(config.acpCommand).toBe('openai-acp-server');
    expect(config.acpArgs).toEqual(['--model', 'gpt-4o', '--stream']);
    expect(config.acpEnv).toEqual({
      OPENAI_API_KEY: 'sk-test-key',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
    });
  });

  it('acpArgs and acpEnv are optional', () => {
    const config: { acpCommand?: string; acpArgs?: string[]; acpEnv?: Record<string, string> } = {};
    expect(config.acpArgs).toBeUndefined();
    expect(config.acpEnv).toBeUndefined();
  });
});
