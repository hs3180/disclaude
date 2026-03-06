/**
 * Unix Socket IPC Client for cross-process communication.
 *
 * Provides a Unix domain socket client that allows the main process
 * to query the interactive contexts stored in the MCP process.
 *
 * @module ipc/unix-socket-client
 */

import { createConnection, type Socket } from 'net';
import { createLogger } from '../utils/logger.js';
import type {
  IpcRequest,
  IpcResponse,
  IpcRequestType,
  IpcRequestPayloads,
  IpcResponseResults,
  IpcConfig,
} from './protocol.js';

const logger = createLogger('IpcClient');

/**
 * Pending request tracker
 */
interface PendingRequest {
  resolve: (response: IpcResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Unix Socket IPC Client
 */
export class UnixSocketIpcClient {
  private socketPath: string;
  private timeout: number;
  private socket: Socket | null = null;
  private buffer = '';
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private isConnecting = false;

  constructor(config?: Partial<IpcConfig>) {
    this.socketPath = config?.socketPath ?? '/tmp/disclaude-interactive.ipc';
    this.timeout = config?.timeout ?? 5000;
  }

  /**
   * Connect to the IPC server
   */
  async connect(): Promise<void> {
    if (this.socket?.writable) {
      return;
    }

    if (this.isConnecting) {
      // Wait for existing connection attempt
      return new Promise((resolve, reject) => {
        const checkInterval = setInterval(() => {
          if (this.socket?.writable) {
            clearInterval(checkInterval);
            resolve();
          } else if (!this.isConnecting) {
            clearInterval(checkInterval);
            reject(new Error('Connection failed'));
          }
        }, 50);
      });
    }

    this.isConnecting = true;

    return new Promise((resolve, reject) => {
      try {
        this.socket = createConnection(this.socketPath, () => {
          this.isConnecting = false;
          logger.debug({ path: this.socketPath }, 'IPC client connected');
          resolve();
        });

        this.socket.on('data', (data) => {
          this.handleData(data.toString());
        });

        this.socket.on('error', (error) => {
          this.isConnecting = false;
          logger.debug({ err: error }, 'IPC client connection error');
          reject(error);
        });

        this.socket.on('close', () => {
          this.socket = null;
          this.isConnecting = false;
          logger.debug('IPC client disconnected');
        });
      } catch (error) {
        this.isConnecting = false;
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the IPC server
   */
  async disconnect(): Promise<void> {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    // Reject all pending requests
    for (const [_id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Disconnected'));
    }
    this.pendingRequests.clear();
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.socket?.writable ?? false;
  }

  /**
   * Send a request and wait for response
   */
  async sendRequest<T extends IpcRequestType>(
    type: T,
    payload: IpcRequestPayloads[T]
  ): Promise<IpcResponseResults[T]> {
    // Ensure connected
    if (!this.isConnected()) {
      await this.connect();
    }

    const id = this.generateRequestId();
    const request: IpcRequest<T> = { type, id, payload };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${type}`));
      }, this.timeout);

      this.pendingRequests.set(id, {
        resolve: (response: IpcResponse) => {
          if (response.success && response.result !== undefined) {
            resolve(response.result as IpcResponseResults[T]);
          } else {
            reject(new Error(response.error ?? 'Request failed'));
          }
        },
        reject,
        timeout,
      });

      try {
        this.socket!.write(JSON.stringify(request) + '\n');
      } catch (error) {
        this.pendingRequests.delete(id);
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  /**
   * Generate interaction prompt via IPC
   */
  async generateInteractionPrompt(
    messageId: string,
    actionValue: string,
    actionText?: string,
    actionType?: string,
    formData?: Record<string, unknown>
  ): Promise<string | undefined> {
    try {
      const result = await this.sendRequest('generate_interaction_prompt', {
        messageId,
        actionValue,
        actionText,
        actionType,
        formData,
      });
      return result.prompt ?? undefined;
    } catch (error) {
      logger.debug({ err: error, messageId }, 'Failed to generate prompt via IPC');
      return undefined;
    }
  }

  /**
   * Get action prompts via IPC
   */
  async getActionPrompts(messageId: string): Promise<Record<string, string> | undefined> {
    try {
      const result = await this.sendRequest('get_action_prompts', { messageId });
      return result.prompts ?? undefined;
    } catch (error) {
      logger.debug({ err: error, messageId }, 'Failed to get prompts via IPC');
      return undefined;
    }
  }

  /**
   * Ping the server to check connectivity
   */
  async ping(): Promise<boolean> {
    try {
      const result = await this.sendRequest('ping', {});
      return result.pong;
    } catch {
      return false;
    }
  }

  /**
   * Handle incoming data
   */
  private handleData(data: string): void {
    this.buffer += data;

    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.trim()) {
        this.handleResponse(line);
      }
    }
  }

  /**
   * Handle an incoming response
   */
  private handleResponse(data: string): void {
    let response: IpcResponse;

    try {
      response = JSON.parse(data);
    } catch {
      logger.debug({ data }, 'Invalid IPC response JSON');
      return;
    }

    const pending = this.pendingRequests.get(response.id);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(response.id);
      pending.resolve(response);
    } else {
      logger.debug({ id: response.id }, 'Received response for unknown request');
    }
  }

  /**
   * Generate a unique request ID
   */
  private generateRequestId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}

// Singleton instance for convenience
let clientInstance: UnixSocketIpcClient | null = null;

/**
 * Get the singleton IPC client instance
 */
export function getIpcClient(config?: Partial<IpcConfig>): UnixSocketIpcClient {
  if (!clientInstance) {
    clientInstance = new UnixSocketIpcClient(config);
  }
  return clientInstance;
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetIpcClient(): void {
  if (clientInstance) {
    clientInstance.disconnect().catch(() => {});
    clientInstance = null;
  }
}
