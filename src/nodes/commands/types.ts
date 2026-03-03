/**
 * Command System Types.
 *
 * Defines the Command interface and related types for the DI-based command system.
 *
 * Issue #463: 帮助消息系统 - 入群/私聊引导 + 指令注册
 */

/**
 * Command category for grouping related commands.
 */
export type CommandCategory = 'session' | 'group' | 'debug' | 'node' | 'task' | 'schedule' | 'skill';

/**
 * Command execution context.
 */
export interface CommandContext {
  /** Target chat ID */
  chatId: string;

  /** User ID who invoked the command */
  userId?: string;

  /** Command arguments */
  args: string[];

  /** Raw command text */
  rawText: string;

  /** Additional data from the channel */
  data?: Record<string, unknown>;
}

/**
 * Command execution result.
 */
export interface CommandResult {
  /** Whether the command was executed successfully */
  success: boolean;

  /** Response message */
  message?: string;

  /** Error message if failed */
  error?: string;

  /** Additional data for command handler (Issue #541) */
  data?: Record<string, unknown>;
}

/**
 * Command interface.
 *
 * All control commands must implement this interface.
 * Commands are registered via DI and discovered dynamically.
 */
export interface Command {
  /** Command name (without /) */
  readonly name: string;

  /** Command category for grouping */
  readonly category: CommandCategory;

  /** Brief description for help text */
  readonly description: string;

  /** Usage example (optional) */
  readonly usage?: string;

  /** Whether command is enabled (default: true) */
  readonly enabled?: boolean;

  /**
   * Execute the command.
   *
   * @param context - Command execution context
   * @returns Command execution result (can be sync or async)
   */
  execute(context: CommandContext): CommandResult | Promise<CommandResult>;
}

/**
 * Category display configuration.
 */
export interface CategoryInfo {
  /** Display label in Chinese */
  label: string;

  /** Emoji icon */
  emoji: string;

  /** Sort order (lower = earlier) */
  order: number;
}

/**
 * Category display names and order.
 */
export const CATEGORY_CONFIG: Record<CommandCategory, CategoryInfo> = {
  session: { label: '对话', emoji: '💬', order: 1 },
  debug: { label: '调试', emoji: '🔧', order: 2 },
  group: { label: '群管理', emoji: '👥', order: 3 },
  node: { label: '节点', emoji: '🖥️', order: 4 },
  task: { label: '任务', emoji: '📋', order: 5 },
  schedule: { label: '定时', emoji: '⏰', order: 6 },
  skill: { label: '技能', emoji: '🎯', order: 7 },
};
