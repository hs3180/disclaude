/**
 * Tests for CommandRegistry.
 *
 * Issue #463: 帮助消息系统 - 入群/私聊引导 + 指令注册
 * Issue #537: 完成所有指令的 DI 重构
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CommandRegistry, getCommandRegistry, resetCommandRegistry } from './command-registry.js';
import { registerDefaultCommands } from './builtin-commands.js';
import type { Command, CommandContext, CommandServices } from './types.js';

/**
 * Create mock services for testing.
 */
function createMockServices(): CommandServices {
  return {
    isRunning: () => true,
    getLocalNodeId: () => 'test-node',
    getExecNodes: () => [],
    getChatNodeAssignment: () => undefined,
    switchChatNode: () => false,
    getNode: () => undefined,
    sendCommand: () => Promise.resolve(),
    getFeishuClient: () => ({}) as never,
    createDiscussionChat: () => Promise.resolve('oc_test'),
    addMembers: () => Promise.resolve(),
    removeMembers: () => Promise.resolve(),
    getMembers: () => Promise.resolve([]),
    dissolveChat: () => Promise.resolve(),
    registerGroup: () => {},
    unregisterGroup: () => false,
    listGroups: () => [],
    // Group creation (Issue #692)
    createGroup: () => Promise.resolve({ chatId: 'oc_test', name: 'Test Group', createdAt: Date.now(), initialMembers: [] }),
    getBotChats: () => Promise.resolve([]),
    setDebugGroup: () => null,
    getDebugGroup: () => null,
    clearDebugGroup: () => null,
    getChannelStatus: () => 'feishu: connected',
    // Schedule management (Issue #469)
    listSchedules: () => Promise.resolve([]),
    getSchedule: () => Promise.resolve(undefined),
    enableSchedule: () => Promise.resolve(false),
    disableSchedule: () => Promise.resolve(false),
    runSchedule: () => Promise.resolve(false),
    isScheduleRunning: () => false,
    // Task management methods (Issue #468)
    startTask: () => Promise.resolve({ id: 'task_test', prompt: 'test', status: 'running', progress: 0, chatId: 'oc_test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
    getCurrentTask: () => Promise.resolve(null),
    updateTaskProgress: () => Promise.resolve(),
    pauseTask: () => Promise.resolve(null),
    resumeTask: () => Promise.resolve(null),
    cancelTask: () => Promise.resolve(null),
    completeTask: () => Promise.resolve(null),
    setTaskError: () => Promise.resolve(null),
    listTaskHistory: () => Promise.resolve([]),
    // Passive mode management (Issue #601)
    setPassiveMode: () => {},
    getPassiveMode: () => false,
    // Credit management (Issue #538)
    createCreditAccount: () => ({ agentId: 'test', balance: 0, dailyLimit: 100, usedToday: 0, lastResetAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() }),
    getCreditAccount: () => undefined,
    hasCreditAccount: () => false,
    rechargeCredits: () => undefined,
    setCreditDailyLimit: () => undefined,
    listCreditAccounts: () => [],
  };
}

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
      const cmd: Command = {
        name: 'test',
        description: 'Test command',
        category: 'session',
        execute: () => ({ success: true, message: 'Test' }),
      };

      registry.register(cmd);

      expect(registry.get('test')).toBeDefined();
      expect(registry.get('test')?.name).toBe('test');
      expect(registry.get('test')?.description).toBe('Test command');
    });

    it('should replace existing command', () => {
      const cmd1: Command = {
        name: 'test',
        description: 'First',
        category: 'session',
        execute: () => ({ success: true }),
      };
      const cmd2: Command = {
        name: 'test',
        description: 'Second',
        category: 'session',
        execute: () => ({ success: true }),
      };

      registry.register(cmd1);
      registry.register(cmd2);

      expect(registry.get('test')?.description).toBe('Second');
    });
  });

  describe('registerAll', () => {
    it('should register multiple commands', () => {
      const commands: Command[] = [
        { name: 'cmd1', description: 'Command 1', category: 'session', execute: () => ({ success: true }) },
        { name: 'cmd2', description: 'Command 2', category: 'group', execute: () => ({ success: true }) },
      ];

      registry.registerAll(commands);

      expect(registry.get('cmd1')).toBeDefined();
      expect(registry.get('cmd2')).toBeDefined();
    });
  });

  describe('getAll', () => {
    it('should return all enabled commands', () => {
      const commands: Command[] = [
        { name: 'enabled', description: 'Enabled', category: 'session', execute: () => ({ success: true }) },
        { name: 'disabled', description: 'Disabled', category: 'session', enabled: false, execute: () => ({ success: true }) },
      ];

      registry.registerAll(commands);

      const all = registry.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].name).toBe('enabled');
    });
  });

  describe('getByCategory', () => {
    it('should filter commands by category', () => {
      const commands: Command[] = [
        { name: 'session-cmd', description: 'Session', category: 'session', execute: () => ({ success: true }) },
        { name: 'group-cmd', description: 'Group', category: 'group', execute: () => ({ success: true }) },
      ];

      registry.registerAll(commands);

      const sessionCommands = registry.getByCategory('session');
      expect(sessionCommands).toHaveLength(1);
      expect(sessionCommands[0].name).toBe('session-cmd');
    });
  });

  describe('getActiveCategories', () => {
    it('should return categories in correct order', () => {
      const commands: Command[] = [
        { name: 'schedule-cmd', description: 'Schedule', category: 'schedule', execute: () => ({ success: true }) },
        { name: 'session-cmd', description: 'Session', category: 'session', execute: () => ({ success: true }) },
        { name: 'group-cmd', description: 'Group', category: 'group', execute: () => ({ success: true }) },
      ];

      registry.registerAll(commands);

      const categories = registry.getActiveCategories();
      expect(categories).toEqual(['session', 'group', 'schedule']);
    });
  });

  describe('generateHelpText', () => {
    it('should generate formatted help text', () => {
      const commands: Command[] = [
        { name: 'reset', description: '重置对话', category: 'session', execute: () => ({ success: true }) },
        { name: 'status', description: '查看状态', category: 'session', execute: () => ({ success: true }) },
        { name: 'create-group', description: '创建群', usage: 'create-group [name]',
 category: 'group', execute: () => ({ success: true }) },
      ];

      registry.registerAll(commands);
      const helpText = registry.generateHelpText();

      expect(helpText).toContain('📋 **可用指令**');
      expect(helpText).toContain('💬 对话：');
      expect(helpText).toContain('- /reset - 重置对话');
      expect(helpText).toContain('- /status - 查看状态');
      expect(helpText).toContain('👥 群管理：');
      expect(helpText).toContain('- /create-group [name] - 创建群');
    });

    it('should not include disabled commands', () => {
      const commands: Command[] = [
        { name: 'enabled', description: 'Enabled', category: 'session', execute: () => ({ success: true }) },
        { name: 'disabled', description: 'Disabled', category: 'session', enabled: false, execute: () => ({ success: true }) },
      ];

      registry.registerAll(commands);
      const helpText = registry.generateHelpText();

      expect(helpText).toContain('enabled');
      expect(helpText).not.toContain('disabled');
    });
  });

  describe('generateWelcomeMessage', () => {
    it('should generate welcome message with help', () => {
      const commands: Command[] = [
        { name: 'reset', description: '重置对话', category: 'session', execute: () => ({ success: true }) },
      ];

      registry.registerAll(commands);
      const welcome = registry.generateWelcomeMessage();

      expect(welcome).toContain('👋 你好！我是 Agent 助手');
      expect(welcome).toContain('📋 **可用指令**');
      expect(welcome).toContain('- /reset - 重置对话');
    });
  });

  describe('execute', () => {
    it('should execute command and return result', async () => {
      const cmd: Command = {
        name: 'test',
        description: 'Test',
        category: 'session',
        execute: (ctx: CommandContext) => ({
          success: true,
          message: `Executed with args: ${ctx.args.join(', ')}`,
        }),
      };

      registry.register(cmd);
      const result = await registry.execute('test', {
        chatId: 'test-chat',
        args: ['arg1', 'arg2'],
        rawText: '/test arg1 arg2',
        services: createMockServices(),
      });

      expect(result).toEqual({
        success: true,
        message: 'Executed with args: arg1, arg2',
      });
    });

    it('should return null for unknown command', async () => {
      const result = await registry.execute('unknown', {
        chatId: 'test-chat',
        args: [],
        rawText: '/unknown',
        services: createMockServices(),
      });

      expect(result).toBeNull();
    });

    it('should return error for disabled command', async () => {
      const cmd: Command = {
        name: 'disabled',
        description: 'Disabled',
        category: 'session',
        enabled: false,
        execute: () => ({ success: true }),
      };

      registry.register(cmd);
      const result = await registry.execute('disabled', {
        chatId: 'test-chat',
        args: [],
        rawText: '/disabled',
        services: createMockServices(),
      });

      expect(result?.success).toBe(false);
      expect(result?.error).toContain('已禁用');
    });

    it('should handle execution errors', async () => {
      const cmd: Command = {
        name: 'error-cmd',
        description: 'Error',
        category: 'session',
        execute: () => {
          throw new Error('Test error');
        },
      };

      registry.register(cmd);
      const result = await registry.execute('error-cmd', {
        chatId: 'test-chat',
        args: [],
        rawText: '/error-cmd',
        services: createMockServices(),
      });

      expect(result?.success).toBe(false);
      expect(result?.error).toContain('Test error');
    });
  });
});

