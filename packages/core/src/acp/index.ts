/**
 * ACP (Agent Communication Protocol) 模块
 *
 * 提供基于 ACP 协议的标准化 Agent 通信接口。
 * 支持会话生命周期管理、模式切换、实时更新通知等功能。
 *
 * ## 目录结构
 *
 * ```
 * packages/core/src/acp/
 * ├── index.ts                 # 本文件 - 公开导出
 * ├── types.ts                 # ACP 类型定义
 * ├── interface.ts             # IAcpProvider 接口
 * ├── session-store.ts         # 会话存储管理
 * ├── message-adapter.ts       # ACP ↔ AgentMessage 转换
 * └── providers/
 *     └── claude/              # Claude ACP Provider 实现
 *         ├── index.ts
 *         └── acp-provider.ts
 * ```
 *
 * ## 使用示例
 *
 * ```typescript
 * import { getAcpProvider } from '@disclaude/core';
 *
 * // 初始化
 * const provider = await getAcpProvider();
 *
 * // 创建会话
 * const session = await provider.createSession({ cwd: '/workspace' });
 *
 * // 发送 prompt
 * const result = await provider.prompt(session.sessionId, {
 *   content: 'Fix the bug in index.ts',
 *   onSessionUpdate: (update) => console.log(update),
 * });
 *
 * // 关闭会话
 * await provider.closeSession(session.sessionId);
 * ```
 *
 * @module acp
 */

// ============================================================================
// 类型导出
// ============================================================================

export type {
  // 会话类型
  AcpSessionState,
  AcpSessionInfo,
  AcpSessionOptions,
  AcpListSessionsOptions,
  AcpListSessionsResult,

  // Prompt 类型
  AcpStopReason,
  AcpPromptOptions,
  AcpPromptResult,
  AcpAttachment,

  // Session Update 类型
  AcpSessionUpdateType,
  AcpSessionUpdate,
  AcpSessionUpdateData,
  AcpContentData,
  AcpToolCallData,
  AcpToolOutputData,
  AcpExecPlanData,
  AcpExecPlanStep,
  AcpModeUpdateData,
  AcpCompletedData,

  // 使用统计
  AcpUsageStats,

  // Provider 信息
  AcpCapabilities,
  AcpProviderInfo,
} from './types.js';

// ============================================================================
// 接口导出
// ============================================================================

export type {
  IAcpProvider,
  AcpProviderFactory,
} from './interface.js';

// ============================================================================
// 实现导出
// ============================================================================

export { ClaudeAcpProvider } from './providers/claude/index.js';
export { AcpSessionStore } from './session-store.js';

// ============================================================================
// 工具函数导出
// ============================================================================

export {
  acpUpdateToAgentMessage,
  agentMessageToAcpUpdate,
} from './message-adapter.js';
