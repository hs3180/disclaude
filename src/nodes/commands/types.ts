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
export type CommandCategory = 'session' | 'group' | 'debug' | 'node' | 'task' | 'schedule' | 'skill' | 'credit';

/**
 * Schedule task info for display.
 * Issue #469: 定时任务控制指令
 */
export interface ScheduleTaskInfo {
  /** Task ID */
  id: string;
  /** Task name */
  name: string;
  /** Cron expression */
  cron: string;
  /** Whether task is enabled */
  enabled: boolean;
  /** Whether task is currently scheduled */
  isScheduled: boolean;
  /** Whether task is currently running */
  isRunning: boolean;
  /** Target chat ID */
  chatId: string;
  /** Creation timestamp */
  createdAt?: string;
}

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
 * Bot chat info from Feishu API.
 * Issue #648: 改进群列表命令
 */
export interface BotChatInfo {
  chatId: string;
  name: string;
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
  createDiscussionChat: (client: lark.Client, options: { topic?: string; members?: string[] }, creatorId?: string) => Promise<string>;

  /**
   * Create a group and register it automatically.
   * @see Issue #692 - GroupService 支持创建群聊
   */
  createGroup: (client: lark.Client, options: { topic?: string; members?: string[]; creatorId?: string }) => Promise<ManagedGroupInfo>;

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

  /** Get all chats the bot is in (from Feishu API) */
  getBotChats: (client: lark.Client) => Promise<BotChatInfo[]>;

  /** Set debug group */
  setDebugGroup: (chatId: string, name?: string) => DebugGroupInfo | null;

  /** Get debug group */
  getDebugGroup: () => DebugGroupInfo | null;

  /** Clear debug group */
  clearDebugGroup: () => DebugGroupInfo | null;

  /** Get channel status list */
  getChannelStatus: () => string;

  // Schedule management (Issue #469)
  /** List all scheduled tasks */
  listSchedules: () => Promise<ScheduleTaskInfo[]>;

  /** Get a schedule by name or ID */
  getSchedule: (nameOrId: string) => Promise<ScheduleTaskInfo | undefined>;

  /** Enable a schedule */
  enableSchedule: (nameOrId: string) => Promise<boolean>;

  /** Disable a schedule */
  disableSchedule: (nameOrId: string) => Promise<boolean>;

  /** Manually trigger a schedule */
  runSchedule: (nameOrId: string) => Promise<boolean>;

  /** Check if a schedule is currently running */
  isScheduleRunning: (taskId: string) => boolean;

  // Task management methods (Issue #468)

  /** Start a new task */
  startTask: (prompt: string, chatId: string, userId?: string) => Promise<import('../../utils/task-state-manager.js').TaskState>;

  /** Get current task */
  getCurrentTask: () => Promise<import('../../utils/task-state-manager.js').TaskState | null>;

  /** Update task progress */
  updateTaskProgress: (progress: number, currentStep?: string) => Promise<void>;

  /** Pause current task */
  pauseTask: () => Promise<import('../../utils/task-state-manager.js').TaskState | null>;

  /** Resume paused task */
  resumeTask: () => Promise<import('../../utils/task-state-manager.js').TaskState | null>;

  /** Cancel current task */
  cancelTask: () => Promise<import('../../utils/task-state-manager.js').TaskState | null>;

  /** Complete current task */
  completeTask: () => Promise<import('../../utils/task-state-manager.js').TaskState | null>;

  /** Set task error */
  setTaskError: (error: string) => Promise<import('../../utils/task-state-manager.js').TaskState | null>;

  /** List task history */
  listTaskHistory: (limit?: number) => Promise<import('../../utils/task-state-manager.js').TaskState[]>;

  // Passive mode management (Issue #601)
  /** Set passive mode for a chat (true = respond to all, false = only @mention) */
  setPassiveMode: (chatId: string, disabled: boolean) => void;

  /** Get passive mode status for a chat (true = respond to all, false = only @mention) */
  getPassiveMode: (chatId: string) => boolean;

  // Credit management (Issue #538)
  /** Create a credit account */
  createCreditAccount: (options: import('../../credits/types.js').CreateAccountOptions) => import('../../credits/types.js').AgentAccount;

  /** Get credit account */
  getCreditAccount: (agentId: string) => import('../../credits/types.js').AgentAccount | undefined;

  /** Check if credit account exists */
  hasCreditAccount: (agentId: string) => boolean;

  /** Recharge credits */
  rechargeCredits: (options: import('../../credits/types.js').RechargeOptions) => import('../../credits/types.js').AgentAccount | undefined;

  /** Set daily limit */
  setCreditDailyLimit: (options: import('../../credits/types.js').SetDailyLimitOptions) => import('../../credits/types.js').AgentAccount | undefined;

  /** List all credit accounts */
  listCreditAccounts: () => import('../../credits/types.js').AgentAccount[];
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
  credit: { label: '积分', emoji: '💰', order: 8 },
};
