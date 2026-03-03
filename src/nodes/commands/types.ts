/**
 * Command System Types.
 *
 * Defines the Command interface and related types for the DI-based command system.
 *
 * Issue #463: 帮助消息系统 - 入群/私聊引导 + 指令注册
 * Issue #537: 完成所有指令的 DI 重构
 */

import type * as lark from '@larksuiteoapi/node-sdk';

/**
 * Command category for grouping related commands.
 */
export type CommandCategory = 'session' | 'group' | 'debug' | 'node' | 'task' | 'schedule' | 'skill';

/**
 * Execution node info for status display.
 */
export interface ExecNodeInfo {
  nodeId: string;
  name: string;
  status: string;
  isLocal: boolean;
  activeChats: number;
}

/**
 * Group info for group management.
 */
export interface ManagedGroupInfo {
  chatId: string;
  name: string;
  createdAt: number;
  createdBy?: string;
  initialMembers: string[];
}

/**
 * Debug group info.
 */
export interface DebugGroupInfo {
  chatId: string;
  name?: string;
  setAt: number;
}

/**
 * Command services - dependencies injected into commands.
 *
 * These services provide access to the underlying functionality
 * that commands need to execute.
 */
export interface CommandServices {
  /** Check if the node is running */
  isRunning: () => boolean;

  /** Get the local node ID */
  getLocalNodeId: () => string;

  /** Get all execution nodes */
  getExecNodes: () => ExecNodeInfo[];

  /** Get the node assignment for a chat */
  getChatNodeAssignment: (chatId: string) => string | undefined;

  /** Switch a chat to a specific execution node */
  switchChatNode: (chatId: string, targetNodeId: string) => boolean;

  /** Get a node by ID (returns partial info) */
  getNode: (nodeId: string) => { name: string } | undefined;

  /** Send a command to execution node */
  sendCommand: (command: 'reset' | 'restart', chatId: string) => Promise<void>;

  /** Get Feishu client for group operations */
  getFeishuClient: () => lark.Client;

  /** Create a discussion chat */
  createDiscussionChat: (client: lark.Client, options: { topic: string; members: string[] }) => Promise<string>;

  /** Add members to a chat */
  addMembers: (client: lark.Client, chatId: string, members: string[]) => Promise<void>;

  /** Remove members from a chat */
  removeMembers: (client: lark.Client, chatId: string, members: string[]) => Promise<void>;

  /** Get members of a chat */
  getMembers: (client: lark.Client, chatId: string) => Promise<string[]>;

  /** Dissolve a chat */
  dissolveChat: (client: lark.Client, chatId: string) => Promise<void>;

  /** Register a group */
  registerGroup: (group: ManagedGroupInfo) => void;

  /** Unregister a group */
  unregisterGroup: (chatId: string) => boolean;

  /** List all managed groups */
  listGroups: () => ManagedGroupInfo[];

  /** Set debug group */
  setDebugGroup: (chatId: string, name?: string) => DebugGroupInfo | null;

  /** Get debug group */
  getDebugGroup: () => DebugGroupInfo | null;

  /** Clear debug group */
  clearDebugGroup: () => DebugGroupInfo | null;

  /** Get channel status list */
  getChannelStatus: () => string;
}

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

  /** Injected services (Issue #537) */
  services: CommandServices;
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
