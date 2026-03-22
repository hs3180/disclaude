/**
 * Worker Node - Execution-only node that connects to Primary Node.
 *
 * This module provides execution capability without communication channels.
 * It connects to a Primary Node via WebSocket and executes Agent tasks.
 *
 * Architecture:
 * ```
 * ┌─────────────────────────────────────────────────────────────┐
 *                      Worker Node                              │
 * │                                                             │
 *  ┌─────────────────────────────────────────────────────┐    │
 *  │   Exec 能力                                          │    │
 *  │   - WebSocket Client (连接主节点)                     │    │
 *  │   - Pilot Agent                                     │    │
 *  │   - Session Manager                                 │    │
 *  └─────────────────────────────────────────────────────┘    │
 * │                                                             │
 *  特点：无通信能力，必须连接主节点                              │
 * └─────────────────────────────────────────────────────────────┘
 * ```
 *
 * @see Issue #1041 - Separate Worker Node code to @disclaude/worker-node
 */

import * as path from 'path';
import WebSocket from 'ws';
import { createLogger, type WorkerNodeConfig, type NodeCapabilities } from '@disclaude/core';
import {
  ScheduleManager,
  Scheduler,
  ScheduleFileWatcher,
} from './schedule/index.js';
import { FileClient } from './file-client/index.js';
import { WorkerIpcServer, createIpcToWsBridge } from './ipc/index.js';
import { createPilotCallbacks, type FeedbackContext } from './agents/pilot/callbacks-factory.js';
import type {
  WorkerNodeDependencies,
  ChatAgent,
  AgentPoolInterface,
  PilotCallbacks,
  MessageCallbacks,
  PromptMessage,
  CommandMessage,
  FeedbackMessage,
  CardActionMessage,
  FeishuApiResponseMessage,
  ScheduledTask,
} from './types.js';

const logger = createLogger('WorkerNode');

/**
 * Simple AgentPool implementation for WorkerNode.
 * Uses the injected createChatAgent factory.
 */
class WorkerAgentPool implements AgentPoolInterface {
  private readonly agents = new Map<string, ChatAgent>();
  private readonly createChatAgent: (chatId: string, callbacks: PilotCallbacks) => ChatAgent;
  private readonly log = logger;

  constructor(createChatAgent: (chatId: string, callbacks: PilotCallbacks) => ChatAgent) {
    this.createChatAgent = createChatAgent;
  }

  getOrCreateChatAgent(chatId: string, callbacks?: PilotCallbacks): ChatAgent {
    let agent = this.agents.get(chatId);
    if (!agent) {
      if (!callbacks) {
        throw new Error(`No callbacks provided for new ChatAgent for chatId: ${chatId}`);
      }
      this.log.info({ chatId }, 'Creating new ChatAgent instance for chatId');
      agent = this.createChatAgent(chatId, callbacks);
      this.agents.set(chatId, agent);
    }
    return agent;
  }

  reset(chatId: string, keepContext?: boolean): void {
    const agent = this.agents.get(chatId);
    if (agent) {
      this.log.debug({ chatId, keepContext }, 'Resetting ChatAgent for chatId');
      agent.reset(chatId, keepContext);
    }
  }

  stop(chatId: string): boolean {
    const agent = this.agents.get(chatId);
    if (agent) {
      this.log.debug({ chatId }, 'Stopping ChatAgent query for chatId');
      return agent.stop(chatId);
    }
    return false;
  }

  disposeAll(): void {
    this.log.info('Disposing all ChatAgent instances');
    const agents = Array.from(this.agents.entries());
    this.agents.clear();
    for (const [chatId, agent] of agents) {
      try {
        agent.dispose();
        this.log.debug({ chatId }, 'ChatAgent disposed');
      } catch (err) {
        this.log.error({ err, chatId }, 'Error disposing ChatAgent');
      }
    }
  }
}

/**
 * Worker Node Options.
 */
export interface WorkerNodeOptions {
  /** Node configuration */
  config: WorkerNodeConfig;
  /** Injected dependencies */
  dependencies: WorkerNodeDependencies;
}

