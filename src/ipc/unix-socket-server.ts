/**
 * Unix Socket IPC Server for cross-process communication.
 *
 * Provides a Unix domain socket server that allows other processes
 * to query the interactive contexts stored in this process.
 *
 * @module ipc/unix-socket-server
 */

import { unlinkSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createServer, type Server, type Socket } from 'net';
import { createLogger } from '../utils/logger.js';
import {
  DEFAULT_IPC_CONFIG,
  type IpcConfig,
  type IpcRequest,
  type IpcRequestPayloads,
  type IpcResponse,
} from './protocol.js';

const logger = createLogger('IpcServer');

/**
 * Handler function type for processing IPC requests.
 */
export type IpcRequestHandler = (request: IpcRequest) => Promise<IpcResponse>;

/**
 * Handler functions for interactive message operations.
 */
export interface InteractiveMessageHandlers {
  getActionPrompts: (messageId: string) => Record<string, string> | undefined;
  registerActionPrompts: (
    messageId: string,
    chatId: string,
    actionPrompts: Record<string, string>
  ) => void;
  unregisterActionPrompts: (messageId: string) => boolean;
  generateInteractionPrompt: (
    messageId: string,
    actionValue: string,
    actionText?: string,
    actionType?: string,
    formData?: Record<string, unknown>
  ) => string | undefined;
  cleanupExpiredContexts: () => number;
}

/**
 * Handler functions for Feishu API operations (Issue #1035).
 */
export interface FeishuApiHandlers {
  sendMessage: (chatId: string, text: string, threadId?: string) => Promise<void>;
  sendCard: (
    chatId: string,
    card: Record<string, unknown>,
    threadId?: string,
    description?: string
  ) => Promise<void>;
  uploadFile: (
    chatId: string,
    filePath: string,
    threadId?: string
  ) => Promise<{ fileKey: string; fileType: string; fileName: string; fileSize: number }>;
  getBotInfo: () => Promise<{ openId: string; name?: string; avatarUrl?: string }>;
}

/**
 * Mutable container for Feishu API handlers.
 * Issue #1120: Allows dynamic registration of handlers after IPC server starts.
 */
export interface FeishuHandlersContainer {
  handlers: FeishuApiHandlers | undefined;
}

/**
 * Create an IPC request handler from interactive message handlers.
 * Issue #1120: Uses FeishuHandlersContainer for dynamic handler registration.
 */
export function createInteractiveMessageHandler(
  handlers: InteractiveMessageHandlers,
  feishuHandlersContainer?: FeishuHandlersContainer
): IpcRequestHandler {
  // eslint-disable-next-line require-await
  return async (request: IpcRequest): Promise<IpcResponse> => {
    try {
      switch (request.type) {
        case 'ping':
          return { id: request.id, success: true, payload: { pong: true } };

        case 'getActionPrompts': {
          const { messageId } = request.payload as IpcRequestPayloads['getActionPrompts'];
          const prompts = handlers.getActionPrompts(messageId);
          return {
            id: request.id,
            success: true,
            payload: { prompts: prompts ?? null },
          };
        }

        case 'registerActionPrompts': {
          const { messageId, chatId, actionPrompts } =
            request.payload as IpcRequestPayloads['registerActionPrompts'];
          handlers.registerActionPrompts(messageId, chatId, actionPrompts);
          return { id: request.id, success: true, payload: { success: true } };
        }

        case 'unregisterActionPrompts': {
          const { messageId } = request.payload as IpcRequestPayloads['unregisterActionPrompts'];
          const success = handlers.unregisterActionPrompts(messageId);
          return { id: request.id, success: true, payload: { success } };
        }

        case 'generateInteractionPrompt': {
          const { messageId, actionValue, actionText, actionType, formData } =
            request.payload as IpcRequestPayloads['generateInteractionPrompt'];
          const prompt = handlers.generateInteractionPrompt(
            messageId,
            actionValue,
            actionText,
            actionType,
            formData
          );
          return {
            id: request.id,
            success: true,
            payload: { prompt: prompt ?? null },
          };
        }

        case 'cleanupExpiredContexts': {
          const cleaned = handlers.cleanupExpiredContexts();
          return { id: request.id, success: true, payload: { cleaned } };
        }

        // Feishu API operations (Issue #1035)
        // Issue #1120: Use container for dynamic handler registration
        case 'feishuSendMessage': {
          const feishuHandlers = feishuHandlersContainer?.handlers;
          if (!feishuHandlers) {
            return {
              id: request.id,
              success: false,
              error: 'Feishu API handlers not available',
            };
          }
          const { chatId, text, threadId } =
            request.payload as IpcRequestPayloads['feishuSendMessage'];
          try {
            await feishuHandlers.sendMessage(chatId, text, threadId);
            return { id: request.id, success: true, payload: { success: true } };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return { id: request.id, success: false, error: errorMessage };
          }
        }

        case 'feishuSendCard': {
          const feishuHandlers = feishuHandlersContainer?.handlers;
          if (!feishuHandlers) {
            return {
              id: request.id,
              success: false,
              error: 'Feishu API handlers not available',
            };
          }
          const { chatId, card, threadId, description } =
            request.payload as IpcRequestPayloads['feishuSendCard'];
          try {
            await feishuHandlers.sendCard(chatId, card, threadId, description);
            return { id: request.id, success: true, payload: { success: true } };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return { id: request.id, success: false, error: errorMessage };
          }
        }

        case 'feishuUploadFile': {
          const feishuHandlers = feishuHandlersContainer?.handlers;
          if (!feishuHandlers) {
            return {
              id: request.id,
              success: false,
              error: 'Feishu API handlers not available',
            };
          }
          const { chatId, filePath, threadId } =
            request.payload as IpcRequestPayloads['feishuUploadFile'];
          try {
            const result = await feishuHandlers.uploadFile(chatId, filePath, threadId);
            return { id: request.id, success: true, payload: { success: true, ...result } };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return { id: request.id, success: false, error: errorMessage };
          }
        }

        case 'feishuGetBotInfo': {
          const feishuHandlers = feishuHandlersContainer?.handlers;
          if (!feishuHandlers) {
            return {
              id: request.id,
              success: false,
              error: 'Feishu API handlers not available',
            };
          }
          try {
            const botInfo = await feishuHandlers.getBotInfo();
            return { id: request.id, success: true, payload: botInfo };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return { id: request.id, success: false, error: errorMessage };
          }
        }

        default:
          return {
            id: request.id,
            success: false,
            error: `Unknown request type: ${(request as { type: string }).type}`,
          };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ err: error, request }, 'Error handling IPC request');
      return { id: request.id, success: false, error: errorMessage };
    }
  };
}

