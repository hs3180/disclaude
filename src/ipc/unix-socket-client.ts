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
 * IPC unavailable reason types.
 */
export type IpcUnavailableReason = 'socket_not_found' | 'connection_failed' | 'timeout' | 'error';

/**
 * IPC availability status for better error handling.
 */
export type IpcAvailabilityStatus =
  | { available: true }
  | { available: false; reason: IpcUnavailableReason; error?: Error };

/**
 * Unix Socket IPC Client.
 */
export class UnixSocketIpcClient {
  private socketPath: string;
  private timeout: number;
  private maxRetries: number;
  private socket: Socket | null = null;
  private connected = false;
  private connecting = false;
  private buffer = '';
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private requestId = 0;
  private availabilityCache: IpcAvailabilityStatus | null = null;
  private availabilityCacheTime = 0;
  private readonly availabilityCacheTtl = 5000; // 5 seconds TTL for availability cache

  constructor(config?: Partial<IpcConfig>) {
    this.socketPath = config?.socketPath ?? DEFAULT_IPC_CONFIG.socketPath;
    this.timeout = config?.timeout ?? DEFAULT_IPC_CONFIG.timeout;
    this.maxRetries = config?.maxRetries ?? DEFAULT_IPC_CONFIG.maxRetries;
  }

  /**
   * Connect to the IPC server with retry support.
   */
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

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      // Check if socket file exists on each attempt
      if (!existsSync(this.socketPath)) {
        lastError = new Error(`IPC socket not available: ${this.socketPath}`);
        logger.debug({
          attempt,
          maxRetries: this.maxRetries,
          socketPath: this.socketPath,
        }, 'IPC socket file not found');

        if (attempt < this.maxRetries) {
          // Exponential backoff: 100ms, 200ms, 400ms...
          const delay = Math.min(100 * Math.pow(2, attempt - 1), 1000);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        break;
      }

      try {
        await this.doConnect(attempt);
        return; // Success
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.debug({
          attempt,
          maxRetries: this.maxRetries,
          err: lastError,
        }, 'IPC connection attempt failed');

        if (attempt < this.maxRetries) {
          // Exponential backoff: 100ms, 200ms, 400ms...
          const delay = Math.min(100 * Math.pow(2, attempt - 1), 1000);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError ?? new Error('IPC connection failed after retries');
  }

  /**
   * Internal connection logic (single attempt).
   */
  private doConnect(attempt: number): Promise<void> {
    this.connecting = true;

    return new Promise((resolve, reject) => {
      this.socket = createConnection(this.socketPath);

      const timeoutId = setTimeout(() => {
        this.socket?.destroy();
        this.connecting = false;
        reject(new Error(`IPC connection timeout (attempt ${attempt})`));
      }, this.timeout);

      this.socket.on('connect', () => {
        clearTimeout(timeoutId);
        this.connected = true;
        this.connecting = false;
        this.availabilityCache = { available: true };
        this.availabilityCacheTime = Date.now();
        logger.debug({ path: this.socketPath, attempt }, 'Connected to IPC server');
        resolve();
      });

      this.socket.on('error', (error) => {
        clearTimeout(timeoutId);
        this.connecting = false;
        logger.debug({ err: error, attempt }, 'IPC connection error');
        reject(error);
      });

      this.socket.on('data', (data) => {
        this.handleData(data.toString());
      });

      this.socket.on('close', () => {
        this.connected = false;
        this.connecting = false;
        this.socket = null;
        this.availabilityCache = null; // Invalidate cache on disconnect
        logger.debug('IPC connection closed');

        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests) {
          clearTimeout(pending.timeout);
          pending.reject(new Error('IPC connection closed'));
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
   * Check if IPC is available (with caching).
   *
   * This method performs a lightweight check to determine if IPC is available,
   * caching the result for a short period to avoid repeated checks.
   *
   * @returns Availability status with reason if unavailable
   */
  async checkAvailability(): Promise<IpcAvailabilityStatus> {
    // Return cached result if still valid
    const now = Date.now();
    if (this.availabilityCache && (now - this.availabilityCacheTime) < this.availabilityCacheTtl) {
      return this.availabilityCache;
    }

    // If already connected, it's available
    if (this.connected) {
      this.availabilityCache = { available: true };
      this.availabilityCacheTime = now;
      return this.availabilityCache;
    }

    // Check if socket file exists
    if (!existsSync(this.socketPath)) {
      this.availabilityCache = {
        available: false,
        reason: 'socket_not_found',
      };
      this.availabilityCacheTime = now;
      return this.availabilityCache;
    }

    // Try to connect
    try {
      await this.connect();
      this.availabilityCache = { available: true };
      this.availabilityCacheTime = now;
      return this.availabilityCache;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      let reason: IpcUnavailableReason = 'connection_failed';

      if (err.message.includes('timeout')) {
        reason = 'timeout';
      } else if (err.message.includes('not available')) {
        reason = 'socket_not_found';
      }

      this.availabilityCache = {
        available: false,
        reason,
        error: err,
      };
      this.availabilityCacheTime = now;

      logger.debug({
        reason,
        err: err.message,
        socketPath: this.socketPath,
      }, 'IPC availability check failed');

      return this.availabilityCache;
    }
  }

  /**
   * Quick check if IPC is available (non-blocking, uses cache).
   *
   * @returns true if IPC is believed to be available based on cache
   */
  isAvailable(): boolean {
    // If connected, it's available
    if (this.connected) {
      return true;
    }

    // Check cache
    const now = Date.now();
    if (this.availabilityCache && (now - this.availabilityCacheTime) < this.availabilityCacheTtl) {
      return this.availabilityCache.available;
    }

    // Check if socket file exists (quick check without connection)
    return existsSync(this.socketPath);
  }

  /**
   * Invalidate the availability cache.
   */
  invalidateAvailabilityCache(): void {
    this.availabilityCache = null;
  }

  /**
   * Send a request and wait for response.
   *
   * @throws Error with distinguishing message prefixes:
   *   - 'IPC_NOT_AVAILABLE:' - IPC server is not reachable
   *   - 'IPC_REQUEST_FAILED:' - Request was sent but failed
   *   - 'IPC_TIMEOUT:' - Request timed out
   */
  async request<T extends IpcRequestType>(
    type: T,
    payload: IpcRequestPayloads[T]
  ): Promise<IpcResponsePayloads[T]> {
    if (!this.connected) {
      try {
        await this.connect();
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        // Mark as IPC not available
        const enhancedError = new Error(`IPC_NOT_AVAILABLE: ${err.message}`);
        enhancedError.cause = err;
        throw enhancedError;
      }
    }

    const id = `${++this.requestId}`;
    const request: IpcRequest<T> = { type, id, payload };

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        const error = new Error(`IPC_TIMEOUT: Request timed out: ${type}`);
        reject(error);
      }, this.timeout);

      this.pendingRequests.set(id, {
        resolve: (response) => {
          clearTimeout(timeoutId);
          if (response.success) {
            resolve(response.payload as IpcResponsePayloads[T]);
          } else {
            const error = new Error(`IPC_REQUEST_FAILED: ${response.error ?? 'Unknown error'}`);
            reject(error);
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
        const err = error instanceof Error ? error : new Error(String(error));
        const enhancedError = new Error(`IPC_REQUEST_FAILED: ${err.message}`);
        enhancedError.cause = err;
        reject(enhancedError);
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
