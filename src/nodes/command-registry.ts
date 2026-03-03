/**
 * Command Registry - Dynamic command registration and discovery.
 *
 * Provides a centralized registry for control commands with:
 * - Category-based organization
 * - Dynamic command discovery
 * - Help text generation
 *
 * Issue #463: /help 指令 - 动态展示可用指令列表
 */

import type { ControlCommandType } from '../channels/types.js';

/**
 * Command category for grouping related commands.
 */
export type CommandCategory = 'session' | 'group' | 'debug' | 'node' | 'task' | 'schedule' | 'skill';

/**
 * Command definition with metadata.
 */
export interface CommandDefinition {
  /** Command name (without /) */
  name: ControlCommandType | string;

  /** Brief description for help text */
  description: string;

  /** Usage example */
  usage?: string;

  /** Category for grouping */
  category: CommandCategory;

  /** Whether command is enabled */
  enabled?: boolean;
}

/**
 * Category display names and order.
 */
const CATEGORY_INFO: Record<CommandCategory, { label: string; emoji: string; order: number }> = {
  session: { label: '对话', emoji: '💬', order: 1 },
  debug: { label: '调试', emoji: '🔧', order: 2 },
  group: { label: '群管理', emoji: '👥', order: 3 },
  node: { label: '节点', emoji: '🖥️', order: 4 },
  task: { label: '任务', emoji: '📋', order: 5 },
  schedule: { label: '定时', emoji: '⏰', order: 6 },
  skill: { label: '技能', emoji: '🎯', order: 7 },
};

/**
 * Command Registry - Manages control command definitions.
 */
export class CommandRegistry {
  private commands: Map<string, CommandDefinition> = new Map();

  /**
   * Register a command definition.
   */
  register(command: CommandDefinition): void {
    this.commands.set(command.name, {
      ...command,
      enabled: command.enabled !== false,
    });
  }

  /**
   * Register multiple commands at once.
   */
  registerAll(commands: CommandDefinition[]): void {
    for (const cmd of commands) {
      this.register(cmd);
    }
  }

  /**
   * Get a command definition by name.
   */
  get(name: string): CommandDefinition | undefined {
    return this.commands.get(name);
  }

  /**
   * Get all registered commands.
   */
  getAll(): CommandDefinition[] {
    return Array.from(this.commands.values()).filter(cmd => cmd.enabled !== false);
  }

  /**
   * Get commands by category.
   */
  getByCategory(category: CommandCategory): CommandDefinition[] {
    return this.getAll().filter(cmd => cmd.category === category);
  }

  /**
   * Get all categories that have commands.
   */
  getActiveCategories(): CommandCategory[] {
    const categories = new Set<CommandCategory>();
    for (const cmd of this.getAll()) {
      categories.add(cmd.category);
    }
    return Array.from(categories).sort((a, b) => {
      const orderA = CATEGORY_INFO[a]?.order || 99;
      const orderB = CATEGORY_INFO[b]?.order || 99;
      return orderA - orderB;
    });
  }

  /**
   * Generate help text with all commands grouped by category.
   */
  generateHelpText(): string {
    const lines: string[] = ['📋 **可用指令**', ''];

    const categories = this.getActiveCategories();

    for (const category of categories) {
      const info = CATEGORY_INFO[category];
      if (!info) continue;

      const commands = this.getByCategory(category);
      if (commands.length === 0) continue;

      lines.push(`${info.emoji} ${info.label}：`);

      for (const cmd of commands) {
        if (cmd.usage) {
          lines.push(`- /${cmd.usage} - ${cmd.description}`);
        } else {
          lines.push(`- /${cmd.name} - ${cmd.description}`);
        }
      }

      lines.push('');
    }

    // Remove trailing empty line
    if (lines[lines.length - 1] === '') {
      lines.pop();
    }

    return lines.join('\n');
  }
}

/**
 * Default command registry with built-in commands.
 */
export function createDefaultCommandRegistry(): CommandRegistry {
  const registry = new CommandRegistry();

  registry.registerAll([
    // Session commands
    {
      name: 'reset',
      description: '重置对话',
      category: 'session',
    },
    {
      name: 'status',
      description: '查看状态',
      category: 'session',
    },

    // Node commands
    {
      name: 'list-nodes',
      description: '列出执行节点',
      category: 'node',
    },
    {
      name: 'switch-node',
      usage: 'switch-node <nodeId>',
      description: '切换执行节点',
      category: 'node',
    },
    {
      name: 'restart',
      description: '重启服务',
      category: 'node',
    },

    // Group management commands (Issue #486)
    {
      name: 'create-group',
      usage: 'create-group <name> <members>',
      description: '创建群',
      category: 'group',
    },
    {
      name: 'add-member',
      usage: 'add-member <groupId> <member>',
      description: '添加成员',
      category: 'group',
    },
    {
      name: 'remove-member',
      usage: 'remove-member <groupId> <member>',
      description: '移除成员',
      category: 'group',
    },
    {
      name: 'list-member',
      usage: 'list-member <groupId>',
      description: '列出成员',
      category: 'group',
    },
    {
      name: 'list-group',
      description: '列出群',
      category: 'group',
    },
    {
      name: 'dissolve-group',
      usage: 'dissolve-group <groupId>',
      description: '解散群',
      category: 'group',
    },
  ]);

  return registry;
}

/**
 * Global command registry instance.
 */
let globalRegistry: CommandRegistry | undefined;

/**
 * Get the global command registry.
 */
export function getCommandRegistry(): CommandRegistry {
  if (!globalRegistry) {
    globalRegistry = createDefaultCommandRegistry();
  }
  return globalRegistry;
}

/**
 * Reset the global registry (for testing).
 */
export function resetCommandRegistry(): void {
  globalRegistry = undefined;
}
