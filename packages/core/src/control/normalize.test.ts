/**
 * Tests for command data normalization (Issue #3529).
 *
 * Verifies that raw CLI-style data is correctly converted
 * to typed command data for each command type.
 */

import { describe, it, expect } from 'vitest';
import { normalizeCommandData, createControlCommand } from './normalize.js';

describe('normalizeCommandData', () => {
  describe('project command', () => {
    it('should normalize CLI args to subcommand + workingDir', () => {
      const result = normalizeCommandData('project', { args: ['use', 'my-project'] });
      expect(result).toEqual({ subcommand: 'use', workingDir: 'my-project' });
    });

    it('should normalize multi-segment path', () => {
      const result = normalizeCommandData('project', { args: ['use', 'projects', 'my-app'] });
      expect(result).toEqual({ subcommand: 'use', workingDir: 'projects my-app' });
    });

    it('should use subcommand from args[0] when no explicit subcommand', () => {
      const result = normalizeCommandData('project', { args: ['reset'] });
      expect(result).toEqual({ subcommand: 'reset' });
    });

    it('should default to info when no args', () => {
      const result = normalizeCommandData('project', {});
      expect(result).toEqual({ subcommand: 'info' });
    });

    it('should prefer explicit subcommand over args', () => {
      const result = normalizeCommandData('project', { subcommand: 'info', args: ['use', 'my-project'] });
      expect(result).toEqual({ subcommand: 'info', workingDir: 'my-project' });
    });

    it('should prefer explicit workingDir over args', () => {
      const result = normalizeCommandData('project', { subcommand: 'use', workingDir: '/explicit/path', args: ['use', 'my-project'] });
      expect(result).toEqual({ subcommand: 'use', workingDir: '/explicit/path' });
    });

    it('should return undefined for undefined rawData', () => {
      const result = normalizeCommandData('project', undefined);
      expect(result).toBeUndefined();
    });
  });

  describe('trigger command', () => {
    it('should normalize array args to mode', () => {
      const result = normalizeCommandData('trigger', { args: ['always'] });
      expect(result).toEqual({ mode: 'always' });
    });

    it('should normalize string arg to mode', () => {
      const result = normalizeCommandData('trigger', { args: 'mention' });
      expect(result).toEqual({ mode: 'mention' });
    });

    it('should return undefined mode when no args', () => {
      const result = normalizeCommandData('trigger', {});
      expect(result).toEqual({ mode: undefined });
    });
  });

  describe('commands without data', () => {
    it('should return undefined for help', () => {
      const result = normalizeCommandData('help', { args: [] });
      expect(result).toBeUndefined();
    });

    it('should return undefined for reset', () => {
      const result = normalizeCommandData('reset', {});
      expect(result).toBeUndefined();
    });
  });
});

describe('createControlCommand', () => {
  it('should create typed project command', () => {
    const cmd = createControlCommand('project', 'chat-1', { args: ['use', 'my-project'] });
    expect(cmd.type).toBe('project');
    expect(cmd.chatId).toBe('chat-1');
    expect(cmd.data).toEqual({ subcommand: 'use', workingDir: 'my-project' });
  });

  it('should create typed trigger command', () => {
    const cmd = createControlCommand('trigger', 'chat-1', { args: ['mention'] });
    expect(cmd.type).toBe('trigger');
    expect(cmd.data).toEqual({ mode: 'mention' });
  });

  it('should create command with no data', () => {
    const cmd = createControlCommand('reset', 'chat-1', {});
    expect(cmd.type).toBe('reset');
    expect(cmd.data).toBeUndefined();
  });

  it('should create command with targetNodeId', () => {
    const cmd = createControlCommand('switch-node', 'chat-1', undefined, { targetNodeId: 'node-2' });
    expect(cmd.type).toBe('switch-node');
    expect(cmd.targetNodeId).toBe('node-2');
  });
});
