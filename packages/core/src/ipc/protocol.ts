/**
 * IPC Protocol definitions for cross-process communication.
 *
 * Defines the message format and types for Unix Socket IPC.
 *
 * @module core/ipc/protocol
 */

import { tmpdir } from 'os';
import { join } from 'path';

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
  // Channel API operations (Issue #1568: renamed from feishu* prefix)
  | 'sendMessage'
  | 'sendCard'
  | 'uploadFile';

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
  // Channel API operations (Issue #1568: renamed from feishu* prefix)
  sendMessage: {
    chatId: string;
    text: string;
    threadId?: string;
  };
  sendCard: {
    chatId: string;
    card: Record<string, unknown>;
    threadId?: string;
    description?: string;
  };
  uploadFile: {
    chatId: string;
    filePath: string;
    threadId?: string;
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
  // Channel API operations (Issue #1568: renamed from feishu* prefix)
  sendMessage: { success: boolean; messageId?: string };
  sendCard: { success: boolean; messageId?: string };
  uploadFile: {
    success: boolean;
    fileKey?: string;
    fileType?: string;
    fileName?: string;
    fileSize?: number;
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
 *
 * Note: The socketPath here is a fallback default. In production,
 * Primary Node and Worker Node generate a random socket path
 * via `generateSocketPath()` to avoid multi-instance conflicts (Issue #1355).
 */
export const DEFAULT_IPC_CONFIG: IpcConfig = {
  socketPath: '/tmp/disclaude-interactive.ipc',
  timeout: 5000,
  maxRetries: 3,
};

/**
 * Generate a unique random socket path for IPC server.
 *
 * Issue #1355: Fixed path `/tmp/disclaude-worker.ipc` causes conflicts when
 * multiple instances run simultaneously or after PM2 restarts. This generates
 * a unique path per process to avoid such issues.
 *
 * @returns Unique socket file path in the system temp directory
 */
export function generateSocketPath(): string {
  return join(
    tmpdir(),
    `disclaude-ipc-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.sock`
  );
}
