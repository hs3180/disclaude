/**
 * IPC Protocol definitions for cross-process communication.
 *
 * Defines the message format and types for Unix Socket IPC.
 *
 * @module core/ipc/protocol
 */

import { tmpdir } from 'os';
import { join } from 'path';
import type { FeishuCard } from '../types/platform.js';

/**
 * IPC request types.
 */
export type IpcRequestType =
  | 'ping'
  // Platform-agnostic messaging operations (Issue #1574: Phase 5 of IPC refactor)
  | 'sendMessage'
  | 'sendCard'
  | 'uploadFile'
  // Raw-param interactive card (Issue #1570: Phase 1 of IPC refactor)
  | 'sendInteractive'
  // Image upload for card embedding (Issue #2951)
  | 'uploadImage'
  // Temporary chat lifecycle management (Issue #1703)
  | 'listTempChats'
  | 'markChatResponded';

/**
 * IPC request payload types.
 */
export interface IpcRequestPayloads {
  ping: Record<string, never>;
  // Platform-agnostic messaging operations (Issue #1574: Phase 5 of IPC refactor)
  sendMessage: {
    chatId: string;
    text: string;
    threadId?: string;
    /** Mention targets for @mentioning users/bots (Issue #1742) */
    mentions?: Array<{ openId: string; name?: string }>;
  };
  sendCard: {
    chatId: string;
    card: FeishuCard;
    threadId?: string;
    description?: string;
  };
  uploadFile: {
    chatId: string;
    filePath: string;
    threadId?: string;
  };
  // Raw-param interactive card (Issue #1570)
  sendInteractive: {
    chatId: string;
    question: string;
    options: Array<{
      text: string;
      value: string;
      type?: 'primary' | 'default' | 'danger';
    }>;
    title?: string;
    context?: string;
    threadId?: string;
    actionPrompts?: Record<string, string>;
  };
  // Image upload for card embedding (Issue #2951)
  uploadImage: {
    /** Local file path to the image */
    filePath: string;
  };
  // Temporary chat lifecycle management (Issue #1703)
  listTempChats: Record<string, never>;
  markChatResponded: {
    chatId: string;
    response: {
      selectedValue: string;
      responder: string;
      repliedAt: string;
    };
  };
}

/**
 * IPC response payload types.
 */
export interface IpcResponsePayloads {
  ping: { pong: true };
  // Platform-agnostic messaging operations (Issue #1574: Phase 5 of IPC refactor)
  sendMessage: { success: boolean; messageId?: string };
  sendCard: { success: boolean; messageId?: string };
  uploadFile: {
    success: boolean;
    fileKey?: string;
    fileType?: string;
    fileName?: string;
    fileSize?: number;
    error?: string;
    errorType?: 'ipc_unavailable' | 'ipc_timeout' | 'ipc_request_failed';
  };
  // Raw-param interactive card (Issue #1570)
  sendInteractive: {
    success: boolean;
    messageId?: string;
  };
  // Image upload for card embedding (Issue #2951)
  uploadImage: {
    success: boolean;
    imageKey?: string;
    error?: string;
  };
  // Temporary chat lifecycle management (Issue #1703)
  listTempChats: {
    success: boolean;
    chats?: Array<{
      chatId: string;
      createdAt: string;
      expiresAt: string;
      creatorChatId?: string;
      responded: boolean;
    }>;
  };
  markChatResponded: {
    success: boolean;
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