/**
 * Unix Socket IPC Server.
 */
export class UnixSocketIpcServer {
  private server: Server | null = null;
  private socketPath: string;
  private handler: IpcRequestHandler;
  private activeConnections: Set<Socket> = new Set();
  private isShuttingDown = false;

  constructor(handler: IpcRequestHandler, config?: Partial<IpcConfig>) {
    this.socketPath = config?.socketPath ?? DEFAULT_IPC_CONFIG.socketPath;
    this.handler = handler;
  }

  /**
   * Start the IPC server.
   */
  // eslint-disable-next-line require-await
  async start(): Promise<void> {
    if (this.server) {
      logger.warn('IPC server already running');
      return;
    }

    // Ensure socket directory exists
    const socketDir = dirname(this.socketPath);
    if (!existsSync(socketDir)) {
      try {
        mkdirSync(socketDir, { recursive: true });
      } catch (error) {
        logger.warn({ err: error, path: socketDir }, 'Failed to create socket directory');
      }
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
        if (!this.server?.listening) {
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
   * Stop the IPC server.
   */
  // eslint-disable-next-line require-await
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
        // Ignore errors during cleanup
      }
    }
    this.activeConnections.clear();

    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close(() => {
        // Clean up socket file
        if (existsSync(this.socketPath)) {
          try {
            unlinkSync(this.socketPath);
            logger.debug({ path: this.socketPath }, 'Removed socket file');
          } catch {
            // Ignore cleanup errors
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
   * Check if the server is running.
   */
  isRunning(): boolean {
    return this.server?.listening ?? false;
  }

  /**
   * Get the socket path.
   */
  getSocketPath(): string {
    return this.socketPath;
  }

  /**
   * Handle a new connection.
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

      // Process complete messages (newline-delimited JSON)
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.trim()) {
          void this.handleMessage(socket, line);
        }
      }
    });

    socket.on('close', () => {
      this.activeConnections.delete(socket);
      logger.debug('IPC connection closed');
    });

    socket.on('error', (error) => {
      logger.debug({ err: error }, 'IPC connection error');
      this.activeConnections.delete(socket);
    });
  }

  /**
   * Handle an incoming message.
   */
  private async handleMessage(socket: Socket, data: string): Promise<void> {
    let request: IpcRequest;
    try {
      request = JSON.parse(data);
    } catch {
      logger.warn({ data }, 'Invalid JSON received');
      return;
    }

    try {
      const response = await this.handler(request);
      socket.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const response: IpcResponse = {
        id: request.id,
        success: false,
        error: errorMessage,
      };
      socket.write(`${JSON.stringify(response)}\n`);
    }
  }
}
