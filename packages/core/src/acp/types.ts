/**
 * ACP (Agent Client Protocol) 类型定义
 *
 * 基于 @agentclientprotocol/sdk 和 ACP 规范，
 * 定义 ACP 相关的统一类型，与具体 SDK 实现无关。
 */

import type {
  SessionNotification,
  SessionUpdate,
  PromptResponse,
  StopReason,
  ContentBlock as AcpContentBlock,
  ToolCall,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';

// ============================================================================
// Re-export ACP SDK types with Acp prefix
// ============================================================================

/** ACP Content Block */
export type { AcpContentBlock };
/** ACP Session Notification */
export type AcpSessionNotification = SessionNotification;
/** ACP Session Update */
export type AcpSessionUpdate = SessionUpdate;
/** ACP Prompt Response */
export type AcpPromptResponse = PromptResponse;
/** ACP Stop Reason */
export type AcpStopReason = StopReason;
/** ACP Tool Call */
export type AcpToolCall = ToolCall;
/** ACP Tool Call Update */
export type AcpToolCallUpdate = ToolCallUpdate;

// ============================================================================
// ACP Session types
// ============================================================================

/** ACP Session 信息 */
export interface AcpSessionInfo {
  /** 会话 ID */
  sessionId: string;
  /** 工作目录 */
  cwd: string;
  /** 创建时间 */
  createdAt: Date;
  /** 最后活跃时间 */
  lastActiveAt: Date;
}

/** ACP Provider 配置 */
export interface AcpProviderConfig {
  /** 工作目录（创建 session 时使用） */
  cwd?: string;
  /** 日志级别 */
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  /** 是否自动批准权限请求（仅用于测试） */
  autoApprovePermissions?: boolean;
}

/** ACP 初始化结果 */
export interface AcpInitializeResult {
  /** 协议版本 */
  protocolVersion: number;
  /** Agent 信息 */
  agentInfo?: {
    name: string;
    version: string;
  };
  /** Agent 能力 */
  capabilities?: {
    loadSession?: boolean;
    mcpCapabilities?: {
      roots?: {
        listChanged?: boolean;
      };
    };
    promptCapabilities?: {
      contentTypes?: Array<string>;
    };
    sessionCapabilities?: {
      fork?: boolean;
      list?: boolean;
      resume?: boolean;
      close?: boolean;
    };
  };
}

/** ACP 会话创建结果 */
export interface AcpNewSessionResult {
  /** 会话 ID */
  sessionId: string;
  /** 初始模式状态 */
  modes?: unknown;
  /** 初始配置选项 */
  configOptions?: unknown[];
}

/** ACP 会话列表项 */
export interface AcpSessionListItem {
  /** 会话 ID */
  sessionId: string;
  /** 工作目录 */
  cwd: string;
  /** 标题 */
  title?: string;
  /** 最后更新时间 */
  lastUpdatedAt?: string;
}

// ============================================================================
// ACP Usage types
// ============================================================================

/** ACP Token 使用统计 */
export interface AcpUsageStats {
  /** 输入 token 数 */
  inputTokens: number;
  /** 输出 token 数 */
  outputTokens: number;
  /** 缓存读取 token 数 */
  cacheReadTokens?: number;
  /** 缓存写入 token 数 */
  cacheWriteTokens?: number;
  /** 费用（美分） */
  costCents?: number;
}
