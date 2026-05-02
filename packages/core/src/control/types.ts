/**
 * Control handler types.
 *
 * @module control/types
 */

import type { ControlCommand, ControlResponse, ControlCommandType } from '../types/channel.js';
import type { Logger } from '../utils/logger.js';
import type { TriggerMode } from '../config/types.js';
import type { ProjectManager } from '../project/project-manager.js';

/**
 * Debug 组信息
 */
export interface DebugGroup {
  chatId: string;
  name?: string;
  setAt: number;
}

/**
 * 控制命令处理器上下文
 */
export interface ControlHandlerContext {
  /** AgentPool 实例 */
  agentPool: {
    reset(chatId: string): void;
    /** Issue #1349: Stop current query without resetting session */
    stop(chatId: string): boolean;
  };

  /** 节点相关能力 */
  node: {
    nodeId: string;
    getDebugGroup(): DebugGroup | null;
    setDebugGroup(chatId: string, name?: string): void;
    clearDebugGroup(): DebugGroup | null;
  };

  /** 触发模式管理（可选） (Issue #2291: enum-based interface) */
  triggerMode?: {
    /** Get the current trigger mode for a chat */
    getMode(chatId: string): TriggerMode;
    /** Set the trigger mode for a chat */
    setMode(chatId: string, mode: TriggerMode): void;
  };

  /** ProjectManager for per-chatId project context (Issue #1916) */
  projectManager?: ProjectManager;

  /** 日志记录器 */
  logger?: Logger;
}

/**
 * 单个命令的处理函数
 */
export type CommandHandler = (
  command: ControlCommand,
  context: ControlHandlerContext
) => Promise<ControlResponse> | ControlResponse;

/**
 * 命令定义
 */
export interface CommandDefinition {
  type: ControlCommandType;
  handler: CommandHandler;
  description: string;
  usage?: string;
}
