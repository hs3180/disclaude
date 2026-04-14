/**
 * Tests for resolveAcpCommand() in packages/core/src/config/index.ts
 *
 * Covers:
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
});
