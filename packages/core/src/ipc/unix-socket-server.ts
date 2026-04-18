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
import { createServer, type Server } from 'net';
import { createLogger } from '../utils/logger.js';
import type { FeishuCard } from '../types/platform.js';
import {
  DEFAULT_IPC_CONFIG,
  type IpcConfig,
  type IpcRequest,
  type IpcRequestPayloads,
  type IpcResponse,
} from './protocol.js';
import type {
  IIpcServerTransport,
  IpcConnectionLike,
} from './transport.js';

const logger = createLogger('IpcServer');

/**
 * Maximum length for Unix domain socket paths.
 * macOS: 104 bytes (sizeof(sockaddr_un.sun_path) - 1)
 * Linux: 108 bytes
 * We use the stricter limit for cross-platform compatibility.
 */
const MAX_SOCKET_PATH_LENGTH = 104;

/**
 * Handler function type for processing IPC requests.
 */
export type IpcRequestHandler = (request: IpcRequest) => Promise<IpcResponse>;

/**
 * Platform-agnostic Channel API handlers interface (Issue #1546).
 *
 * Defines the common operations that all channel implementations must support.
 * Platform-specific implementations (Feishu, Slack, etc.) extend this interface.
 */
export interface ChannelApiHandlers {
  sendMessage: (chatId: string, text: string, threadId?: string, mentions?: Array<{ openId: string; name?: string }>) => Promise<void>;
  sendCard: (
    chatId: string,
    card: FeishuCard,
    threadId?: string,
    description?: string
  ) => Promise<void>;
  uploadFile: (
    chatId: string,
    filePath: string,
    threadId?: string
  ) => Promise<{ fileKey: string; fileType: string; fileName: string; fileSize: number }>;
  sendInteractive: (
    chatId: string,
    params: {
      question: string;
      options: Array<{ text: string; value: string; type?: 'primary' | 'default' | 'danger' }>;
      title?: string;
      context?: string;
      threadId?: string;
      actionPrompts?: Record<string, string>;
    }
  ) => Promise<{ messageId?: string }>;
  /** Register a temp chat for lifecycle tracking (Issue #1703) */
  registerTempChat?: (chatId: string, opts?: { expiresAt?: string; creatorChatId?: string; context?: Record<string, unknown>; triggerMode?: 'mention' | 'always' }) => Promise<{ success: boolean; expiresAt?: string }>;
  /** List all tracked temp chats (Issue #1703) */
  listTempChats?: () => Promise<Array<{ chatId: string; createdAt: string; expiresAt: string; creatorChatId?: string; responded: boolean }>>;
  /** Mark a temp chat as responded (Issue #1703) */
  markChatResponded?: (chatId: string, response: { selectedValue: string; responder: string; repliedAt: string }) => Promise<{ success: boolean }>;
  /** Insert an image into a Feishu docx document at a specific position (Issue #2278) */
  insertDocxImage?: (
    documentId: string,
    imagePath: string,
    index: number,
    caption?: string
  ) => Promise<{ blockId: string; fileToken: string }>;
}

/**
 * Handler functions for Feishu API operations (Issue #1035).
 * Extends ChannelApiHandlers with Feishu-specific methods.
 *
 * @deprecated Use ChannelApiHandlers directly for new code.
 * FeishuApiHandlers is kept for backward compatibility but currently
 * adds no Feishu-specific methods. It will be removed in a future version.
 */
export interface FeishuApiHandlers extends ChannelApiHandlers {
  // Feishu-specific methods can be added here in the future.
  // getBotInfo is intentionally NOT included — it's dead code
  // (handled by platform SDK layer independently).
}

/**
 * Mutable container for channel API handlers.
 * Issue #1120: Allows dynamic registration of handlers after IPC server starts.
 * Issue #1546: Renamed from FeishuHandlersContainer to use platform-agnostic naming.
 */
export interface ChannelHandlersContainer {
  handlers: ChannelApiHandlers | undefined;
}

/**
 * @deprecated Use ChannelHandlersContainer instead.
 */
export type FeishuHandlersContainer = ChannelHandlersContainer;

/**
 * Create an IPC request handler for channel API operations.
 *
 * Issue #1120: Uses ChannelHandlersContainer for dynamic handler registration.
 * Issue #1573 (Phase 4): Removed InteractiveMessageHandlers — state management
 * dispatch cases removed; only registerActionPrompts callback remains for
 * internal use by the sendInteractive handler.
 */
