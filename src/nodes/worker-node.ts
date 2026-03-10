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
import { Config } from '../config/index.js';
import { AgentFactory, AgentPool } from '../agents/index.js';
import { createLogger } from '@disclaude/core';
import {
  ScheduleManager,
  Scheduler,
  ScheduleFileWatcher,
} from '@disclaude/worker-node';
import { TaskFlowOrchestrator } from '../feishu/task-flow-orchestrator.js';
import { TaskTracker } from '../utils/task-tracker.js';
import type { PromptMessage, CommandMessage, FeedbackMessage, RegisterMessage, CardActionMessage, FeishuApiResponseMessage } from '../types/websocket-messages.js';
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

  // Issue #1036: Pending Feishu API requests (requestId -> handlers)
  private pendingFeishuApiRequests = new Map<string, {
    resolve: (data: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();
  private feishuApiRequestTimeout: number;

  // Scheduler
  private scheduler?: Scheduler;
  private scheduleFileWatcher?: ScheduleFileWatcher;
  private taskFlowOrchestrator?: TaskFlowOrchestrator;

  constructor(config: WorkerNodeConfig) {
    this.nodeId = config.nodeId || `worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.nodeName = config.nodeName || `Worker-${this.nodeId.slice(0, 8)}`;
    this.primaryUrl = config.primaryUrl;
    this.reconnectInterval = config.reconnectInterval || 3000;
    this.feishuApiRequestTimeout = config.feishuApiRequestTimeout || 30000; // Default 30 seconds

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
   * Initialize the AgentPool for per-chatId ChatAgent instances.
   *
   * Issue #644: Each chatId gets its own ChatAgent instance.
   */
  private async initPilot(): Promise<void> {
    console.log('Initializing execution capability...');

    // Issue #644: Create AgentPool with factory function
    this.agentPool = new AgentPool({
      chatAgentFactory: (chatId: string) => {
        return AgentFactory.createChatAgent('pilot', chatId, {
          sendMessage: (chatId: string, text: string, threadMessageId?: string): Promise<void> => {
            const ctx = this.activeFeedbackChannels.get(chatId);
            if (ctx) {
              ctx.sendFeedback({ type: 'text', chatId, text, threadId: threadMessageId || ctx.threadId });
            } else {
              // Issue #935: Fallback to direct WebSocket send when no active feedback channel
              // This enables Worker Node to send messages proactively (e.g., from scheduled tasks)
              if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'text', chatId, text, threadId: threadMessageId }));
                logger.debug({ chatId }, 'Message sent via WebSocket fallback');
              } else {
                logger.warn({ chatId }, 'No active feedback channel and WebSocket not connected for sendMessage');
              }
            }
            return Promise.resolve();
          },
          sendCard: (chatId: string, card: Record<string, unknown>, description?: string, threadMessageId?: string): Promise<void> => {
            const ctx = this.activeFeedbackChannels.get(chatId);
            if (ctx) {
              ctx.sendFeedback({ type: 'card', chatId, card, text: description, threadId: threadMessageId || ctx.threadId });
            } else {
              // Issue #935: Fallback to direct WebSocket send when no active feedback channel
              if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'card', chatId, card, text: description, threadId: threadMessageId }));
                logger.debug({ chatId }, 'Card sent via WebSocket fallback');
              } else {
                logger.warn({ chatId }, 'No active feedback channel and WebSocket not connected for sendCard');
              }
            }
            return Promise.resolve();
          },
          sendFile: async (chatId: string, filePath: string) => {
            const ctx = this.activeFeedbackChannels.get(chatId);

            try {
              // Upload file to Primary Node
              const fileRef = await this.fileClient.uploadFile(filePath, chatId);

              if (ctx) {
                // Send fileRef to Primary Node via active feedback channel
                ctx.sendFeedback({
                  type: 'file',
                  chatId,
                  fileRef,
                  fileName: fileRef.fileName,
                  fileSize: fileRef.size,
                  mimeType: fileRef.mimeType,
                  threadId: ctx.threadId,
                });
              } else {
                // Issue #935: Fallback to direct WebSocket send when no active feedback channel
                if (this.ws?.readyState === WebSocket.OPEN) {
                  this.ws.send(JSON.stringify({
                    type: 'file',
                    chatId,
                    fileRef,
                    fileName: fileRef.fileName,
                    fileSize: fileRef.size,
                    mimeType: fileRef.mimeType,
                  }));
                  logger.debug({ chatId }, 'File sent via WebSocket fallback');
                } else {
                  logger.warn({ chatId }, 'No active feedback channel and WebSocket not connected for sendFile');
                }
              }
            } catch (error) {
              logger.error({ err: error, chatId, filePath }, 'Failed to upload file');
              if (ctx) {
                ctx.sendFeedback({
                  type: 'error',
                  chatId,
                  error: `Failed to send file: ${(error as Error).message}`,
                  threadId: ctx.threadId,
                });
              } else if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({
                  type: 'error',
                  chatId,
                  error: `Failed to send file: ${(error as Error).message}`,
                }));
              }
            }
          },
          onDone: (chatId: string, threadMessageId?: string): Promise<void> => {
            const ctx = this.activeFeedbackChannels.get(chatId);
            if (ctx) {
              ctx.sendFeedback({ type: 'done', chatId, threadId: threadMessageId || ctx.threadId });
              logger.info({ chatId }, 'Task completed, sent done signal');
            } else {
              // Issue #935: Fallback to direct WebSocket send when no active feedback channel
              if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'done', chatId, threadId: threadMessageId }));
                logger.debug({ chatId }, 'Done signal sent via WebSocket fallback');
              } else {
                logger.warn({ chatId }, 'No active feedback channel and WebSocket not connected for onDone');
              }
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
    // Issue #1041: Scheduler uses dependency injection for task execution
    this.scheduler = new Scheduler({
      scheduleManager,
      callbacks: {
        sendMessage: async (chatId: string, message: string) => {
          const ctx = this.activeFeedbackChannels.get(chatId);
          if (ctx) {
            ctx.sendFeedback({ type: 'text', chatId, text: message, threadId: ctx.threadId });
          } else {
            // For scheduled tasks without active channel, send directly via WebSocket
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({ type: 'text', chatId, text: message }));
            }
          }
        },
      },
      // Provide the executor function for dependency injection
      executor: async (chatId: string, prompt: string, userId?: string): Promise<void> => {
        // Issue #711: Create ScheduleAgent (short-lived, not in AgentPool)
        const agent = AgentFactory.createScheduleAgent(chatId, {
          sendMessage: async (chatId_: string, text: string, parentMessageId?: string) => {
            const ctx = this.activeFeedbackChannels.get(chatId_);
            if (ctx) {
              ctx.sendFeedback({ type: 'text', chatId: chatId_, text, threadId: parentMessageId ?? ctx.threadId });
            } else {
              if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'text', chatId: chatId_, text, threadId: parentMessageId }));
              }
            }
          },
          sendCard: async (chatId_: string, card: Record<string, unknown>, description?: string, parentMessageId?: string) => {
            const ctx = this.activeFeedbackChannels.get(chatId_);
            if (ctx) {
              ctx.sendFeedback({ type: 'card', chatId: chatId_, card, text: description, threadId: parentMessageId ?? ctx.threadId });
            } else {
              if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'card', chatId: chatId_, card, text: description, threadId: parentMessageId }));
              }
            }
          },
          sendFile: async (chatId_: string, filePath: string) => {
            const ctx = this.activeFeedbackChannels.get(chatId_);
            if (ctx) {
              try {
                const fileRef = await this.fileClient.uploadFile(filePath, chatId_);
                ctx.sendFeedback({
                  type: 'file',
                  chatId: chatId_,
                  fileRef,
                  fileName: fileRef.fileName,
                  fileSize: fileRef.size,
                  mimeType: fileRef.mimeType,
                  threadId: ctx.threadId,
                });
              } catch (error) {
                logger.error({ err: error, chatId: chatId_, filePath }, 'Failed to upload file');
                ctx.sendFeedback({
                  type: 'error',
                  chatId: chatId_,
                  error: `Failed to send file: ${(error as Error).message}`,
                  threadId: ctx.threadId,
                });
              }
            } else {
              try {
                const fileRef = await this.fileClient.uploadFile(filePath, chatId_);
                if (this.ws?.readyState === WebSocket.OPEN) {
                  this.ws.send(JSON.stringify({
                    type: 'file',
                    chatId: chatId_,
                    fileRef,
                    fileName: fileRef.fileName,
                    fileSize: fileRef.size,
                    mimeType: fileRef.mimeType,
                  }));
                }
              } catch (error) {
                logger.error({ err: error, chatId: chatId_, filePath }, 'Failed to upload file for scheduled task');
              }
            }
          },
        });

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
        const message = JSON.parse(data.toString()) as PromptMessage | CommandMessage | CardActionMessage | FeishuApiResponseMessage;

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
            // Issue #644: Get ChatAgent for this chatId from AgentPool
            const agent = this.agentPool?.getOrCreateChatAgent(chatId);
            agent?.processMessage(chatId, prompt, messageId, senderOpenId, attachments, chatHistoryContext);
          } catch (error) {
            const err = error as Error;
            logger.error({ err, chatId }, 'Execution failed');
            sendFeedback({ type: 'error', chatId, error: err.message, threadId });
            sendFeedback({ type: 'done', chatId, threadId });
          }
          return;
        }

        // Handle card action messages from Primary Node
        if (message.type === 'card_action') {
          const cardActionMsg = message as CardActionMessage;
          const { chatId, cardMessageId, actionType, actionValue, actionText, userId } = cardActionMsg;
          logger.info(
            { chatId, cardMessageId, actionType, actionValue, userId },
            'Received card action from Primary Node'
          );

          // Import the necessary functions to handle card actions
          const { generateInteractionPrompt } = await import('../mcp/tools/interactive-message.js');

          // Get the agent for this chatId and process the card action
          const ctx = this.activeFeedbackChannels.get(chatId);
          if (ctx) {
            // Generate prompt from template if available
            const promptFromTemplate = generateInteractionPrompt(
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
            const agent = this.agentPool?.getOrCreateChatAgent(chatId);
            if (agent) {
              agent.processMessage(
                chatId,
                messageContent,
                `${cardMessageId}-${actionValue}`,
                userId,
                undefined, // no attachments
                undefined  // no chat history context
              );
              logger.debug({ chatId, cardMessageId }, 'Card action processed by agent');
            }
          } else {
            logger.warn({ chatId }, 'No active feedback channel for card action');
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
              logger.debug({ requestId }, 'Feishu API request succeeded');
            } else {
              pending.reject(new Error(error || 'Unknown error'));
              logger.debug({ requestId, error }, 'Feishu API request failed');
            }
          } else {
            logger.warn({ requestId }, 'Received response for unknown Feishu API request');
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

    // Issue #1036: Clear pending Feishu API requests
    for (const [_requestId, pending] of this.pendingFeishuApiRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('WorkerNode is shutting down'));
    }
    this.pendingFeishuApiRequests.clear();

    logger.info('WorkerNode stopped');
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
      logger.debug({ requestId, action }, 'Feishu API request sent to Primary Node');
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
