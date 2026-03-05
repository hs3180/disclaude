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
 */

import * as path from 'path';
import WebSocket from 'ws';
import { Config } from '../config/index.js';
import { AgentFactory, AgentPool } from '../agents/index.js';
import { createLogger } from '../utils/logger.js';
import {
  ScheduleManager,
  Scheduler,
  ScheduleFileWatcher,
} from '../schedule/index.js';
import { TaskFlowOrchestrator } from '../feishu/task-flow-orchestrator.js';
import { TaskTracker } from '../utils/task-tracker.js';
import type { PromptMessage, CommandMessage, FeedbackMessage, RegisterMessage } from '../types/websocket-messages.js';
import { FileClient } from '../file-transfer/node-transfer/file-client.js';
import type { WorkerNodeConfig, NodeCapabilities } from './types.js';

const logger = createLogger('WorkerNode');

/**
 * Feedback context for execution.
 */
interface FeedbackContext {
  sendFeedback: (feedback: FeedbackMessage) => void;
  threadId?: string;
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

  // AgentPool for per-chatId Pilot instances (Issue #644)
  private agentPool?: AgentPool;
  private activeFeedbackChannels = new Map<string, FeedbackContext>();

  // Scheduler
  private scheduler?: Scheduler;
  private scheduleFileWatcher?: ScheduleFileWatcher;
  private taskFlowOrchestrator?: TaskFlowOrchestrator;

