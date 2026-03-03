/**
 * Tests for CommandRegistry.
 *
 * Issue #463: /help 指令 - 动态展示可用指令列表
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CommandRegistry,
  createDefaultCommandRegistry,
  getCommandRegistry,
  resetCommandRegistry,
} from './command-registry.js';

describe('CommandRegistry', () => {
  let registry: CommandRegistry;

  beforeEach(() => {
    registry = new CommandRegistry();
    resetCommandRegistry();
  });

  afterEach(() => {
    resetCommandRegistry();
  });

  describe('register', () => {
    it('should register a command', () => {
      registry.register({
        name: 'test',
        description: 'Test command',
        category: 'session',
      });

      const cmd = registry.get('test');
      expect(cmd).toBeDefined();
      expect(cmd?.name).toBe('test');
      expect(cmd?.description).toBe('Test command');
      expect(cmd?.enabled).toBe(true);
    });

    it('should respect enabled flag', () => {
      registry.register({
        name: 'disabled',
        description: 'Disabled command',
        category: 'session',
        enabled: false,
      });

      const cmd = registry.get('disabled');
      expect(cmd?.enabled).toBe(false);
    });
  });

  describe('registerAll', () => {
    it('should register multiple commands', () => {
      registry.registerAll([
        { name: 'cmd1', description: 'Command 1', category: 'session' },
        { name: 'cmd2', description: 'Command 2', category: 'group' },
      ]);

      expect(registry.get('cmd1')).toBeDefined();
      expect(registry.get('cmd2')).toBeDefined();
    });
  });

  describe('getAll', () => {
    it('should return all enabled commands', () => {
      registry.registerAll([
        { name: 'enabled', description: 'Enabled', category: 'session' },
        { name: 'disabled', description: 'Disabled', category: 'session', enabled: false },
      ]);

      const commands = registry.getAll();
      expect(commands).toHaveLength(1);
      expect(commands[0].name).toBe('enabled');
    });
  });

  describe('getByCategory', () => {
    it('should filter commands by category', () => {
      registry.registerAll([
        { name: 'session-cmd', description: 'Session', category: 'session' },
        { name: 'group-cmd', description: 'Group', category: 'group' },
        { name: 'debug-cmd', description: 'Debug', category: 'debug' },
      ]);

      const sessionCommands = registry.getByCategory('session');
      expect(sessionCommands).toHaveLength(1);
      expect(sessionCommands[0].name).toBe('session-cmd');
    });
  });

  describe('getActiveCategories', () => {
    it('should return categories in correct order', () => {
      registry.registerAll([
        { name: 'schedule-cmd', description: 'Schedule', category: 'schedule' },
        { name: 'session-cmd', description: 'Session', category: 'session' },
        { name: 'group-cmd', description: 'Group', category: 'group' },
      ]);

      const categories = registry.getActiveCategories();
      expect(categories).toEqual(['session', 'group', 'schedule']);
    });
  });

  describe('generateHelpText', () => {
    it('should generate formatted help text', () => {
      registry.registerAll([
        { name: 'reset', description: '重置对话', category: 'session' },
        { name: 'status', description: '查看状态', category: 'session' },
        { name: 'create-group', description: '创建群', usage: 'create-group <name> <members>', category: 'group' },
      ]);

      const helpText = registry.generateHelpText();

      expect(helpText).toContain('📋 **可用指令**');
      expect(helpText).toContain('💬 对话：');
      expect(helpText).toContain('- /reset - 重置对话');
      expect(helpText).toContain('- /status - 查看状态');
      expect(helpText).toContain('👥 群管理：');
      expect(helpText).toContain('- /create-group <name> <members> - 创建群');
    });

    it('should not include disabled commands', () => {
      registry.registerAll([
        { name: 'enabled', description: 'Enabled', category: 'session' },
        { name: 'disabled', description: 'Disabled', category: 'session', enabled: false },
      ]);

      const helpText = registry.generateHelpText();
      expect(helpText).toContain('enabled');
      expect(helpText).not.toContain('disabled');
    });
  });
});

describe('createDefaultCommandRegistry', () => {
  it('should create registry with default commands', () => {
    const registry = createDefaultCommandRegistry();

    // Session commands
    expect(registry.get('reset')).toBeDefined();
    expect(registry.get('status')).toBeDefined();

    // Node commands
    expect(registry.get('list-nodes')).toBeDefined();
    expect(registry.get('switch-node')).toBeDefined();
    expect(registry.get('restart')).toBeDefined();

    // Group commands
    expect(registry.get('create-group')).toBeDefined();
    expect(registry.get('add-member')).toBeDefined();
    expect(registry.get('remove-member')).toBeDefined();
    expect(registry.get('list-member')).toBeDefined();
    expect(registry.get('list-group')).toBeDefined();
    expect(registry.get('dissolve-group')).toBeDefined();
  });

  it('should generate help text with all categories', () => {
    const registry = createDefaultCommandRegistry();
    const helpText = registry.generateHelpText();

    expect(helpText).toContain('💬 对话：');
    expect(helpText).toContain('👥 群管理：');
    expect(helpText).toContain('🖥️ 节点：');
  });
});

describe('global registry', () => {
  beforeEach(() => {
    resetCommandRegistry();
  });

  afterEach(() => {
    resetCommandRegistry();
  });

  it('should return a singleton registry', () => {
    const registry1 = getCommandRegistry();
    const registry2 = getCommandRegistry();
    expect(registry1).toBe(registry2);
  });

  it('should reset to new registry', () => {
    const registry1 = getCommandRegistry();
    resetCommandRegistry();
    const registry2 = getCommandRegistry();
    expect(registry1).not.toBe(registry2);
  });
});
