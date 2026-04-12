/**
 * Control handler types.
 *
 * @module control/types
 */

import type { ControlCommand, ControlResponse, ControlCommandType } from '../types/channel.js';
import type { Logger } from '../utils/logger.js';
import type { TriggerMode } from '../config/types.js';

/**
 * 执行节点信息
 */
export interface ExecNodeInfo {
  nodeId: string;
  name: string;
  status: 'connected' | 'disconnected';
  activeChats: number;
  connectedAt?: Date;
  isLocal?: boolean;
}

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
    getExecNodes(): ExecNodeInfo[];
    getDebugGroup(): DebugGroup | null;
    setDebugGroup(chatId: string, name?: string): void;
    clearDebugGroup(): DebugGroup | null;
  };

  /** 触发模式管理（可选） (Issue #2291: upgraded to enum-based interface) */
  triggerMode?: {
    /** Get the current trigger mode for a chat */
    getMode(chatId: string): TriggerMode;
    /** Set the trigger mode for a chat */
    setMode(chatId: string, mode: TriggerMode): void;
    /**
     * @deprecated Use getMode() instead. Kept for backward compatibility.
     * Returns true when mode is 'mention' (mention-only filter active).
     */
    isEnabled(chatId: string): boolean;
    /**
     * @deprecated Use setMode() instead. Kept for backward compatibility.
     * enabled=true → 'mention', enabled=false → 'always'
     */
    setEnabled(chatId: string, enabled: boolean): void;
  };
  /** @deprecated Use triggerMode instead. Kept for backward compatibility during transition. */
  passiveMode?: {
    getMode(chatId: string): TriggerMode;
    setMode(chatId: string, mode: TriggerMode): void;
    isEnabled(chatId: string): boolean;
    setEnabled(chatId: string, enabled: boolean): void;
  };

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