  constructor(config: WorkerNodeConfig) {
    this.nodeId = config.nodeId || `worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.nodeName = config.nodeName || `Worker-${this.nodeId.slice(0, 8)}`;
    this.primaryUrl = config.primaryUrl;
    this.reconnectInterval = config.reconnectInterval || 3000;

    // Create FileClient for file transfer with Primary Node
    const primaryHttpUrl = this.primaryUrl.replace(/^ws/, 'http');
    this.fileClient = new FileClient({
      commNodeUrl: primaryHttpUrl,
      downloadDir: path.join(Config.getWorkspaceDir(), 'downloads'),
    });

    logger.info({
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
   * Initialize the AgentPool for per-chatId Pilot instances.
   *
   * Issue #644: Each chatId gets its own Pilot instance.
   */
  private async initPilot(): Promise<void> {
    console.log('Initializing execution capability...');

    // Issue #644: Create AgentPool with factory function
    this.agentPool = new AgentPool({
      pilotFactory: (chatId: string) => {
        return AgentFactory.createChatAgent('pilot', chatId, {
          sendMessage: (chatId: string, text: string, threadMessageId?: string): Promise<void> => {
            const ctx = this.activeFeedbackChannels.get(chatId);
            if (ctx) {
              ctx.sendFeedback({ type: 'text', chatId, text, threadId: threadMessageId || ctx.threadId });
            } else {
              logger.warn({ chatId }, 'No active feedback channel for sendMessage');
            }
            return Promise.resolve();
          },
          sendCard: (chatId: string, card: Record<string, unknown>, description?: string, threadMessageId?: string): Promise<void> => {
            const ctx = this.activeFeedbackChannels.get(chatId);
            if (ctx) {
              ctx.sendFeedback({ type: 'card', chatId, card, text: description, threadId: threadMessageId || ctx.threadId });
            } else {
              logger.warn({ chatId }, 'No active feedback channel for sendCard');
            }
            return Promise.resolve();
          },
          sendFile: async (chatId: string, filePath: string) => {
            const ctx = this.activeFeedbackChannels.get(chatId);
            if (!ctx) {
              logger.warn({ chatId }, 'No active feedback channel for sendFile');
              return;
            }

            try {
              // Upload file to Primary Node
              const fileRef = await this.fileClient.uploadFile(filePath, chatId);

              // Send fileRef to Primary Node
              ctx.sendFeedback({
                type: 'file',
                chatId,
                fileRef,
                fileName: fileRef.fileName,
                fileSize: fileRef.size,
                mimeType: fileRef.mimeType,
                threadId: ctx.threadId,
              });
            } catch (error) {
              logger.error({ err: error, chatId, filePath }, 'Failed to upload file');
              ctx.sendFeedback({
                type: 'error',
                chatId,
                error: `Failed to send file: ${(error as Error).message}`,
                threadId: ctx.threadId,
              });
            }
          },
          onDone: (chatId: string, threadMessageId?: string): Promise<void> => {
            const ctx = this.activeFeedbackChannels.get(chatId);
            if (ctx) {
              ctx.sendFeedback({ type: 'done', chatId, threadId: threadMessageId || ctx.threadId });
              logger.info({ chatId }, 'Task completed, sent done signal');
            } else {
              logger.warn({ chatId }, 'No active feedback channel for onDone');
            }
            return Promise.resolve();
          },
        });
      },
    });

    // Initialize Schedule Manager and Scheduler
    const workspaceDir = Config.getWorkspaceDir();
    const schedulesDir = path.join(workspaceDir, 'schedules');
    const scheduleManager = new ScheduleManager({ schedulesDir });
    this.scheduler = new Scheduler({
      scheduleManager,
      agentPool: this.agentPool,
      callbacks: {
        sendMessage: (chatId: string, text: string, threadMessageId?: string): Promise<void> => {
          const ctx = this.activeFeedbackChannels.get(chatId);
          if (ctx) {
            ctx.sendFeedback({ type: 'text', chatId, text, threadId: threadMessageId || ctx.threadId });
          } else {
            // For scheduled tasks without active channel, send directly via WebSocket
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({ type: 'text', chatId, text, threadId: threadMessageId }));
            }
          }
          return Promise.resolve();
        },
        sendCard: (chatId: string, card: Record<string, unknown>, description?: string, threadMessageId?: string): Promise<void> => {
          const ctx = this.activeFeedbackChannels.get(chatId);
          if (ctx) {
            ctx.sendFeedback({ type: 'card', chatId, card, text: description, threadId: threadMessageId || ctx.threadId });
          } else {
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({ type: 'card', chatId, card, text: description, threadId: threadMessageId }));
            }
          }
          return Promise.resolve();
        },
        sendFile: async (chatId: string, filePath: string) => {
          const ctx = this.activeFeedbackChannels.get(chatId);
          if (ctx) {
            try {
              const fileRef = await this.fileClient.uploadFile(filePath, chatId);
              ctx.sendFeedback({
                type: 'file',
                chatId,
                fileRef,
                fileName: fileRef.fileName,
                fileSize: fileRef.size,
                mimeType: fileRef.mimeType,
                threadId: ctx.threadId,
              });
            } catch (error) {
              logger.error({ err: error, chatId, filePath }, 'Failed to upload file');
              ctx.sendFeedback({
                type: 'error',
                chatId,
                error: `Failed to send file: ${(error as Error).message}`,
                threadId: ctx.threadId,
              });
            }
          } else {
            try {
              const fileRef = await this.fileClient.uploadFile(filePath, chatId);
              if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({
                  type: 'file',
                  chatId,
                  fileRef,
                  fileName: fileRef.fileName,
                  fileSize: fileRef.size,
                  mimeType: fileRef.mimeType,
                }));
              }
            } catch (error) {
              logger.error({ err: error, chatId, filePath }, 'Failed to upload file for scheduled task');
            }
          }
        },
      },
    });

    // Initialize file watcher for hot reload
    this.scheduleFileWatcher = new ScheduleFileWatcher({
      schedulesDir,
      onFileAdded: (task) => {
        logger.info({ taskId: task.id, name: task.name }, 'Schedule file added, adding to scheduler');
        this.scheduler?.addTask(task);
      },
      onFileChanged: (task) => {
        logger.info({ taskId: task.id, name: task.name }, 'Schedule file changed, updating scheduler');
        this.scheduler?.addTask(task);
      },
      onFileRemoved: (taskId) => {
        logger.info({ taskId }, 'Schedule file removed, removing from scheduler');
        this.scheduler?.removeTask(taskId);
      },
    });

    // Initialize TaskFlowOrchestrator
    const taskTracker = new TaskTracker();
    this.taskFlowOrchestrator = new TaskFlowOrchestrator(
      taskTracker,
      {
        sendMessage: (chatId: string, text: string, threadMessageId?: string): Promise<void> => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'text', chatId, text, threadId: threadMessageId }));
          } else {
            logger.warn({ chatId }, 'Cannot send message: WebSocket not connected');
          }
          return Promise.resolve();
        },
        sendCard: (chatId: string, card: Record<string, unknown>, _description?: string, threadMessageId?: string): Promise<void> => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'card', chatId, card, threadId: threadMessageId }));
          } else {
            logger.warn({ chatId }, 'Cannot send card: WebSocket not connected');
          }
          return Promise.resolve();
        },
        sendFile: (chatId: string, filePath: string): Promise<void> => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'file', chatId, filePath }));
          } else {
            logger.warn({ chatId }, 'Cannot send file: WebSocket not connected');
          }
          return Promise.resolve();
        },
      },
      logger
    );

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

    logger.info({ url: this.primaryUrl }, 'Connecting to Primary Node...');

    this.ws = new WebSocket(this.primaryUrl);

    this.ws.on('open', () => {
      logger.info('Connected to Primary Node');
      console.log('✓ Connected to Primary Node');

      // Send registration message
      const registerMsg: RegisterMessage = {
        type: 'register',
        nodeId: this.nodeId,
        name: this.nodeName,
      };
      this.ws!.send(JSON.stringify(registerMsg));
      logger.info({ nodeId: this.nodeId, name: this.nodeName }, 'Sent registration message');

      console.log();
    });

    this.ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString()) as PromptMessage | CommandMessage;

        // Handle command messages
        if (message.type === 'command') {
          const { command, chatId } = message;
          logger.info({ command, chatId }, 'Received command');

          try {
            if (command === 'reset' || command === 'restart') {
              // Issue #644: Reset Pilot via AgentPool
              this.agentPool?.reset(chatId);
              logger.info({ chatId }, `Pilot ${command} executed for chatId`);
            }
          } catch (error) {
            const err = error as Error;
            logger.error({ err, command, chatId }, 'Command execution failed');
          }
          return;
        }

        // Handle prompt messages
        if (message.type === 'prompt') {
          const { chatId, prompt, messageId, senderOpenId, threadId, attachments, chatHistoryContext } = message;
          logger.info({ chatId, messageId, promptLength: prompt.length, threadId, hasAttachments: !!attachments, hasChatHistory: !!chatHistoryContext }, 'Received prompt');

          // Download attachments if present
          if (attachments && attachments.length > 0) {
            logger.info({ chatId, attachmentCount: attachments.length }, 'Downloading attachments');
            for (const att of attachments) {
              try {
                const localPath = await this.fileClient.downloadToFile(att);
                att.localPath = localPath;
                logger.info({ fileId: att.id, fileName: att.fileName, localPath }, 'Attachment downloaded');
              } catch (error) {
                logger.error({ err: error, fileId: att.id, fileName: att.fileName }, 'Failed to download attachment');
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
            // Issue #644: Get Pilot for this chatId from AgentPool
            // Issue #711: Use getOrCreateChatAgent() for ChatAgent management
            const pilot = this.agentPool?.getOrCreateChatAgent(chatId);
            pilot?.processMessage(chatId, prompt, messageId, senderOpenId, attachments, chatHistoryContext);
          } catch (error) {
            const err = error as Error;
            logger.error({ err, chatId }, 'Execution failed');
            sendFeedback({ type: 'error', chatId, error: err.message, threadId });
            sendFeedback({ type: 'done', chatId, threadId });
          }
          return;
        }

        // Unknown message type
        logger.warn({ type: (message as { type?: string }).type }, 'Unknown message type');
      } catch (error) {
        logger.error({ err: error }, 'Failed to process message');
      }
    });

    this.ws.on('close', () => {
      logger.info('Disconnected from Primary Node');
      console.log('Disconnected from Primary Node');

      // Clear active feedback channels on disconnect
      this.activeFeedbackChannels.clear();

      // Reconnect if still running
      if (this.running) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (error) => {
      logger.error({ err: error }, 'WebSocket error');
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

  /**
   * Start the Worker Node.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('WorkerNode already running');
      return;
    }

    this.running = true;

    console.log('Initializing Worker Node...');
    console.log('Mode: Worker (Execution only)');
    console.log(`Node ID: ${this.nodeId}`);
    console.log(`Node Name: ${this.nodeName}`);
    console.log(`Primary URL: ${this.primaryUrl}`);
    console.log();

    // Initialize Pilot
    await this.initPilot();

    // Connect to Primary Node
    this.connectToPrimaryNode();

    logger.info('WorkerNode started');
  }

  /**
   * Stop the Worker Node.
   */
  stop(): void {
    if (!this.running) {return;}

    this.running = false;

    logger.info('Shutting down Worker Node...');
    console.log('\nShutting down Worker Node...');

    // Stop file watcher
    this.scheduleFileWatcher?.stop();

    // Stop scheduler
    this.scheduler?.stop();

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

    logger.info('WorkerNode stopped');
  }

  /**
   * Check if the node is running.
   */
  isRunning(): boolean {
    return this.running;
  }
}
