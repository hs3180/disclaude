/**
 * Unix Socket IPC Client for cross-process communication.
 *
 * Provides a Unix domain socket client that connects to the IPC server
 * to query interactive contexts from the MCP process.
 *
 * @module ipc/unix-socket-client
 */

import { existsSync } from 'fs';
import { createConnection, type Socket } from 'net';
import { createLogger } from '../utils/logger.js';
import {
  DEFAULT_IPC_CONFIG,
  type IpcConfig,
  type IpcRequest,
  type IpcRequestPayloads,
  type IpcRequestType,
  type IpcResponse,
  type IpcResponsePayloads,
} from './protocol.js';

const logger = createLogger('IpcClient');

/**
 * Pending request tracker.
 */
interface PendingRequest {
  resolve: (response: IpcResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * Unix Socket IPC Client.
 */
export class UnixSocketIpcClient {
  private socketPath: string;
  private timeout: number;
  private socket: Socket | null = null;
  private connected = false;
  private connecting = false;
  private buffer = '';
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private requestId = 0;

  constructor(config?: Partial<IpcConfig>) {
    this.socketPath = config?.socketPath ?? DEFAULT_IPC_CONFIG.socketPath;
    this.timeout = config?.timeout ?? DEFAULT_IPC_CONFIG.timeout;
  }

  /**
   * Connect to the IPC server.
   */
  // eslint-disable-next-line require-await
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    if (this.connecting) {
      // Wait for existing connection attempt
      return new Promise((resolve, reject) => {
        const checkConnected = () => {
          if (this.connected) {
            resolve();
          } else if (!this.connecting) {
            reject(new Error('Connection failed'));
          } else {
            setTimeout(checkConnected, 50);
          }
        };
        checkConnected();
      });
    }

    // Check if socket file exists
    if (!existsSync(this.socketPath)) {
      throw new Error(`Socket file not found: ${this.socketPath}`);
    }

    this.connecting = true;

    return new Promise((resolve, reject) => {
      this.socket = createConnection(this.socketPath);

      const timeoutId = setTimeout(() => {
        this.socket?.destroy();
        this.connecting = false;
        reject(new Error('Connection timeout'));
      }, this.timeout);

      this.socket.on('connect', () => {
        clearTimeout(timeoutId);
        this.connected = true;
        this.connecting = false;
        logger.debug({ path: this.socketPath }, 'Connected to IPC server');
        resolve();
      });

      this.socket.on('error', (error) => {
        clearTimeout(timeoutId);
        this.connecting = false;
        logger.debug({ err: error }, 'IPC connection error');
        reject(error);
      });

      this.socket.on('data', (data) => {
        this.handleData(data.toString());
      });

      this.socket.on('close', () => {
        this.connected = false;
        this.connecting = false;
        this.socket = null;
        logger.debug('IPC connection closed');

        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests) {
          clearTimeout(pending.timeout);
          pending.reject(new Error('Connection closed'));
          this.pendingRequests.delete(id);
        }
      });
    });
  }

  /**
   * Disconnect from the IPC server.
   */
  // eslint-disable-next-line require-await
  async disconnect(): Promise<void> {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.connecting = false;
    this.buffer = '';
    this.pendingRequests.clear();
    logger.debug('Disconnected from IPC server');
  }