export function createInteractiveMessageHandler(
  registerActionPrompts: (messageId: string, chatId: string, actionPrompts: Record<string, string>) => void,
  channelHandlersContainer?: ChannelHandlersContainer
): IpcRequestHandler {

  return async (request: IpcRequest): Promise<IpcResponse> => {
    try {
      switch (request.type) {
        case 'ping':
          return { id: request.id, success: true, payload: { pong: true } };

        // Platform-agnostic messaging operations (Issue #1574: Phase 5 of IPC refactor)
        // Issue #1120: Use container for dynamic handler registration
        case 'sendMessage': {
          const handlers = channelHandlersContainer?.handlers;
          if (!handlers) {
            return {
              id: request.id,
              success: false,
              error: 'Channel API handlers not available',
            };
          }
          const { chatId, text, threadId, mentions } =
            request.payload as IpcRequestPayloads['sendMessage'];
          try {
            await handlers.sendMessage(chatId, text, threadId, mentions);
            return { id: request.id, success: true, payload: { success: true } };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return { id: request.id, success: false, error: errorMessage };
          }
        }

        case 'sendCard': {
          const handlers = channelHandlersContainer?.handlers;
          if (!handlers) {
            return {
              id: request.id,
              success: false,
              error: 'Channel API handlers not available',
            };
          }
          const { chatId, card, threadId, description } =
            request.payload as IpcRequestPayloads['sendCard'];
          try {
            await handlers.sendCard(chatId, card, threadId, description);
            return { id: request.id, success: true, payload: { success: true } };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return { id: request.id, success: false, error: errorMessage };
          }
        }

        case 'uploadFile': {
          const handlers = channelHandlersContainer?.handlers;
          if (!handlers) {
            return {
              id: request.id,
              success: false,
              error: 'Channel API handlers not available',
            };
          }
          const { chatId, filePath, threadId } =
            request.payload as IpcRequestPayloads['uploadFile'];
          try {
            const result = await handlers.uploadFile(chatId, filePath, threadId);
            return { id: request.id, success: true, payload: { success: true, ...result } };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return { id: request.id, success: false, error: errorMessage };
          }
        }

        // Raw-param interactive card (Issue #1570)
        case 'sendInteractive': {
          const handlers = channelHandlersContainer?.handlers;
          if (!handlers) {
            return {
              id: request.id,
              success: false,
              error: 'Channel API handlers not available',
            };
          }
          const { chatId, question, options, title, context, threadId, actionPrompts } =
            request.payload as IpcRequestPayloads['sendInteractive'];
          try {
            const result = await handlers.sendInteractive(chatId, {
              question,
              options,
              title,
              context,
              threadId,
              actionPrompts,
            });

            // Register action prompts so card callbacks can find them
            // Issue #1570: Primary Node owns the full interactive card lifecycle
            // Issue #1572: Use resolved actionPrompts from result (may include auto-generated defaults)
            // Issue #1573: Use direct callback instead of InteractiveMessageHandlers
            const resolvedPrompts = (result as { actionPrompts?: Record<string, string> }).actionPrompts
              ?? actionPrompts;
            if (resolvedPrompts && result.messageId) {
              registerActionPrompts(result.messageId, chatId, resolvedPrompts);
              logger.debug(
                { messageId: result.messageId, chatId, actionCount: Object.keys(resolvedPrompts).length },
                'sendInteractive: action prompts registered'
              );
            }

            return { id: request.id, success: true, payload: { success: true, ...result } };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return { id: request.id, success: false, error: errorMessage };
          }
        }

        // Temporary chat lifecycle management (Issue #1703)
        case 'registerTempChat': {
          const handlers = channelHandlersContainer?.handlers;
          if (!handlers) {
            return {
              id: request.id,
              success: false,
              error: 'Channel API handlers not available',
            };
          }
          if (!handlers.registerTempChat) {
            return {
              id: request.id,
              success: false,
              error: 'registerTempChat not supported by this channel',
            };
          }
          const { chatId, expiresAt, creatorChatId, context, triggerMode } =
            request.payload as IpcRequestPayloads['registerTempChat'];
          try {
            const result = await handlers.registerTempChat(chatId, { expiresAt, creatorChatId, context, triggerMode });
            return { id: request.id, success: true, payload: { success: result.success, chatId, expiresAt: result.expiresAt } };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return { id: request.id, success: false, error: errorMessage };
          }
        }

        case 'listTempChats': {
          const handlers = channelHandlersContainer?.handlers;
          if (!handlers) {
            return {
              id: request.id,
              success: false,
              error: 'Channel API handlers not available',
            };
          }
          if (!handlers.listTempChats) {
            return {
              id: request.id,
              success: false,
              error: 'listTempChats not supported by this channel',
            };
          }
          try {
            const chats = await handlers.listTempChats();
            return { id: request.id, success: true, payload: { success: true, chats } };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return { id: request.id, success: false, error: errorMessage };
          }
        }

        case 'markChatResponded': {
          const handlers = channelHandlersContainer?.handlers;
          if (!handlers) {
            return {
              id: request.id,
              success: false,
              error: 'Channel API handlers not available',
            };
          }
          if (!handlers.markChatResponded) {
            return {
              id: request.id,
              success: false,
              error: 'markChatResponded not supported by this channel',
            };
          }
          const { chatId, response } =
            request.payload as IpcRequestPayloads['markChatResponded'];
          try {
            const result = await handlers.markChatResponded(chatId, response);
            return { id: request.id, success: true, payload: { success: result.success } };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return { id: request.id, success: false, error: errorMessage };
          }
        }

        // Docx image insertion (Issue #2278)
        case 'insertDocxImage': {
          const handlers = channelHandlersContainer?.handlers;
          if (!handlers) {
            return {
              id: request.id,
              success: false,
              error: 'Channel API handlers not available',
            };
          }
          if (!handlers.insertDocxImage) {
            return {
              id: request.id,
              success: false,
              error: 'insertDocxImage not supported by this channel',
            };
          }
          const { documentId, imagePath, index, caption } =
            request.payload as IpcRequestPayloads['insertDocxImage'];
          try {
            const result = await handlers.insertDocxImage(documentId, imagePath, index, caption);
            return { id: request.id, success: true, payload: { success: true, ...result } };
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
 *
 * Issue #1355: Added socket health check and process exit cleanup.
 */
export class UnixSocketIpcServer {
  private server: Server | null = null;
  private socketPath: string;
  private handler: IpcRequestHandler;
  private activeConnections: Set<IpcConnectionLike> = new Set();
  private isShuttingDown = false;
  /** Issue #2352: Optional transport injection for testability (no filesystem side effects) */
  private transport?: IIpcServerTransport;
  /** Issue #1355: Health check interval for socket file monitoring */
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  /** Issue #1355: Bound cleanup handlers for removal on stop() */
  private boundCleanupHandler: (() => void) | null = null;

  constructor(
    handler: IpcRequestHandler,
    config?: Partial<IpcConfig>,
    transport?: IIpcServerTransport,
  ) {
    this.socketPath = config?.socketPath ?? DEFAULT_IPC_CONFIG.socketPath;
    this.handler = handler;
    this.transport = transport;
  }

  /**
   * Start the IPC server.
   */
   
  async start(): Promise<void> {
    // Issue #2352: Transport mode (in-memory, for testing) — skip all filesystem operations
    if (this.transport) {
      if (this.transport.isListening()) {
        logger.warn('IPC server already running (transport mode)');
        return;
      }
      await this.transport.start((conn) => this.handleConnection(conn));
      logger.info({ path: this.socketPath }, 'IPC server started (transport mode)');
      return;
    }

    if (this.server) {
      logger.warn('IPC server already running');
      return;
    }

    // Validate socket path length to avoid EINVAL on listen()
    if (this.socketPath.length > MAX_SOCKET_PATH_LENGTH) {
      throw new Error(
        `IPC socket path too long (${this.socketPath.length} chars, max ${MAX_SOCKET_PATH_LENGTH}): ${this.socketPath}`,
      );
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
        // Issue #1355: Start socket health check
        this.startHealthCheck();
        // Issue #1355: Register process exit cleanup
        this.registerProcessExitCleanup();
        resolve();
      });
    });
  }

  /**
   * Stop the IPC server.
   */
   
  async stop(): Promise<void> {
    // Issue #2352: Transport mode
    if (this.transport && !this.server) {
      this.isShuttingDown = true;
      for (const conn of this.activeConnections) {
        try { conn.destroy(); } catch { /* ignore */ }
      }
      this.activeConnections.clear();
      await this.transport.stop();
      this.isShuttingDown = false;
      logger.info('IPC server stopped (transport mode)');
      return;
    }

    if (!this.server) {
      return;
    }

    this.isShuttingDown = true;

    // Issue #1355: Stop health check
    this.stopHealthCheck();
    // Issue #1355: Remove process exit cleanup
    this.unregisterProcessExitCleanup();

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
    // Issue #2352: Transport mode
    if (this.transport) {
      return this.transport.isListening();
    }
    return this.server?.listening ?? false;
  }

  /**
   * Get the socket path.
   */
  getSocketPath(): string {
    return this.socketPath;
  }

  // ===========================================================================
  // Issue #1355: Socket health check and process exit cleanup
  // ===========================================================================

  /**
   * Start periodic health check to detect socket file loss.
   *
   * If the socket file disappears (e.g., cleaned by OS `/tmp` cleanup),
   * the server is automatically stopped and restarted to recreate it.
   */
  private startHealthCheck(): void {
    // Check every 30 seconds
    this.healthCheckTimer = setInterval(() => {
      if (this.isShuttingDown || !this.server?.listening) {
        return;
      }

      if (!existsSync(this.socketPath)) {
        logger.warn(
          { path: this.socketPath },
          'Socket file lost, rebuilding IPC server...'
        );
        // Stop and restart — the caller is responsible for re-creating
        // the environment variable. Since Primary Node / Worker Node
        // set DISCLAUDE_WORKER_IPC_SOCKET after startIpcServer(),
        // we simply stop; the parent will detect via isRunning().
        void this.rebuildServer();
      }
    }, 30_000);

    // Allow the process to exit even if the timer is active
    if (this.healthCheckTimer && 'unref' in this.healthCheckTimer) {
      this.healthCheckTimer.unref();
    }
  }

  /**
   * Stop the health check timer.
   */
  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Rebuild the IPC server after socket file loss.
   *
   * Stops the current server and starts a new one at the same socket path.
   */
  private async rebuildServer(): Promise<void> {
    try {
      await this.stop();
      await this.start();
      logger.info(
        { path: this.socketPath },
        'IPC server rebuilt after socket file loss'
      );
    } catch (error) {
      logger.error(
        { err: error, path: this.socketPath },
        'Failed to rebuild IPC server'
      );
    }
  }

  /**
   * Register process exit cleanup to ensure socket file removal.
   *
   * Issue #1355: Ensures socket files are cleaned up on SIGTERM/SIGINT
   * to prevent stale files after PM2 restarts or process crashes.
   */
  private registerProcessExitCleanup(): void {
    this.boundCleanupHandler = () => {
      void this.stop();
    };

    process.on('SIGTERM', this.boundCleanupHandler);
    process.on('SIGINT', this.boundCleanupHandler);
  }

  /**
   * Unregister process exit cleanup handlers.
   */
  private unregisterProcessExitCleanup(): void {
    if (this.boundCleanupHandler) {
      process.off('SIGTERM', this.boundCleanupHandler);
      process.off('SIGINT', this.boundCleanupHandler);
      this.boundCleanupHandler = null;
    }
  }

  /**
   * Handle a new connection.
   *
   * Accepts IpcConnectionLike (works with both net.Socket and in-memory connections).
   * Issue #2352: Changed parameter type from Socket to IpcConnectionLike for transport injection.
   */
  private handleConnection(conn: IpcConnectionLike): void {
    if (this.isShuttingDown) {
      conn.destroy();
      return;
    }

    this.activeConnections.add(conn);
    logger.debug({ remoteAddress: conn.remoteAddress }, 'New IPC connection');

    let buffer = '';

    conn.on('data', (data) => {
      buffer += data.toString();

      // Process complete messages (newline-delimited JSON)
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.trim()) {
          void this.handleMessage(conn, line);
        }
      }
    });

    conn.on('close', () => {
      this.activeConnections.delete(conn);
      logger.debug('IPC connection closed');
    });

    conn.on('error', (error) => {
      logger.debug({ err: error }, 'IPC connection error');
      this.activeConnections.delete(conn);
    });
  }

  /**
   * Handle an incoming message.
   *
   * Issue #2352: Changed parameter type from Socket to IpcConnectionLike.
   */
  private async handleMessage(conn: IpcConnectionLike, data: string): Promise<void> {
    let request: IpcRequest;
    try {
      request = JSON.parse(data);
    } catch {
      logger.warn({ data }, 'Invalid JSON received');
      return;
    }

    try {
      const response = await this.handler(request);
      conn.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const response: IpcResponse = {
        id: request.id,
        success: false,
        error: errorMessage,
      };
      conn.write(`${JSON.stringify(response)}\n`);
    }
  }
}
