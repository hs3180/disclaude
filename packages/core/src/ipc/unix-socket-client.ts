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
import type { FeishuCard } from '../types/platform.js';
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
 * IPC availability status for better error handling.
 */
export type IpcAvailabilityStatus =
  | { available: true }
  | { available: false; reason: 'socket_not_found' | 'connection_failed' | 'timeout' | 'error'; error?: Error };

/**
 * Extract the reason type from IpcAvailabilityStatus (only available when available is false)
 */
export type IpcUnavailableReason = Extract<IpcAvailabilityStatus, { available: false }>['reason'];

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

  // ============================================================================
  // Platform-agnostic messaging operations (Issue #1574: Phase 5 of IPC refactor)
  // ============================================================================

  /**
   * Send a text message via IPC.
   * Issue #1088: Return detailed error information for better troubleshooting.
   */
  async sendMessage(
    chatId: string,
    text: string,
    threadId?: string,
    mentions?: Array<{ openId: string; name?: string }>
  ): Promise<{ success: boolean; messageId?: string; error?: string; errorType?: 'ipc_unavailable' | 'ipc_timeout' | 'ipc_request_failed' }> {
    try {
      return await this.request('sendMessage', { chatId, text, threadId, mentions });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error({ err: error, chatId }, 'sendMessage failed');

      // Determine error type for better error handling
      let errorType: 'ipc_unavailable' | 'ipc_timeout' | 'ipc_request_failed' = 'ipc_request_failed';
      if (err.message.startsWith('IPC_NOT_AVAILABLE')) {
        errorType = 'ipc_unavailable';
      } else if (err.message.startsWith('IPC_TIMEOUT')) {
        errorType = 'ipc_timeout';
      }

      return { success: false, error: err.message, errorType };
    }
  }

  /**
   * Send a card message via IPC.
   * Issue #1088: Return detailed error information for better troubleshooting.
   */
  async sendCard(
    chatId: string,
    card: FeishuCard,
    threadId?: string,
    description?: string
  ): Promise<{ success: boolean; messageId?: string; error?: string; errorType?: 'ipc_unavailable' | 'ipc_timeout' | 'ipc_request_failed' }> {
    try {
      return await this.request('sendCard', { chatId, card, threadId, description });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error({ err: error, chatId }, 'sendCard failed');

      // Determine error type for better error handling
      let errorType: 'ipc_unavailable' | 'ipc_timeout' | 'ipc_request_failed' = 'ipc_request_failed';
      if (err.message.startsWith('IPC_NOT_AVAILABLE')) {
        errorType = 'ipc_unavailable';
      } else if (err.message.startsWith('IPC_TIMEOUT')) {
        errorType = 'ipc_timeout';
      }

      return { success: false, error: err.message, errorType };
    }
  }

  /**
   * Upload a file via IPC.
   */
  async uploadFile(
    chatId: string,
    filePath: string,
    threadId?: string
  ): Promise<{ success: boolean; fileKey?: string; fileType?: string; fileName?: string; fileSize?: number }> {
    try {
      return await this.request('uploadFile', { chatId, filePath, threadId });
    } catch (error) {
      logger.error({ err: error, chatId, filePath }, 'uploadFile failed');
      return { success: false };
    }
  }

  /**
   * Send an interactive card with raw parameters via IPC.
   * Issue #1570: Phase 1 of IPC refactor — Primary Node owns card building.
   *
   * @param chatId - Target chat ID
   * @param params - Raw card parameters (question, options, title, context)
   */
  async sendInteractive(
    chatId: string,
    params: {
      question: string;
      options: Array<{ text: string; value: string; type?: 'primary' | 'default' | 'danger' }>;
      title?: string;
      context?: string;
      threadId?: string;
      actionPrompts?: Record<string, string>;
    }
  ): Promise<{ success: boolean; messageId?: string; error?: string; errorType?: 'ipc_unavailable' | 'ipc_timeout' | 'ipc_request_failed' }> {
    try {
      return await this.request('sendInteractive', { chatId, ...params });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error({ err: error, chatId }, 'sendInteractive failed');

      let errorType: 'ipc_unavailable' | 'ipc_timeout' | 'ipc_request_failed' = 'ipc_request_failed';
      if (err.message.startsWith('IPC_NOT_AVAILABLE')) {
        errorType = 'ipc_unavailable';
      } else if (err.message.startsWith('IPC_TIMEOUT')) {
        errorType = 'ipc_timeout';
      }

      return { success: false, error: err.message, errorType };
    }
  }

  // ============================================================================
  // Group management operations (Issue #1546: create_chat / dissolve_chat)
  // ============================================================================

  /**
   * Create a group chat via IPC.
   * Issue #1546: Platform-agnostic group creation.
   *
   * @param name - Group name (optional, platform may auto-generate)
   * @param description - Group description (optional)
   * @param memberIds - Initial member IDs (optional, platform decides ID format)
   */
  async createChat(
    name?: string,
    description?: string,
    memberIds?: string[]
  ): Promise<{ success: boolean; chatId?: string; name?: string; error?: string; errorType?: 'ipc_unavailable' | 'ipc_timeout' | 'ipc_request_failed' }> {
    try {
      return await this.request('createChat', { name, description, memberIds });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error({ err: error }, 'createChat failed');

      let errorType: 'ipc_unavailable' | 'ipc_timeout' | 'ipc_request_failed' = 'ipc_request_failed';
      if (err.message.startsWith('IPC_NOT_AVAILABLE')) {
        errorType = 'ipc_unavailable';
      } else if (err.message.startsWith('IPC_TIMEOUT')) {
        errorType = 'ipc_timeout';
      }

      return { success: false, error: err.message, errorType };
    }
  }

  /**
   * Dissolve a group chat via IPC.
   * Issue #1546: Platform-agnostic group dissolution.
   *
   * @param chatId - Chat ID to dissolve
   */
  async dissolveChat(
    chatId: string
  ): Promise<{ success: boolean; error?: string; errorType?: 'ipc_unavailable' | 'ipc_timeout' | 'ipc_request_failed' }> {
    try {
      return await this.request('dissolveChat', { chatId });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error({ err: error, chatId }, 'dissolveChat failed');

      let errorType: 'ipc_unavailable' | 'ipc_timeout' | 'ipc_request_failed' = 'ipc_request_failed';
      if (err.message.startsWith('IPC_NOT_AVAILABLE')) {
        errorType = 'ipc_unavailable';
      } else if (err.message.startsWith('IPC_TIMEOUT')) {
        errorType = 'ipc_timeout';
      }

      return { success: false, error: err.message, errorType };
    }
  }

  // ============================================================================
  // Temporary chat lifecycle management (Issue #1703)
  // ============================================================================

  /**
   * Register a temporary chat for lifecycle tracking via IPC.
   * Issue #1703: Temp chat lifecycle management.
   *
   * @param chatId - The chat ID to track
   * @param expiresAt - Optional ISO timestamp for expiry (defaults to 24h)
   * @param creatorChatId - Optional originating chat ID
   * @param context - Optional arbitrary context data
   */
  async registerTempChat(
    chatId: string,
    expiresAt?: string,
    creatorChatId?: string,
    context?: Record<string, unknown>
  ): Promise<{ success: boolean; chatId?: string; expiresAt?: string; error?: string; errorType?: 'ipc_unavailable' | 'ipc_timeout' | 'ipc_request_failed' }> {
    try {
      return await this.request('registerTempChat', { chatId, expiresAt, creatorChatId, context });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error({ err: error, chatId }, 'registerTempChat failed');

      let errorType: 'ipc_unavailable' | 'ipc_timeout' | 'ipc_request_failed' = 'ipc_request_failed';
      if (err.message.startsWith('IPC_NOT_AVAILABLE')) {
        errorType = 'ipc_unavailable';
      } else if (err.message.startsWith('IPC_TIMEOUT')) {
        errorType = 'ipc_timeout';
      }

      return { success: false, error: err.message, errorType };
    }
  }

  /**
   * List all tracked temporary chats via IPC.
   * Issue #1703: Temp chat lifecycle management.
   */
  async listTempChats(): Promise<{ success: boolean; chats?: Array<{ chatId: string; createdAt: string; expiresAt: string; creatorChatId?: string; responded: boolean }>; error?: string; errorType?: 'ipc_unavailable' | 'ipc_timeout' | 'ipc_request_failed' }> {
    try {
      return await this.request('listTempChats', {});
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error({ err: error }, 'listTempChats failed');

      let errorType: 'ipc_unavailable' | 'ipc_timeout' | 'ipc_request_failed' = 'ipc_request_failed';
      if (err.message.startsWith('IPC_NOT_AVAILABLE')) {
        errorType = 'ipc_unavailable';
      } else if (err.message.startsWith('IPC_TIMEOUT')) {
        errorType = 'ipc_timeout';
      }

      return { success: false, error: err.message, errorType };
    }
  }

  /**
   * Mark a temporary chat as responded by a user via IPC.
   * Issue #1703: Temp chat lifecycle management.
   *
   * @param chatId - The chat ID to update
   * @param response - The user response data
   */
  async markChatResponded(
    chatId: string,
    response: { selectedValue: string; responder: string; repliedAt: string }
  ): Promise<{ success: boolean; error?: string; errorType?: 'ipc_unavailable' | 'ipc_timeout' | 'ipc_request_failed' }> {
    try {
      return await this.request('markChatResponded', { chatId, response });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error({ err: error, chatId }, 'markChatResponded failed');

      let errorType: 'ipc_unavailable' | 'ipc_timeout' | 'ipc_request_failed' = 'ipc_request_failed';
      if (err.message.startsWith('IPC_NOT_AVAILABLE')) {
        errorType = 'ipc_unavailable';
      } else if (err.message.startsWith('IPC_TIMEOUT')) {
        errorType = 'ipc_timeout';
      }

      return { success: false, error: err.message, errorType };
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
 * Get IPC socket path with fallback chain.
 *
 * Priority:
 * 1. DISCLAUDE_WORKER_IPC_SOCKET env var (set by Worker Node for MCP Server)
 * 2. DISCLAUDE_IPC_SOCKET_PATH env var (manual override)
 * 3. DEFAULT_IPC_CONFIG.socketPath (Primary Node default)
 */
export function getIpcSocketPath(): string {
  return (
    process.env.DISCLAUDE_WORKER_IPC_SOCKET ||
    process.env.DISCLAUDE_IPC_SOCKET_PATH ||
    DEFAULT_IPC_CONFIG.socketPath
  );
}

/**
 * Get the global IPC client instance.
 *
 * Issue #1042: Uses socket path from environment variable if set.
 * Priority: DISCLAUDE_WORKER_IPC_SOCKET > DISCLAUDE_IPC_SOCKET_PATH > default
 */
export function getIpcClient(): UnixSocketIpcClient {
  if (!ipcClientInstance) {
    const socketPath = getIpcSocketPath();
    ipcClientInstance = new UnixSocketIpcClient({ socketPath });
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
