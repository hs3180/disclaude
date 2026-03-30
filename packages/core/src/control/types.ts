/**
 * Control handler types.
 *
 * @module control/types
 */

import type { ControlCommand, ControlResponse, ControlCommandType } from '../types/channel.js';
import type { Logger } from '../utils/logger.js';

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
    /** Issue #1709: Dispose and remove agent to force recreation with new cwd */
    disposeAgent?(chatId: string): void;
  };

  /** 节点相关能力 */
  node: {
    nodeId: string;
    getExecNodes(): ExecNodeInfo[];
    getDebugGroup(): DebugGroup | null;
    clearDebugGroup(): void;
  };

  /** 被动模式管理（可选） */
  passiveMode?: {
    isEnabled(chatId: string): boolean;
    setEnabled(chatId: string, enabled: boolean): void;
  };

  /** Research 模式管理（可选，Issue #1709） */
  researchMode?: {
    isEnabled(chatId: string): boolean;
    getTopic(chatId: string): string | undefined;
    getResearchCwd(chatId: string): string | undefined;
    enable(chatId: string, topic: string): string | undefined;
    disable(chatId: string): void;
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
