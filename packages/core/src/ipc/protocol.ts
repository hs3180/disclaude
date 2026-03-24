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
 *
 * Issue #1574 (Phase 5): Platform-agnostic naming — removed `feishu*` prefixes.
 * IPC types are now platform-independent, consistent with MCP tool layer naming.
 * State management (removed in Phase 4) lived in Primary Node's InteractiveContextStore.
 */
export type IpcRequestType =
  | 'ping'
  // Platform API operations (Issue #1035, renamed in Issue #1574)
  | 'sendMessage'
  | 'sendCard'
  | 'uploadFile'
  | 'getBotInfo'
  // Raw parameter forwarding (Issue #1570: Phase 1)
  | 'sendInteractive';

/**
 * IPC request payload types.
 */
export interface IpcRequestPayloads {
  ping: Record<string, never>;
  // Platform API operations (Issue #1035, renamed in Issue #1574)
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
  getBotInfo: Record<string, never>;
  // Raw parameter forwarding (Issue #1570: Phase 1)
  sendInteractive: {
    chatId: string;
    question: string;
    options: Array<{
      text: string;
      value?: string;
      style?: 'primary' | 'default' | 'danger';
      action?: string;
    }>;
    title?: string;
    context?: string;
    threadId?: string;
  };
}

/**
 * IPC response payload types.
 */
export interface IpcResponsePayloads {
  ping: { pong: true };
  // Platform API operations (Issue #1035, renamed in Issue #1574)
  sendMessage: { success: boolean; messageId?: string };
  sendCard: { success: boolean; messageId?: string };
  uploadFile: {
    success: boolean;
    fileKey?: string;
    fileType?: string;
    fileName?: string;
    fileSize?: number;
  };
  getBotInfo: {
    openId: string;
    name?: string;
    avatarUrl?: string;
  };
  // Raw parameter forwarding (Issue #1570: Phase 1)
  sendInteractive: {
    success: boolean;
    messageId?: string;
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