  /**
   * Check if connected to the IPC server.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Send a request and wait for response.
   */
  async request<T extends IpcRequestType>(
    type: T,
    payload: IpcRequestPayloads[T]
  ): Promise<IpcResponsePayloads[T]> {
    if (!this.connected) {
      await this.connect();
    }

    const id = `${++this.requestId}`;
    const request: IpcRequest<T> = { type, id, payload };

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${type}`));
      }, this.timeout);

      this.pendingRequests.set(id, {
        resolve: (response) => {
          clearTimeout(timeoutId);
          if (response.success) {
            resolve(response.payload as IpcResponsePayloads[T]);
          } else {
            reject(new Error(response.error ?? 'Unknown error'));
          }
        },
        reject,
        timeout: timeoutId,
      });

      try {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this.socket!.write(`${JSON.stringify(request)}\n`);
      } catch (error) {
        this.pendingRequests.delete(id);
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  }

  /**
   * Ping the server.
   */
  async ping(): Promise<boolean> {
    try {
      const response = await this.request('ping', {});
      return response.pong === true;
    } catch {
      return false;
    }
  }

  /**
   * Get action prompts for a message.
   */
  async getActionPrompts(messageId: string): Promise<Record<string, string> | null> {
    try {
      const response = await this.request('getActionPrompts', { messageId });
      return response.prompts;
    } catch {
      return null;
    }
  }

  /**
   * Generate interaction prompt via IPC.
   */
  async generateInteractionPrompt(
    messageId: string,
    actionValue: string,
    actionText?: string,
    actionType?: string,
    formData?: Record<string, unknown>
  ): Promise<string | null> {
    try {
      const response = await this.request('generateInteractionPrompt', {
        messageId,
        actionValue,
        actionText,
        actionType,
        formData,
      });
      return response.prompt;
    } catch {
      return null;
    }
  }

  // ============================================================================
  // Feishu API Operations (Issue #1035)
  // ============================================================================

  /**
   * Send a text message via IPC.
   */
  async feishuSendMessage(
    chatId: string,
    text: string,
    threadId?: string
  ): Promise<{ success: boolean; messageId?: string }> {
    try {
      return await this.request('feishuSendMessage', { chatId, text, threadId });
    } catch (error) {
      logger.error({ err: error, chatId }, 'feishuSendMessage failed');
      return { success: false };
    }
  }

  /**
   * Send a card message via IPC.
   */
  async feishuSendCard(
    chatId: string,
    card: Record<string, unknown>,
    threadId?: string,
    description?: string
  ): Promise<{ success: boolean; messageId?: string }> {
    try {
      return await this.request('feishuSendCard', { chatId, card, threadId, description });
    } catch (error) {
      logger.error({ err: error, chatId }, 'feishuSendCard failed');
      return { success: false };
    }
  }

  /**
   * Upload a file via IPC.
   */
  async feishuUploadFile(
    chatId: string,
    filePath: string,
    threadId?: string
  ): Promise<{ success: boolean; fileKey?: string; fileType?: string; fileName?: string; fileSize?: number }> {
    try {
      return await this.request('feishuUploadFile', { chatId, filePath, threadId });
    } catch (error) {
      logger.error({ err: error, chatId, filePath }, 'feishuUploadFile failed');
      return { success: false };
    }
  }

  /**
   * Get bot info via IPC.
   */
  async feishuGetBotInfo(): Promise<{ openId: string; name?: string; avatarUrl?: string } | null> {
    try {
      return await this.request('feishuGetBotInfo', {});
    } catch (error) {
      logger.error({ err: error }, 'feishuGetBotInfo failed');
      return null;
    }
  }

  /**
   * Handle incoming data.
   */
  private handleData(data: string): void {
    this.buffer += data;

    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.trim()) {
        try {
          const response: IpcResponse = JSON.parse(line);
          const pending = this.pendingRequests.get(response.id);
          if (pending) {
            this.pendingRequests.delete(response.id);
            pending.resolve(response);
          }
        } catch (error) {
          logger.debug({ err: error, line }, 'Failed to parse IPC response');
        }
      }
    }
  }
}

// Singleton instance
let ipcClientInstance: UnixSocketIpcClient | null = null;

/**
 * Get the global IPC client instance.
 */
export function getIpcClient(): UnixSocketIpcClient {
  if (!ipcClientInstance) {
    ipcClientInstance = new UnixSocketIpcClient();
  }
  return ipcClientInstance;
}

/**
 * Reset the global IPC client (for testing).
 */
export function resetIpcClient(): void {
  if (ipcClientInstance) {
    ipcClientInstance.disconnect().catch(() => {});
  }
  ipcClientInstance = null;
}
