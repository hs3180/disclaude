/**
 * Worker Node IPC Server - Accepts IPC connections from MCP Server processes.
 *
 * This server listens on a Unix domain socket and handles IPC requests
 * from MCP Server child processes. Requests are bridged to the Primary Node
 * via WebSocket.
 *
 * Architecture:
 * ```
 * MCP Server (stdio) → IPC → WorkerIpcServer → WebSocket → Primary Node
 * ```
 *
 * @module worker-node/ipc/worker-ipc-server
 */

import * as fs from 'fs/promises';
import * as net from 'net';
import { existsSync } from 'fs';
import { createLogger, type IpcRequest, type IpcResponse } from '@disclaude/core';

const logger = createLogger('WorkerIpcServer');

/**
 * Pending request tracker for request/response correlation.
 */
interface PendingRequest {
  resolve: (response: IpcResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * Request handler function type.
 */
export type IpcRequestHandler = (request: IpcRequest) => Promise<IpcResponse>;

/**
 * Configuration for WorkerIpcServer.
 */
export interface WorkerIpcServerConfig {
  /** Unix socket file path (default: /tmp/disclaude-worker.ipc) */
  socketPath?: string;
  /** Connection timeout in milliseconds (default: 30000) */
  timeout?: number;
}

/**
 * Default configuration for WorkerIpcServer.
 */
const DEFAULT_WORKER_IPC_CONFIG: Required<WorkerIpcServerConfig> = {
  socketPath: '/tmp/disclaude-worker.ipc',
  timeout: 30000,
};

/**
 * Worker Node IPC Server.
 *
 * Accepts IPC connections from MCP Server processes and bridges
 * requests to Primary Node via WebSocket through a request handler.
 */
export class WorkerIpcServer {
  private server: net.Server | null = null;
  private readonly socketPath: string;
  private readonly activeSockets = new Set<net.Socket>();
  private requestHandler: IpcRequestHandler | null = null;

  constructor(config: WorkerIpcServerConfig = {}) {
    this.socketPath = config.socketPath ?? DEFAULT_WORKER_IPC_CONFIG.socketPath;
  }

  /**
   * Set the request handler for processing IPC requests.
   * Must be called before start().
   */
  setRequestHandler(handler: IpcRequestHandler): void {
    this.requestHandler = handler;
  }

  /**
   * Start the IPC server.
   */
  async start(): Promise<void> {
    if (this.server) {
      logger.warn('WorkerIpcServer already running');
      return;
    }

    if (!this.requestHandler) {
      throw new Error('Request handler must be set before starting the server');
    }

    // Remove existing socket file if present
    if (existsSync(this.socketPath)) {
      try {
        await fs.unlink(this.socketPath);
        logger.debug({ socketPath: this.socketPath }, 'Removed existing socket file');
      } catch (error) {
        logger.warn({ err: error, socketPath: this.socketPath }, 'Failed to remove existing socket file');
      }
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (error) => {
        logger.error({ err: error, socketPath: this.socketPath }, 'IPC server error');
        reject(error);
      });

      this.server.listen(this.socketPath, () => {
        logger.info({ socketPath: this.socketPath }, 'WorkerIpcServer started');
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

    // Close all active connections
    for (const socket of this.activeSockets) {
      try {
        socket.destroy();
      } catch (error) {
        logger.debug({ err: error }, 'Error destroying socket during shutdown');
      }
    }
    this.activeSockets.clear();

    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close(async () => {
        logger.info('WorkerIpcServer stopped');

        // Remove socket file
        try {
          await fs.unlink(this.socketPath);
          logger.debug({ socketPath: this.socketPath }, 'Removed socket file');
        } catch (_error) {
          // Socket file may not exist, ignore
        }

        this.server = null;
        resolve();
      });
    });
  }

  /**
   * Get the socket path for this server.
   */
  getSocketPath(): string {
    return this.socketPath;
  }

  /**
   * Check if the server is running.
   */
  isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  /**
   * Handle a new IPC connection.
   */
  private handleConnection(socket: net.Socket): void {
    const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.activeSockets.add(socket);

    logger.debug({ clientId }, 'New IPC client connected');

    let buffer = '';
    const pendingRequests = new Map<string, PendingRequest>();

    socket.on('data', (data) => {
      buffer += data.toString();

      // Process complete lines (newline-delimited JSON)
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.trim()) {
          this.processRequest(line, socket).catch((error) => {
            logger.error({ err: error, clientId }, 'Error processing IPC request');
          });
        }
      }
    });

    socket.on('close', () => {
      this.activeSockets.delete(socket);
      logger.debug({ clientId }, 'IPC client disconnected');

      // Reject all pending requests for this connection
      for (const [id, pending] of pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('IPC connection closed'));
        pendingRequests.delete(id);
      }
    });

    socket.on('error', (error) => {
      logger.debug({ err: error, clientId }, 'IPC socket error');
    });
  }

  /**
   * Process a single IPC request.
   */
  private async processRequest(
    line: string,
    socket: net.Socket
  ): Promise<void> {
    let request: IpcRequest;

    try {
      request = JSON.parse(line) as IpcRequest;
    } catch (error) {
      logger.error({ err: error, line }, 'Failed to parse IPC request');
      const errorResponse: IpcResponse = {
        id: 'unknown',
        success: false,
        error: 'Invalid JSON',
      };
      socket.write(`${JSON.stringify(errorResponse)}\n`);
      return;
    }

    logger.debug({ requestId: request.id, type: request.type }, 'Processing IPC request');

    try {
      if (!this.requestHandler) {
        throw new Error('No request handler configured');
      }

      const response = await this.requestHandler(request);
      response.id = request.id;

      socket.write(`${JSON.stringify(response)}\n`);

      logger.debug(
        { requestId: request.id, type: request.type, success: response.success },
        'IPC response sent'
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error({ err, requestId: request.id, type: request.type }, 'IPC request failed');

      const errorResponse: IpcResponse = {
        id: request.id,
        success: false,
        error: err.message,
      };
      socket.write(`${JSON.stringify(errorResponse)}\n`);
    }
  }
}