describe('getCommandRegistry', () => {
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

describe('registerDefaultCommands', () => {
  it('should register all default commands', () => {
    const registry = new CommandRegistry();
    registerDefaultCommands(registry, () => 'Help text');

    // Session commands
    expect(registry.get('reset')).toBeDefined();
    expect(registry.get('status')).toBeDefined();
    expect(registry.get('help')).toBeDefined();

    // Node commands
    expect(registry.get('list-nodes')).toBeDefined();
    expect(registry.get('switch-node')).toBeDefined();
    expect(registry.get('restart')).toBeDefined();

    // Group commands
    expect(registry.get('create-group')).toBeDefined();
    expect(registry.get('add-group-member')).toBeDefined();
    expect(registry.get('remove-group-member')).toBeDefined();
    expect(registry.get('list-group-members')).toBeDefined();
    expect(registry.get('groups')).toBeDefined();  // Issue #648: renamed from list-group
    expect(registry.get('dissolve-group')).toBeDefined();
    expect(registry.get('passive')).toBeDefined();

    // Task commands (Issue #468)
    expect(registry.get('task')).toBeDefined();
  });

  it('should generate help text with all categories', () => {
    const registry = new CommandRegistry();
    registerDefaultCommands(registry, () => registry.generateHelpText());

    const helpText = registry.generateHelpText();

    expect(helpText).toContain('💬 对话：');
    expect(helpText).toContain('👥 群管理：');
    expect(helpText).toContain('🖥️ 节点：');
  });
});
