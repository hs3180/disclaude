/**
 * Tests for resolveAcpCommand resolution strategies.
 *
 * Covers:
 * - Config override strategy (highest priority)
 * - claude-agent-acp binary detection
 * - claude --agent-acp fallback
 * - Error when no command is found
 *
 * Uses top-level vi.mock to mock child_process and loader consistently.
 *
 * @see Issue #1617 Phase 2
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track which commands are available for each test
let availableCommands: Set<string> = new Set();
let claudeHelpOutput = '';

vi.mock('child_process', () => ({
  execFileSync: vi.fn((cmd: string, args: string[]) => {
    // which command - check if command is available
    if (cmd === 'which') {
      if (availableCommands.has(args[0])) {return `/usr/bin/${args[0]}`;}
      throw new Error('not found');
    }
    // claude --help
    if (cmd === 'claude' && args[0] === '--help') {
      return claudeHelpOutput;
    }
    return '';
  }),
}));

vi.mock('./loader.js', () => ({
  loadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
  getConfigFromFile: vi.fn(() => ({
    env: {},
    logging: { level: 'info', pretty: true, rotate: false, sdkDebug: true },
    agent: { provider: 'glm', enableAgentTeams: false },
    glm: { apiKey: 'test-key', model: 'glm-4' },
    feishu: {},
    workspace: { dir: '/test/workspace' },
  })),
  validateConfig: vi.fn(() => true),
  getPreloadedConfig: vi.fn(() => null),
}));

import { resolveAcpCommand } from './index.js';

describe('resolveAcpCommand', () => {
  beforeEach(() => {
    availableCommands = new Set();
    claudeHelpOutput = '';
  });

  it('should return config override command when provided', () => {
    // Config override has highest priority, doesn't check PATH at all
    const result = resolveAcpCommand('/usr/local/bin/my-custom-agent');
    expect(result).toEqual({ command: '/usr/local/bin/my-custom-agent', args: [] });
  });

  it('should use config override even with empty string', () => {
    // Empty string is truthy for config override check
    // Actually, empty string is falsy, so it should fall through
    // Let's test that empty string is NOT treated as an override
    availableCommands.add('claude-agent-acp');
    const result = resolveAcpCommand('');
    expect(result).toEqual({ command: 'claude-agent-acp', args: [] });
  });

  it('should detect claude-agent-acp when available', () => {
    availableCommands.add('claude-agent-acp');

    const result = resolveAcpCommand();
    expect(result).toEqual({ command: 'claude-agent-acp', args: [] });
  });

  it('should prefer claude-agent-acp over claude --agent-acp', () => {
    availableCommands.add('claude-agent-acp');
    availableCommands.add('claude');
    claudeHelpOutput = '--agent-acp';

    const result = resolveAcpCommand();
    expect(result).toEqual({ command: 'claude-agent-acp', args: [] });
  });

  it('should fall back to claude --agent-acp when supported', () => {
    availableCommands.add('claude');
    claudeHelpOutput = 'Usage: claude [options]\n  --agent-acp    Start ACP agent mode\n';

    const result = resolveAcpCommand();
    expect(result).toEqual({ command: 'claude', args: ['--agent-acp'] });
  });

  it('should not use claude --agent-acp when flag not in help output', () => {
    availableCommands.add('claude');
    claudeHelpOutput = 'Usage: claude [options]\n  --help    Show help\n';

    expect(() => resolveAcpCommand()).toThrow('No ACP-compatible agent command found');
  });

  it('should throw error when no ACP command is available', () => {
    // No commands available
    expect(() => resolveAcpCommand()).toThrow('No ACP-compatible agent command found');
  });

  it('should throw error with actionable installation instructions', () => {
    expect(() => resolveAcpCommand()).toThrow(/claude-agent-acp/);
    expect(() => resolveAcpCommand()).toThrow(/agent\.acpCommand/);
    expect(() => resolveAcpCommand()).toThrow(/--agent-acp/);
  });
});
