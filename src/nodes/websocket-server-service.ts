/**
 * WebSocketServerService - Manages WebSocket and HTTP server.
 *
 * Extracts server management concerns from PrimaryNode:
 * - HTTP server for health check and file API
 * - WebSocket server for Worker Node connections
 * - Connection lifecycle management
 *
 * Architecture:
 * ```
 * PrimaryNode → WebSocketServerService → { HTTP Server, WebSocket Server }
 *                      ↓
 *              Worker Node connections
 * ```
 */

import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';
import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger.js';
import type { FileStorageService, FileStorageConfig } from '../file-transfer/node-transfer/file-storage.js';
import { createFileTransferAPIHandler } from '../file-transfer/node-transfer/file-api.js';
import type { ExecNodeRegistry } from './exec-node-registry.js';
import type { FeedbackMessage, RegisterMessage, FeishuApiRequestMessage, FeishuApiResponseMessage } from '../types/websocket-messages.js';
import type { NodeCapabilities } from './types.js';

const logger = createLogger('WebSocketServerService');

/**
 * Configuration for WebSocketServerService.
 */
export interface WebSocketServerServiceConfig {
  /** Server port */
  port: number;
  /** Server host */
  host: string;
  /** Local node ID */
  localNodeId: string;
  /** File storage config (optional) */
  fileStorageConfig?: FileStorageConfig;
  /** Exec node registry */
  execNodeRegistry: ExecNodeRegistry;
  /** Feedback handler */
  handleFeedback: (feedback: FeedbackMessage) => void;
  /** Get capabilities callback */
  getCapabilities: () => NodeCapabilities;
  /** Get channels callback */
  getChannelIds: () => string[];
  /**
   * Register card context for routing callbacks to Worker Nodes.
   * Issue #935: Called when a Worker Node sends a card message.
   */
  registerCardContext?: (chatId: string, nodeId: string, isRemote: boolean) => void;
  /**
   * Handle Feishu API requests from Worker Nodes.
   * Issue #1036: Called when a Worker Node requests a Feishu API call.
   */
  handleFeishuApiRequest?: (
    request: FeishuApiRequestMessage,
    sendResponse: (response: FeishuApiResponseMessage) => void
  ) => Promise<void>;
}

/**
 * WebSocketServerService - Manages WebSocket and HTTP server lifecycle.
 *
 * Handles:
 * - HTTP server for health checks and file API
 * - WebSocket server for Worker Node connections
 * - Worker registration and message handling
 */
export class WebSocketServerService extends EventEmitter {
  private readonly port: number;
  private readonly host: string;
  private readonly localNodeId: string;
  private readonly execNodeRegistry: ExecNodeRegistry;
  private readonly handleFeedback: (feedback: FeedbackMessage) => void;
  private readonly getCapabilities: () => NodeCapabilities;
  private readonly getChannelIds: () => string[];
  private readonly fileStorageConfig?: FileStorageConfig;
  // Issue #935: Card context registration callback
  private readonly registerCardContext?: (chatId: string, nodeId: string, isRemote: boolean) => void;
  // Issue #1036: Feishu API request handler
  private readonly handleFeishuApiRequest?: (
    request: FeishuApiRequestMessage,
    sendResponse: (response: FeishuApiResponseMessage) => void
  ) => Promise<void>;

  private httpServer?: http.Server;
  private wss?: WebSocketServer;
  private fileStorageService?: FileStorageService;
  private running = false;

  constructor(config: WebSocketServerServiceConfig) {
    super();
    this.port = config.port;
    this.host = config.host;
    this.localNodeId = config.localNodeId;
    this.fileStorageConfig = config.fileStorageConfig;
    this.execNodeRegistry = config.execNodeRegistry;
    this.handleFeedback = config.handleFeedback;
    this.getCapabilities = config.getCapabilities;
    this.getChannelIds = config.getChannelIds;
    this.registerCardContext = config.registerCardContext;
    this.handleFeishuApiRequest = config.handleFeishuApiRequest;
  }

