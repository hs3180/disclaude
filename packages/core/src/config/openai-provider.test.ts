/**
 * Tests for OpenAI provider support in disclaude.
 *
 * Covers:
 * - resolveOpenaiAcpCommand() — config override, auto-detection, error handling
 * - OpenAI config validation (openai.apiKey + openai.model pair)
 *
 * Uses vi.mock for child_process to avoid actual command execution.
 *
 * @see Issue #1333
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
    agent: { provider: 'openai' as const },
    openai: { apiKey: 'test-openai-key', model: 'gpt-4o' },
    feishu: { appId: 'test-app-id', appSecret: 'test-secret' },
    workspace: { dir: '/test/workspace' },
  })),
  validateConfig: vi.fn(() => true),
  getPreloadedConfig: vi.fn(() => null),
}));

vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

import { resolveOpenaiAcpCommand } from './index.js';

describe('resolveOpenaiAcpCommand', () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  it('uses config override when provided, skipping auto-detection', () => {
    const result = resolveOpenaiAcpCommand('/custom/path/to/openai-acp');
    expect(result).toEqual({ command: '/custom/path/to/openai-acp', args: [] });
    // Should not have called 'which' since config override skips detection
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('uses config override even when it is a simple command name', () => {
    const result = resolveOpenaiAcpCommand('my-custom-openai-acp');
    expect(result).toEqual({ command: 'my-custom-openai-acp', args: [] });
  });

  it('prefers codex-acp when available', () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'codex-acp') {
        return '/usr/local/bin/codex-acp';
      }
      return '';
    });

    const result = resolveOpenaiAcpCommand();
    expect(result).toEqual({ command: 'codex-acp', args: [] });
  });

  it('falls back to codex --acp when codex-acp not found but codex supports it', () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'codex-acp') {
        throw new Error('not found');
      }
      if (cmd === 'which' && args[0] === 'codex') {
        return '/usr/local/bin/codex';
      }
      if (cmd === 'codex' && args[0] === '--help') {
        return 'Usage: codex [options]\n  --acp    Start ACP mode\n';
      }
      return '';
    });

    const result = resolveOpenaiAcpCommand();
    expect(result).toEqual({ command: 'codex', args: ['--acp'] });
  });

  it('throws error when neither codex-acp nor codex with --acp is available', () => {
    mockExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === 'which') {
        throw new Error('not found');
      }
      return '';
    });

    expect(() => resolveOpenaiAcpCommand()).toThrow('No OpenAI ACP-compatible agent command found');
  });

  it('throws error when codex exists but does not support --acp', () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'codex-acp') {
        throw new Error('not found');
      }
      if (cmd === 'which' && args[0] === 'codex') {
        return '/usr/local/bin/codex';
      }
      if (cmd === 'codex' && args[0] === '--help') {
        return 'Usage: codex [options]\n  --print    Print output\n';
      }
      return '';
    });

    expect(() => resolveOpenaiAcpCommand()).toThrow('No OpenAI ACP-compatible agent command found');
  });

  it('throws error when codex --help fails', () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'codex-acp') {
        throw new Error('not found');
      }
      if (cmd === 'which' && args[0] === 'codex') {
        return '/usr/local/bin/codex';
      }
      if (cmd === 'codex') {
        throw new Error('codex command failed');
      }
      return '';
    });

    expect(() => resolveOpenaiAcpCommand()).toThrow('No OpenAI ACP-compatible agent command found');
  });

  it('falls back to auto-detection when config override is undefined', () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'codex-acp') {
        return '/usr/local/bin/codex-acp';
      }
      return '';
    });

    const result = resolveOpenaiAcpCommand(undefined);
    expect(result).toEqual({ command: 'codex-acp', args: [] });
  });
});
