/**
 * IPC Protocol definitions for cross-process communication.
 *
 * Defines the message format and types for Unix Socket IPC.
 *
 * @module ipc/protocol
 */

/**
 * Feishu API action types for IPC routing.
 * Issue #1035: IPC request routing for MCP Tools
 */
export type FeishuApiAction =
  | 'sendMessage'
  | 'sendCard'
  | 'uploadFile';

/**
 * IPC request types.
 */
export type IpcRequestType =
  | 'ping'
  | 'getActionPrompts'
  | 'registerActionPrompts'
  | 'unregisterActionPrompts'
  | 'generateInteractionPrompt'
  | 'cleanupExpiredContexts'
  | 'feishuApi';

/**
 * IPC request payload types.
 */
export interface IpcRequestPayloads {
  ping: Record<string, never>;
  getActionPrompts: { messageId: string };
  registerActionPrompts: {
    messageId: string;
    chatId: string;
    actionPrompts: Record<string, string>;
  };
  unregisterActionPrompts: { messageId: string };
  generateInteractionPrompt: {
    messageId: string;
    actionValue: string;
    actionText?: string;
    actionType?: string;
    formData?: Record<string, unknown>;
  };
  cleanupExpiredContexts: Record<string, never>;
  /**
   * Issue #1035: Feishu API request payload.
   * Allows MCP tools to send Feishu API requests via IPC.
   */
  feishuApi: {
    action: FeishuApiAction;
    params: {
      chatId: string;
      content?: string;
      card?: Record<string, unknown>;
      filePath?: string;
      threadId?: string;
      description?: string;
    };
  };
}

/**
 * IPC response payload types.
 */
export interface IpcResponsePayloads {
  ping: { pong: true };
  getActionPrompts: { prompts: Record<string, string> | null };
  registerActionPrompts: { success: true };
  unregisterActionPrompts: { success: boolean };
  generateInteractionPrompt: { prompt: string | null };
  cleanupExpiredContexts: { cleaned: number };
  /**
   * Issue #1035: Feishu API response payload.
   */
  feishuApi: {
    success: boolean;
    messageId?: string;
    fileName?: string;
    fileSize?: number;
    error?: string;
  };
}

/**
 * Generic IPC request structure.
 */
export interface IpcRequest<T extends IpcRequestType = IpcRequestType> {
  type: T;
  id: string;
  payload: IpcRequestPayloads[T];
}

/**
 * Generic IPC response structure.
 */
export interface IpcResponse<T extends IpcRequestType = IpcRequestType> {
  id: string;
  success: boolean;
  payload?: IpcResponsePayloads[T];
  error?: string;
}

/**
 * IPC configuration.
 */
export interface IpcConfig {
  /** Unix socket file path */
  socketPath: string;
  /** Connection timeout in milliseconds */
  timeout: number;
  /** Maximum retry attempts */
  maxRetries: number;
}

/**
 * Default IPC configuration.
 */
export const DEFAULT_IPC_CONFIG: IpcConfig = {
  socketPath: '/tmp/disclaude-interactive.ipc',
  timeout: 5000,
  maxRetries: 3,
};

/**
 * Issue #1035: IPC configuration for Feishu API routing.
 * Used by PrimaryNode to receive Feishu API requests from MCP tools.
 */
export const FEISHU_API_IPC_CONFIG: IpcConfig = {
  socketPath: '/tmp/disclaude-feishu-api.ipc',
  timeout: 30000, // Longer timeout for file uploads
  maxRetries: 3,
};
