/**
 * Primary Node - Main node with both communication and execution capabilities.
 *
 * This self-contained node can:
 * - Handle multiple communication channels (Feishu, REST, etc.)
 * - Execute Agent tasks locally
 * - Accept connections from Worker Nodes for horizontal scaling
 *
 * Architecture (Refactored - Issue #435, Issue #695, Issue #1040):
 * ```
 * ┌─────────────────────────────────────────────────────────────┐
 * │                      Primary Node                           │
 * │                                                             │
 * │  ┌─────────────────────────────────────────────────────────┐│
 * │  │                    Coordination Layer                     ││
 * │  │   - Lifecycle management (start/stop)                     ││
 * │  │   - Channel registration                                   ││
 * │  │   - Local execution setup                                  ││
 * │  └─────────────────────────────────────────────────────────┘│
 * │                                                             │
 * │  ┌───────────────┐ ┌───────────────┐ ┌───────────────────┐   │
 * │  │ExecNodeRegistry│ │FeedbackRouter│ │WebSocketServerSvc │   │
 * │  └───────────────┘ └───────────────┘ └───────────────────┘   │
 * │                                                             │
 * │  ┌─────────────────────────────────────────────────────────┐│
 * │  │              SchedulerService + LocalExecution           ││
 * │  └─────────────────────────────────────────────────────────┘│
 * └─────────────────────────────────────────────────────────────┘
 * ```
 *
 * Issue #1040: Migrated to @disclaude/primary-node
 */

import { EventEmitter } from 'events';
import { createLogger, type IChannel } from '@disclaude/core';
import { ExecNodeRegistry } from './exec-node-registry.js';
import { CardActionRouter } from './routers/card-action-router.js';
import { DebugGroupService, getDebugGroupService } from './services/debug-group-service.js';

const logger = createLogger('PrimaryNode');

/**
 * Primary Node Configuration.
 * Note: This is the local config type. For the full type, see PrimaryNodeConfig from @disclaude/core.
 */
export interface PrimaryNodeOptions {
  /** Node ID (unique identifier) */
  nodeId?: string;

  /** Host to bind to */
  host?: string;

  /** Port to listen on */
  port?: number;

  /** Enable local execution */
  enableLocalExec?: boolean;

  /** Feishu App ID */
  appId?: string;

  /** Feishu App Secret */
  appSecret?: string;

  /** Admin chat ID for debug messages */
  adminChatId?: string;

  /** Channels to register */
  channels?: IChannel[];

  /** Enable REST channel */
  enableRestChannel?: boolean;

  /** REST channel port */
  restPort?: number;
}

/**
 * Node capabilities.
 */
export interface NodeCapabilities {
  /** Can handle communication */
  communication: boolean;

  /** Can execute tasks */
  execution: boolean;
}

/**
 * Primary Node - Self-contained node with both communication and execution capabilities.
 *
 * Responsibilities:
 * - Lifecycle management (start/stop)
 * - Channel registration and setup
 * - Local execution initialization
 * - Coordination between services
 *
 * Delegated concerns:
 * - ExecNodeRegistry: Execution node management
 * - FeedbackRouter: Feedback routing to channels
 * - WebSocketServerService: WebSocket/HTTP server management
 * - SchedulerService: Scheduler and file watcher management
 */
export class PrimaryNode extends EventEmitter {
  protected port: number;
  protected host: string;
  protected running = false;

  // Node configuration
  protected localNodeId: string;
  protected localExecEnabled: boolean;

  // Services
  protected execNodeRegistry: ExecNodeRegistry;
  protected cardActionRouter: CardActionRouter;
  protected debugGroupService: DebugGroupService;

  // Registered channels
  protected channels: Map<string, IChannel> = new Map();

  constructor(config: PrimaryNodeOptions = {}) {
    super();
    this.port = config.port || 3001;
    this.host = config.host || '0.0.0.0';
    this.localNodeId = config.nodeId || `primary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.localExecEnabled = config.enableLocalExec !== false;

    // Initialize ExecNodeRegistry
    this.execNodeRegistry = new ExecNodeRegistry({
      localNodeId: this.localNodeId,
      localExecEnabled: this.localExecEnabled,
    });

    // Forward registry events
    this.execNodeRegistry.on('node:registered', (nodeId: string) => this.emit('worker:connected', nodeId));
    this.execNodeRegistry.on('node:unregistered', (nodeId: string) => this.emit('worker:disconnected', nodeId));

    // Initialize CardActionRouter
    this.cardActionRouter = new CardActionRouter({
      // eslint-disable-next-line require-await
      sendToRemoteNode: async () => false, // Override in subclass
      isNodeConnected: () => false,
    });

    // Initialize DebugGroupService
    this.debugGroupService = getDebugGroupService();

    logger.info({
      nodeId: this.localNodeId,
      port: this.port,
      host: this.host,
      localExecEnabled: this.localExecEnabled,
    }, 'PrimaryNode created');
  }

  /**
   * Get node capabilities.
   */
  getCapabilities(): NodeCapabilities {
    return {
      communication: true,
      execution: this.localExecEnabled || this.execNodeRegistry.hasAvailableNode(),
    };
  }

  /**
   * Get node ID.
   */
  getNodeId(): string {
    return this.localNodeId;
  }

  /**
   * Check if the node is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the ExecNodeRegistry.
   */
  getExecNodeRegistry(): ExecNodeRegistry {
    return this.execNodeRegistry;
  }

  /**
   * Get the CardActionRouter.
   */
  getCardActionRouter(): CardActionRouter {
    return this.cardActionRouter;
  }

  /**
   * Get the DebugGroupService.
   */
  getDebugGroupService(): DebugGroupService {
    return this.debugGroupService;
  }

  /**
   * Register a communication channel.
   */
  registerChannel(channel: IChannel): void {
    if (this.channels.has(channel.id)) {
      logger.warn({ channelId: channel.id }, 'Channel already registered, replacing');
    }

    this.channels.set(channel.id, channel);
    logger.info({ channelId: channel.id }, 'Channel registered');
  }

  /**
   * Unregister a communication channel.
   */
  unregisterChannel(channelId: string): boolean {
    const removed = this.channels.delete(channelId);
    if (removed) {
      logger.info({ channelId }, 'Channel unregistered');
    }
    return removed;
  }

  /**
   * Get all registered channels.
   */
  getChannels(): IChannel[] {
    return Array.from(this.channels.values());
  }

  /**
   * Get a channel by ID.
   */
  getChannel(channelId: string): IChannel | undefined {
    return this.channels.get(channelId);
  }

  /**
   * Start the Primary Node.
   */
  // eslint-disable-next-line require-await
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('PrimaryNode already running');
      return;
    }

    logger.info({ nodeId: this.localNodeId }, 'Starting PrimaryNode');
    this.running = true;
    this.emit('started');
    logger.info({ nodeId: this.localNodeId }, 'PrimaryNode started');
  }

  /**
   * Stop the Primary Node.
   */
  // eslint-disable-next-line require-await
  async stop(): Promise<void> {
    if (!this.running) {
      logger.warn('PrimaryNode not running');
      return;
    }

    logger.info({ nodeId: this.localNodeId }, 'Stopping PrimaryNode');
    this.running = false;
    this.emit('stopped');
    logger.info({ nodeId: this.localNodeId }, 'PrimaryNode stopped');
  }
}
