/**
 * Command Registry - DI-based command registration and discovery.
 *
 * Manages control commands with:
 * - Category-based organization
 * - Dynamic command discovery
 * - Help text generation
 *
 * Issue #463: 帮助消息系统 - 入群/私聊引导 + 指令注册
 */

import { CATEGORY_CONFIG, type Command, type CommandCategory, type CommandContext, type CommandResult } from './types.js';

/**
 * Command Registry - Manages control command instances.
 *
 * Commands are registered as instances implementing the Command interface.
 * The registry provides dynamic discovery and help text generation.
 */
export class CommandRegistry {
  private commands: Map<string, Command> = new Map();

  /**
   * Register a command instance.
   */
  register(command: Command): void {
    if (this.commands.has(command.name)) {
      console.warn(`Command "${command.name}" is already registered, replacing`);
    }
    this.commands.set(command.name, command);
  }

  /**
   * Register multiple command instances.
   */
  registerAll(commands: Command[]): void {
    for (const cmd of commands) {
      this.register(cmd);
    }
  }

  /**
   * Get a command by name.
   */
  get(name: string): Command | undefined {
    return this.commands.get(name);
  }

  /**
   * Check if a command exists.
   */
  has(name: string): boolean {
    return this.commands.has(name);
  }

  /**
   * Get all registered commands (enabled only).
   */
  getAll(): Command[] {
    return Array.from(this.commands.values()).filter(
      cmd => cmd.enabled !== false
    );
  }

  /**
   * Get commands by category.
   */
  getByCategory(category: CommandCategory): Command[] {
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
      const orderA = CATEGORY_CONFIG[a]?.order || 99;
      const orderB = CATEGORY_CONFIG[b]?.order || 99;
      return orderA - orderB;
    });
  }

  /**
   * Execute a command by name.
   *
   * @param name - Command name
   * @param context - Execution context
   * @returns Command result or null if command not found
   */
  async execute(name: string, context: CommandContext): Promise<CommandResult | null> {
    const command = this.commands.get(name);
    if (!command) {
      return null;
    }

    if (command.enabled === false) {
      return { success: false, error: `命令 /${name} 已禁用` };
    }

    try {
      return await command.execute(context);
    } catch (error) {
      return {
        success: false,
        error: `执行命令 /${name} 失败: ${error instanceof Error ? error.message : '未知错误'}`,
      };
    }
  }

  /**
   * Generate help text with all commands grouped by category.
   */
  generateHelpText(): string {
    const lines: string[] = ['📋 **可用指令**', ''];

    const categories = this.getActiveCategories();

    for (const category of categories) {
      const info = CATEGORY_CONFIG[category];
      if (!info) {
        continue;
      }

      const commands = this.getByCategory(category);
      if (commands.length === 0) {
        continue;
      }

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

  /**
   * Generate welcome message with brief help.
   */
  generateWelcomeMessage(): string {
    return `👋 你好！我是 Agent 助手

我可以帮你：
- 🔍 搜索和读取文件
- 💻 执行代码和命令
- 📝 创建和编辑文件
- 🌐 搜索网络获取信息

直接告诉我你想做什么即可！

${this.generateHelpText()}`;
  }
}

// Global singleton instance
let globalRegistry: CommandRegistry | undefined;

/**
 * Get the global command registry.
 */
export function getCommandRegistry(): CommandRegistry {
  if (!globalRegistry) {
    globalRegistry = new CommandRegistry();
  }
  return globalRegistry;
}

/**
 * Reset the global registry (for testing).
 */
export function resetCommandRegistry(): void {
  globalRegistry = undefined;
}
