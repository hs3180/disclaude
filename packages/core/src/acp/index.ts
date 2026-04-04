/**
 * ACP (Agent Communication Protocol) 模块
 *
 * 提供 ACP 协议基础设施，包括：
 * - 类型定义（JSON-RPC 2.0 消息、ACP 方法/通知、能力声明）
 * - 传输层（stdio、SSE）
 * - 客户端（JSON-RPC 消息处理、请求/响应关联、通知分发）
 *
 * ## 使用示例
 *
 * ```typescript
 * import { AcpClient } from '@disclaude/core';
 *
 * const client = new AcpClient({
 *   type: 'stdio',
 *   command: 'npx',
 *   args: ['-y', 'openai-acp-server'],
 * });
 *
 * const result = await client.connect({
 *   clientName: 'disclaude',
 *   clientVersion: '1.0.0',
 *   capabilities: { subscriptions: true },
 * });
 *
 * // 监听任务通知
 * client.on('task:message', (notification) => {
 *   console.log('Message:', notification.message);
 * });
 *
 * // 创建并发送任务
 * const task = await client.createTask();
 * await client.sendTaskMessage({
 *   taskId: task.id,
 *   message: { role: 'user', content: { type: 'text', text: 'Hello!' } },
 * });
 * ```
 *
 * @module acp
 * @see Issue #1333 - 支持OpenAI Agent via ACP
 */

// ============================================================================
// 类型导出
// ============================================================================

export type {
  // JSON-RPC 2.0 基础类型
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
  JsonRpcErrorObject,
  JsonRpcErrorResponse,
  JsonRpcResponse,
  JsonRpcMessage,

  // ACP 能力
  AcpAgentCapabilities,
  AcpClientCapabilities,

  // ACP 初始化
  AcpInitializeParams,
  AcpInitializeResult,

  // ACP 任务
  AcpTaskState,
  AcpTaskInfo,
  AcpTaskCreateParams,
  AcpTaskCreateResult,
  AcpTaskSendParams,
  AcpTaskCancelParams,
  AcpTaskGetParams,
  AcpTaskCloseParams,
  AcpTaskForkParams,
  AcpTaskForkResult,
  AcpTaskListResult,

  // ACP 消息内容
  AcpTextContent,
  AcpImageContent,
  AcpToolUseContent,
  AcpToolResultContent,
  AcpContentBlock,
  AcpRole,
  AcpMessage,

  // ACP 通知
  AcpTaskStatusNotification,
  AcpTaskMessageNotification,
  AcpTaskArtefactNotification,

  // ACP 传输
  AcpTransportType,
  AcpStdioConfig,
  AcpSseConfig,
  AcpTransportConfig,

  // ACP 事件
  AcpClientEvents,
} from './types.js';

// ============================================================================
// 常量导出
// ============================================================================

export {
  JsonRpcErrorCode,
  AcpMethod,
  AcpNotification,
} from './types.js';

// ============================================================================
// 传输层导出
// ============================================================================

export {
  StdioTransport,
  SSETransport,
  createTransport,
} from './transport.js';

export type { AcpTransport } from './transport.js';

// ============================================================================
// 客户端导出
// ============================================================================

export { AcpClient } from './client.js';