/**
 * Worker Node - Execution-only node that connects to Primary Node.
 *
 * Responsibilities:
 * - Connects to Primary Node via WebSocket
 * - Executes Agent tasks assigned by Primary Node
 * - Reports results back to Primary Node
 */
export class WorkerNode {
  private nodeId: string;
  private nodeName: string;
  private primaryUrl: string;
  private reconnectInterval: number;

  private ws?: WebSocket;
  private running = false;
  private reconnectTimer?: NodeJS.Timeout;

  // File client for file transfer
  private fileClient: FileClient;

  // Dependencies (injected)
  private readonly deps: WorkerNodeDependencies;

  // AgentPool for per-chatId ChatAgent instances (Issue #644)
  private agentPool?: WorkerAgentPool;
  private activeFeedbackChannels = new Map<string, FeedbackContext>();

  // Issue #1036: Pending Feishu API requests (requestId -> handlers)
  private pendingFeishuApiRequests = new Map<string, {
    resolve: (data: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();
  private feishuApiRequestTimeout: number;

  // Issue #1042: IPC Server for MCP Server connections
  private ipcServer: WorkerIpcServer | null = null;

  // Scheduler
  private scheduler?: Scheduler;
  private scheduleFileWatcher?: ScheduleFileWatcher;
  private taskFlowOrchestrator?: {
    start(): Promise<void>;
    stop(): void;
  };

  constructor(options: WorkerNodeOptions) {
    const { config, dependencies } = options;
    this.deps = dependencies;

    this.nodeId = config.nodeId || `worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.nodeName = config.nodeName || `Worker-${this.nodeId.slice(0, 8)}`;
    this.primaryUrl = config.primaryUrl;
    this.reconnectInterval = config.reconnectInterval || 3000;
    this.feishuApiRequestTimeout = config.feishuApiRequestTimeout || 30000; // Default 30 seconds

    // Create FileClient for file transfer with Primary Node
    const primaryHttpUrl = this.primaryUrl.replace(/^ws/, 'http');
    this.fileClient = new FileClient({
      commNodeUrl: primaryHttpUrl,
      downloadDir: path.join(this.deps.getWorkspaceDir(), 'downloads'),
    });

    this.deps.logger.info({
      nodeId: this.nodeId,
      nodeName: this.nodeName,
      primaryUrl: this.primaryUrl,
    }, 'WorkerNode created');
  }

  /**
   * Get node capabilities.
   */
  getCapabilities(): NodeCapabilities {
    return {
      communication: false,
      execution: true,
    };
  }

  /**
   * Get node ID.
   */
  getNodeId(): string {
    return this.nodeId;
  }

  /**
   * Get node name.
   */
  getNodeName(): string {
    return this.nodeName;
  }

  /**
   * Initialize the AgentPool for per-chatId ChatAgent instances.
   *
   * Issue #644: Each chatId gets its own ChatAgent instance.
   */
  private async initPilot(): Promise<void> {
    console.log('Initializing execution capability...');

    // Issue #644: Create AgentPool with factory function
    this.agentPool = new WorkerAgentPool((_chatId: string, callbacks: PilotCallbacks) => {
      return this.deps.createChatAgent(_chatId, callbacks);
    });

    // Create a shared callbacks object that will be used for all agents
    // Issue #1396: Use factory function to reduce code duplication
    const createCallbacks = (_chatId: string): PilotCallbacks => {
      return createPilotCallbacks({
        feedbackChannels: this.activeFeedbackChannels,
        ws: this.ws,
        fileClient: this.fileClient,
        logger: this.deps.logger,
        verboseLogging: true,
      });
    };

    // Initialize Schedule Manager and Scheduler
    const workspaceDir = this.deps.getWorkspaceDir();
    const schedulesDir = path.join(workspaceDir, 'schedules');
    const scheduleManager = new ScheduleManager({ schedulesDir });

    // Issue #1041: Scheduler uses dependency injection for task execution
    this.scheduler = new Scheduler({
      scheduleManager,
      callbacks: {
        sendMessage: (chatId: string, message: string): Promise<void> => {
          const ctx = this.activeFeedbackChannels.get(chatId);
          if (ctx) {
            ctx.sendFeedback({ type: 'text', chatId, text: message, threadId: ctx.threadId });
          } else {
            // For scheduled tasks without active channel, send directly via WebSocket
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({ type: 'text', chatId, text: message }));
            }
          }
          return Promise.resolve();
        },
      },
      // Provide the executor function for dependency injection
      executor: async (chatId: string, prompt: string, userId?: string): Promise<void> => {
        // Issue #711: Create ScheduleAgent (short-lived, not in AgentPool)
        const callbacks = createCallbacks(chatId);
        const agent = this.deps.createScheduleAgent(chatId, callbacks);

        try {
          await agent.executeOnce(chatId, prompt, undefined, userId);
        } finally {
          agent.dispose();
        }
      },
    });

    // Initialize file watcher for hot reload
    this.scheduleFileWatcher = new ScheduleFileWatcher({
      schedulesDir,
      onFileAdded: (task: ScheduledTask) => {
        this.deps.logger.info({ taskId: task.id, name: task.name }, 'Schedule file added, adding to scheduler');
        this.scheduler?.addTask(task);
      },
      onFileChanged: (task: ScheduledTask) => {
        this.deps.logger.info({ taskId: task.id, name: task.name }, 'Schedule file changed, updating scheduler');
        this.scheduler?.addTask(task);
      },
      onFileRemoved: (taskId: string) => {
        this.deps.logger.info({ taskId }, 'Schedule file removed, removing from scheduler');
        this.scheduler?.removeTask(taskId);
      },
    });

    // Initialize TaskFlowOrchestrator using injected factory
    const messageCallbacks: MessageCallbacks = {
      sendMessage: (chatId: string, text: string, threadMessageId?: string): Promise<void> => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'text', chatId, text, threadId: threadMessageId }));
        } else {
          this.deps.logger.warn({ chatId }, 'Cannot send message: WebSocket not connected');
        }
        return Promise.resolve();
      },
      sendCard: (chatId: string, card: Record<string, unknown>, _description?: string, threadMessageId?: string): Promise<void> => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'card', chatId, card, threadId: threadMessageId }));
        } else {
          this.deps.logger.warn({ chatId }, 'Cannot send card: WebSocket not connected');
        }
        return Promise.resolve();
      },
      sendFile: (chatId: string, filePath: string): Promise<void> => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'file', chatId, filePath }));
        } else {
          this.deps.logger.warn({ chatId }, 'Cannot send file: WebSocket not connected');
        }
        return Promise.resolve();
      },
    };

    this.taskFlowOrchestrator = this.deps.createTaskFlowOrchestrator(messageCallbacks, this.deps.logger);

    // Start scheduler and file watcher
    await this.scheduler.start();
    await this.scheduleFileWatcher.start();
    await this.taskFlowOrchestrator.start();

    console.log('✓ Execution capability initialized');
    console.log('✓ Scheduler started');
    console.log('✓ Schedule file watcher started');
    console.log('✓ TaskFlowOrchestrator started');
  }

  /**
   * Connect to Primary Node.
   */
  private connectToPrimaryNode(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    this.deps.logger.info({ url: this.primaryUrl }, 'Connecting to Primary Node...');

    const ws = new WebSocket(this.primaryUrl);
    this.ws = ws;

    ws.on('open', () => {
      this.deps.logger.info('Connected to Primary Node');
      console.log('✓ Connected to Primary Node');

      // Send registration message
      const registerMsg = {
        type: 'register',
        nodeId: this.nodeId,
        name: this.nodeName,
      };
      ws.send(JSON.stringify(registerMsg));
      this.deps.logger.info({ nodeId: this.nodeId, name: this.nodeName }, 'Sent registration message');

      console.log();
    });

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString()) as PromptMessage | CommandMessage | CardActionMessage | FeishuApiResponseMessage;

        // Handle command messages
        if (message.type === 'command') {
          const { command, chatId } = message;
          this.deps.logger.info({ command, chatId }, 'Received command');

          try {
            if (command === 'reset' || command === 'restart') {
              // Issue #644: Reset Pilot via AgentPool
              this.agentPool?.reset(chatId);
              this.deps.logger.info({ chatId }, `Pilot ${command} executed for chatId`);
            }
          } catch (error) {
            const err = error as Error;
            this.deps.logger.error({ err, command, chatId }, 'Command execution failed');
          }
          return;
        }

        // Handle prompt messages
        if (message.type === 'prompt') {
          const { chatId, prompt, messageId, senderOpenId, threadId, attachments, chatHistoryContext } = message;
          this.deps.logger.info({ chatId, messageId, promptLength: prompt.length, threadId, hasAttachments: !!attachments, hasChatHistory: !!chatHistoryContext }, 'Received prompt');

          // Download attachments if present
          if (attachments && attachments.length > 0) {
            this.deps.logger.info({ chatId, attachmentCount: attachments.length }, 'Downloading attachments');
            for (const att of attachments) {
              try {
                const localPath = await this.fileClient.downloadToFile(att);
                att.localPath = localPath;
                this.deps.logger.info({ fileId: att.id, fileName: att.fileName, localPath }, 'Attachment downloaded');
              } catch (error) {
                this.deps.logger.error({ err: error, fileId: att.id, fileName: att.fileName }, 'Failed to download attachment');
              }
            }
          }

          // Create send feedback function
          const sendFeedback = (feedback: FeedbackMessage) => {
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify(feedback));
            }
          };

          // Register feedback channel for this chatId with threadId
          this.activeFeedbackChannels.set(chatId, { sendFeedback, threadId });

          try {
            // Issue #644: Get ChatAgent for this chatId from AgentPool
            // Issue #1396: Use factory function to create callbacks
            const callbacks = createPilotCallbacks({
              feedbackChannels: this.activeFeedbackChannels,
              ws: this.ws,
              fileClient: this.fileClient,
              logger: this.deps.logger,
            });

            const agent = this.agentPool?.getOrCreateChatAgent(chatId, callbacks);
            agent?.processMessage(chatId, prompt, messageId, senderOpenId, attachments, chatHistoryContext);
          } catch (error) {
            const err = error as Error;
            this.deps.logger.error({ err, chatId }, 'Execution failed');
            sendFeedback({ type: 'error', chatId, error: err.message, threadId });
            sendFeedback({ type: 'done', chatId, threadId });
          }
          return;
        }

        // Handle card action messages from Primary Node
        if (message.type === 'card_action') {
          const cardActionMsg = message as CardActionMessage;
          const { chatId, cardMessageId, actionType, actionValue, actionText, userId } = cardActionMsg;
          this.deps.logger.info(
            { chatId, cardMessageId, actionType, actionValue, userId },
            'Received card action from Primary Node'
          );

          // Get the agent for this chatId and process the card action
          const ctx = this.activeFeedbackChannels.get(chatId);
          if (ctx) {
            // Generate prompt from template if available
            const promptFromTemplate = this.deps.generateInteractionPrompt(
              cardMessageId,
              actionValue,
              actionText,
              actionType
            );

            // Use the template prompt if available, otherwise use default message
            const messageContent = promptFromTemplate || (() => {
              const buttonText = actionText || actionValue;
              return `User clicked '${buttonText}' button`;
            })();

            // Get the agent and process the card action as a message
            // Issue #1396: Use factory function to create callbacks
            const callbacks = createPilotCallbacks({
              feedbackChannels: this.activeFeedbackChannels,
              ws: this.ws,
              fileClient: this.fileClient,
              logger: this.deps.logger,
            });

            const agent = this.agentPool?.getOrCreateChatAgent(chatId, callbacks);
            if (agent) {
              agent.processMessage(
                chatId,
                messageContent,
                `${cardMessageId}-${actionValue}`,
                userId,
                undefined, // no attachments
                undefined  // no chat history context
              );
              this.deps.logger.debug({ chatId, cardMessageId }, 'Card action processed by agent');
            }
          } else {
            this.deps.logger.warn({ chatId }, 'No active feedback channel for card action');
          }
          return;
        }

        // Issue #1036: Handle Feishu API response from Primary Node
        if (message.type === 'feishu-api-response') {
          const apiResponse = message as FeishuApiResponseMessage;
          const { requestId, success, data, error } = apiResponse;
          const pending = this.pendingFeishuApiRequests.get(requestId);

          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingFeishuApiRequests.delete(requestId);

            if (success) {
              pending.resolve(data);
              this.deps.logger.debug({ requestId }, 'Feishu API request succeeded');
            } else {
              pending.reject(new Error(error || 'Unknown error'));
              this.deps.logger.debug({ requestId, error }, 'Feishu API request failed');
            }
          } else {
            this.deps.logger.warn({ requestId }, 'Received response for unknown Feishu API request');
          }
          return;
        }

        // Unknown message type
        this.deps.logger.warn({ type: (message as { type?: string }).type }, 'Unknown message type');
      } catch (error) {
        this.deps.logger.error({ err: error }, 'Failed to process message');
      }
    });

    ws.on('close', () => {
      this.deps.logger.info('Disconnected from Primary Node');
      console.log('Disconnected from Primary Node');

      // Clear active feedback channels on disconnect
      this.activeFeedbackChannels.clear();

      // Reconnect if still running
      if (this.running) {
        this.scheduleReconnect();
      }
    });

    ws.on('error', (error) => {
      this.deps.logger.error({ err: error }, 'WebSocket error');
    });
  }

  /**
   * Schedule reconnection to Primary Node.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      if (this.running) {
        this.connectToPrimaryNode();
      }
    }, this.reconnectInterval);
  }

  // ============================================================================
  // IPC Server (Issue #1042)
  // ============================================================================

  /**
   * Start the IPC server for MCP Server connections.
   *
   * The IPC server accepts connections from MCP Server child processes
   * and bridges their requests to the Primary Node via WebSocket.
   */
  private async startIpcServer(): Promise<void> {
    if (this.ipcServer) {
      this.deps.logger.warn('IPC server already running');
      return;
    }

    this.ipcServer = new WorkerIpcServer();

    // Set up request handler that bridges to Primary Node via WebSocket
    const requestHandler = createIpcToWsBridge(
      () => this.ws,
      { timeout: 30000 } // 30 second timeout
    );
    this.ipcServer.setRequestHandler(requestHandler);

    await this.ipcServer.start();

    // Set environment variable for child processes (MCP Server)
    const socketPath = this.ipcServer.getSocketPath();
    process.env.DISCLAUDE_WORKER_IPC_SOCKET = socketPath;

    this.deps.logger.info({ socketPath }, 'IPC server started for MCP Server connections');
    console.log(`✓ IPC server started at ${socketPath}`);
  }

  /**
   * Stop the IPC server.
   */
  private async stopIpcServer(): Promise<void> {
    if (!this.ipcServer) {
      return;
    }

    await this.ipcServer.stop();
    this.ipcServer = null;

    // Clear environment variable
    delete process.env.DISCLAUDE_WORKER_IPC_SOCKET;

    this.deps.logger.info('IPC server stopped');
  }

  /**
   * Start the Worker Node.
   */
  async start(): Promise<void> {
    if (this.running) {
      this.deps.logger.warn('WorkerNode already running');
      return;
    }

    this.running = true;

    console.log('Initializing Worker Node...');
    console.log('Mode: Worker (Execution only)');
    console.log(`Node ID: ${this.nodeId}`);
    console.log(`Node Name: ${this.nodeName}`);
    console.log(`Primary URL: ${this.primaryUrl}`);
    console.log();

    // Issue #1042: Start IPC server for MCP Server connections
    await this.startIpcServer();

    // Initialize Pilot
    await this.initPilot();

    // Connect to Primary Node
    this.connectToPrimaryNode();

    this.deps.logger.info('WorkerNode started');
  }

  /**
   * Stop the Worker Node.
   */
  stop(): void {
    if (!this.running) {return;}

    this.running = false;

    this.deps.logger.info('Shutting down Worker Node...');
    console.log('\nShutting down Worker Node...');

    // Stop file watcher
    this.scheduleFileWatcher?.stop();

    // Stop scheduler
    this.scheduler?.stop();

    // Stop task flow orchestrator
    this.taskFlowOrchestrator?.stop();

    // Issue #1042: Stop IPC server
    this.stopIpcServer().catch((err) => {
      this.deps.logger.error({ err }, 'Error stopping IPC server');
    });

    // Clear reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    // Close WebSocket connection
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }

    // Clear active feedback channels
    this.activeFeedbackChannels.clear();

    // Issue #1036: Clear pending Feishu API requests
    for (const [_requestId, pending] of this.pendingFeishuApiRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('WorkerNode is shutting down'));
    }
    this.pendingFeishuApiRequests.clear();

    this.deps.logger.info('WorkerNode stopped');
  }

  /**
   * Check if the node is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  // ============================================================================
  // Feishu API Request Routing (Issue #1036)
  // ============================================================================

  /**
   * Send a Feishu API request to the Primary Node.
   * This allows Worker Node to make Feishu API calls through the Primary Node's LarkClientService.
   *
   * @param action - The action to perform (sendMessage, sendCard, uploadFile, getBotInfo)
   * @param params - Action parameters
   * @returns Promise that resolves with the response data
   */
  sendFeishuApiRequest(
    action: 'sendMessage' | 'sendCard' | 'uploadFile' | 'getBotInfo',
    params: {
      chatId?: string;
      text?: string;
      card?: Record<string, unknown>;
      filePath?: string;
      threadId?: string;
      description?: string;
    }
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      // Check WebSocket connection
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected to Primary Node'));
        return;
      }

      // Generate unique request ID
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Set up timeout
      const timeout = setTimeout(() => {
        this.pendingFeishuApiRequests.delete(requestId);
        reject(new Error(`Feishu API request timeout after ${this.feishuApiRequestTimeout}ms`));
      }, this.feishuApiRequestTimeout);

      // Store pending request
      this.pendingFeishuApiRequests.set(requestId, {
        resolve: resolve as (data: unknown) => void,
        reject,
        timeout,
      });

      // Send request
      const request = {
        type: 'feishu-api-request',
        requestId,
        action,
        params,
      };

      this.ws.send(JSON.stringify(request));
      this.deps.logger.debug({ requestId, action }, 'Feishu API request sent to Primary Node');
    });
  }

  /**
   * Send a text message through the Primary Node.
   * Convenience wrapper for sendFeishuApiRequest.
   *
   * @param chatId - Target chat ID
   * @param text - Message text
   * @param threadId - Optional thread ID for threaded replies
   */
  async sendFeishuMessage(chatId: string, text: string, threadId?: string): Promise<void> {
    await this.sendFeishuApiRequest('sendMessage', { chatId, text, threadId });
  }

  /**
   * Send an interactive card through the Primary Node.
   * Convenience wrapper for sendFeishuApiRequest.
   *
   * @param chatId - Target chat ID
   * @param card - Card JSON object
   * @param threadId - Optional thread ID for threaded replies
   * @param description - Optional card description
   */
  async sendFeishuCard(
    chatId: string,
    card: Record<string, unknown>,
    threadId?: string,
    description?: string
  ): Promise<void> {
    await this.sendFeishuApiRequest('sendCard', { chatId, card, threadId, description });
  }

  /**
   * Upload a file through the Primary Node.
   * Convenience wrapper for sendFeishuApiRequest.
   *
   * @param chatId - Target chat ID
   * @param filePath - Local file path
   * @param threadId - Optional thread ID for threaded replies
   */
  async sendFeishuFile(chatId: string, filePath: string, threadId?: string): Promise<unknown> {
    return await this.sendFeishuApiRequest('uploadFile', { chatId, filePath, threadId });
  }

  /**
   * Get bot information through the Primary Node.
   * Convenience wrapper for sendFeishuApiRequest.
   */
  async getFeishuBotInfo(): Promise<unknown> {
    return await this.sendFeishuApiRequest('getBotInfo', {});
  }
}