  /**
   * Start the WebSocket server.
   */
  async start(): Promise<void> {
    // Initialize file storage service if configured
    if (this.fileStorageConfig) {
      const { FileStorageService } = await import('../file-transfer/node-transfer/file-storage.js');
      this.fileStorageService = new FileStorageService(this.fileStorageConfig);
      await this.fileStorageService.initialize();
      logger.info('File storage service initialized');
    }

    // Create file API handler
    const fileApiHandler = this.fileStorageService
      ? createFileTransferAPIHandler({ storageService: this.fileStorageService })
      : null;

    // Create HTTP server for health check, file API, and WebSocket upgrade
    this.httpServer = http.createServer(async (req, res) => {
      const url = req.url || '/';

      // Handle file API requests
      if (fileApiHandler && url.startsWith('/api/files')) {
        const handled = await fileApiHandler(req, res);
        if (handled) {return;}
      }

      // Health check
      if (url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          mode: 'primary',
          nodeId: this.localNodeId,
          capabilities: this.getCapabilities(),
          channels: this.getChannelIds(),
          execNodes: this.execNodeRegistry.getNodes().map(n => ({
            nodeId: n.nodeId,
            name: n.name,
            status: n.status,
            isLocal: n.isLocal,
          })),
          fileStorage: this.fileStorageService?.getStats(),
        }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    // Create WebSocket server
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    // Start server
    return new Promise((resolve) => {
      this.httpServer?.listen(this.port, this.host, () => {
        logger.info({ port: this.port, host: this.host }, 'WebSocket server started');
        this.running = true;
        resolve();
      });
    });
  }

  /**
   * Handle new WebSocket connection.
   */
  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const clientIp = req.socket.remoteAddress;
    let currentNodeId: string | undefined;

    logger.info({ clientIp }, 'Worker Node connecting...');

    // Handle incoming messages
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());

        // Handle registration message
        if (message.type === 'register') {
          const regMsg = message as RegisterMessage;
          currentNodeId = this.execNodeRegistry.registerNode(ws, regMsg, clientIp);
          return;
        }

        // Issue #1036: Handle Feishu API request from Worker Nodes
        if (message.type === 'feishu-api-request') {
          const apiRequest = message as FeishuApiRequestMessage;
          if (this.handleFeishuApiRequest) {
            const sendResponse = (response: FeishuApiResponseMessage) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(response));
              }
            };
            this.handleFeishuApiRequest(apiRequest, sendResponse).catch((error) => {
              logger.error({ err: error, requestId: apiRequest.requestId }, 'Failed to handle Feishu API request');
              sendResponse({
                type: 'feishu-api-response',
                requestId: apiRequest.requestId,
                success: false,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          } else {
            // No handler configured, send error response
            ws.send(JSON.stringify({
              type: 'feishu-api-response',
              requestId: apiRequest.requestId,
              success: false,
              error: 'Feishu API routing not configured on this Primary Node',
            }));
          }
          return;
        }

        // Handle feedback message (from Worker Nodes)
        const feedbackMsg = message as FeedbackMessage;

        // Issue #935: Register card context for remote Worker Nodes
        // This enables routing card action callbacks back to the correct Worker Node
        if (feedbackMsg.type === 'card' && currentNodeId && this.registerCardContext) {
          this.registerCardContext(feedbackMsg.chatId, currentNodeId, true);
          logger.debug(
            { chatId: feedbackMsg.chatId, nodeId: currentNodeId },
            'Card context registered for remote Worker Node'
          );
        }

        this.handleFeedback(feedbackMsg);
      } catch (error) {
        logger.error({ err: error }, 'Failed to parse message');
      }
    });

    ws.on('close', () => {
      if (currentNodeId) {
        this.execNodeRegistry.unregisterNode(currentNodeId);
      }
      this.emit('connection:closed', currentNodeId);
    });

    ws.on('error', (error) => {
      logger.error({ err: error, nodeId: currentNodeId }, 'WebSocket error');
    });

    // Auto-register timeout for backward compatibility
    const registrationTimeout = setTimeout(() => {
      if (!currentNodeId && ws.readyState === WebSocket.OPEN) {
        const autoNodeId = `worker-${Date.now()}`;
        currentNodeId = this.execNodeRegistry.registerNode(
          ws,
          { type: 'register', nodeId: autoNodeId, name: 'Auto-registered Worker' },
          clientIp
        );
        logger.info({ nodeId: currentNodeId }, 'Auto-registered worker node (backward compatibility)');
      }
    }, 1000);

    ws.on('close', () => clearTimeout(registrationTimeout));
  }

  /**
   * Stop the WebSocket server.
   */
  async stop(): Promise<void> {
    this.running = false;

    // Shutdown file storage service
    if (this.fileStorageService) {
      this.fileStorageService.shutdown();
      this.fileStorageService = undefined;
    }

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = undefined;
    }

    // Close HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer?.close(() => {
          logger.info('HTTP server closed');
          resolve();
        });
      });
    }
  }

  /**
   * Check if the server is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the file storage service.
   */
  getFileStorageService(): FileStorageService | undefined {
    return this.fileStorageService;
  }
}
