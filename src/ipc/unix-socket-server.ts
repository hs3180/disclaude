/**
 * Unix Socket IPC Server for cross-process communication.
 *
 * Provides a Unix domain socket server that allows other processes
 * to query the interactive contexts stored in this process.
 *
 * @module ipc/unix-socket-server
 */

import { createServer, type Socket, type Server } from 'net';
import { unlinkSync, existsSync } from 'fs';
import { createLogger } from '../utils/logger.js';
import type {
  IpcRequest,
  IpcResponse,
  IpcConfig,
  IpcRequestPayloads,
} from './protocol.js';

const logger = createLogger('IpcServer');

/**
 * Handler function type for processing IPC requests
 */
export type IpcRequestHandler = (request: IpcRequest) => Promise<IpcResponse>;

/**
 * Unix Socket IPC Server
 */
export class UnixSocketIpcServer {
  private server: Server | null = null;
  private socketPath: string;
  private handler: IpcRequestHandler;
  private activeConnections: Set<Socket> = new Set();
  private isShuttingDown = false;

  constructor(handler: IpcRequestHandler, config?: Partial<IpcConfig>) {
    this.socketPath = config?.socketPath ?? '/tmp/disclaude-interactive.ipc';
    this.handler = handler;
  }

  /**
   * Start the IPC server
   */
  async start(): Promise<void> {
    if (this.server) {
      logger.warn('IPC server already running');
      return;
    }

    // Clean up existing socket file
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
        logger.debug({ path: this.socketPath }, 'Removed existing socket file');
      } catch (error) {
        logger.warn({ err: error, path: this.socketPath }, 'Failed to remove existing socket file');
      }
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (error) => {
        logger.error({ err: error }, 'IPC server error');
        if (!this.server!.listening) {
          reject(error);
        }
      });

      this.server.listen(this.socketPath, () => {
        logger.info({ path: this.socketPath }, 'IPC server started');
        resolve();
      });
    });
  }

  /**
   * Stop the IPC server
   */
  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    this.isShuttingDown = true;

    // Close all active connections
    for (const socket of this.activeConnections) {
      try {
        socket.destroy();
      } catch {
        // Ignore errors during shutdown
      }
    }
    this.activeConnections.clear();

    return new Promise((resolve) => {
      this.server!.close(() => {
        // Clean up socket file
        if (existsSync(this.socketPath)) {
          try {
            unlinkSync(this.socketPath);
            logger.debug({ path: this.socketPath }, 'Removed socket file on shutdown');
          } catch {
            // Ignore errors during cleanup
          }
        }
        this.server = null;
        this.isShuttingDown = false;
        logger.info('IPC server stopped');
        resolve();
      });
    });
  }

  /**
   * Get the socket path
   */
  getSocketPath(): string {
    return this.socketPath;
  }

  /**
   * Check if the server is running
   */
  isRunning(): boolean {
    return this.server?.listening ?? false;
  }

  /**
   * Handle a new connection
   */
  private handleConnection(socket: Socket): void {
    if (this.isShuttingDown) {
      socket.destroy();
      return;
    }

    this.activeConnections.add(socket);
    logger.debug({ remoteAddress: socket.remoteAddress }, 'New IPC connection');

    let buffer = '';

    socket.on('data', (data) => {
      buffer += data.toString();

      // Try to parse complete messages (newline-delimited JSON)
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.trim()) {
          this.handleMessage(socket, line);
        }
      }
    });

    socket.on('error', (error) => {
      logger.debug({ err: error }, 'Socket error');
    });

    socket.on('close', () => {
      this.activeConnections.delete(socket);
      logger.debug('IPC connection closed');
    });
  }

  /**
   * Handle an incoming message
   */
  private async handleMessage(socket: Socket, data: string): Promise<void> {
    let request: IpcRequest;
    let response: IpcResponse;

    try {
      request = JSON.parse(data);
    } catch {
      response = {
        id: 'unknown',
        success: false,
        error: 'Invalid JSON',
      };
      this.sendResponse(socket, response);
      return;
    }

    try {
      response = await this.handler(request);
    } catch (error) {
      logger.error({ err: error, requestId: request.id }, 'Handler error');
      response = {
        id: request.id,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }

    this.sendResponse(socket, response);
  }

  /**
   * Send a response to the client
   */
  private sendResponse(socket: Socket, response: IpcResponse): void {
    try {
      socket.write(JSON.stringify(response) + '\n');
    } catch (error) {
      logger.debug({ err: error }, 'Failed to send response');
    }
  }
}

/**
 * Create an IPC request handler for interactive message contexts
 */
export function createInteractiveMessageHandler(
  getActionPrompts: (messageId: string) => Record<string, string> | undefined,
  registerActionPrompts: (messageId: string, chatId: string, actionPrompts: Record<string, string>) => void,
  unregisterActionPrompts: (messageId: string) => boolean,
  generateInteractionPrompt: (
    messageId: string,
    actionValue: string,
    actionText?: string,
    actionType?: string,
    formData?: Record<string, unknown>
  ) => string | undefined,
  cleanupExpiredContexts: () => number
): IpcRequestHandler {
  return async (request: IpcRequest): Promise<IpcResponse> => {
    switch (request.type) {
      case 'get_action_prompts': {
        const payload = request.payload as IpcRequestPayloads['get_action_prompts'];
        const prompts = getActionPrompts(payload.messageId);
        return {
          id: request.id,
          success: true,
          result: { prompts: prompts ?? null },
        };
      }

      case 'register_action_prompts': {
        const payload = request.payload as IpcRequestPayloads['register_action_prompts'];
        registerActionPrompts(
          payload.messageId,
          payload.chatId,
          payload.actionPrompts
        );
        return {
          id: request.id,
          success: true,
          result: { success: true },
        };
      }

      case 'unregister_action_prompts': {
        const payload = request.payload as IpcRequestPayloads['unregister_action_prompts'];
        const success = unregisterActionPrompts(payload.messageId);
        return {
          id: request.id,
          success: true,
          result: { success },
        };
      }

      case 'generate_interaction_prompt': {
        const payload = request.payload as IpcRequestPayloads['generate_interaction_prompt'];
        const prompt = generateInteractionPrompt(
          payload.messageId,
          payload.actionValue,
          payload.actionText,
          payload.actionType,
          payload.formData
        );
        return {
          id: request.id,
          success: true,
          result: { prompt: prompt ?? null },
        };
      }

      case 'cleanup_expired_contexts': {
        const cleaned = cleanupExpiredContexts();
        return {
          id: request.id,
          success: true,
          result: { cleaned },
        };
      }

      case 'ping': {
        return {
          id: request.id,
          success: true,
          result: { pong: true },
        };
      }

      default:
        return {
          id: request.id,
          success: false,
          error: `Unknown request type: ${(request as { type: string }).type}`,
        };
    }
  };
}
