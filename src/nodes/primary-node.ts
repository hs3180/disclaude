/**
 * Primary Node - Main node with both communication and execution capabilities.
 *
 * This self-contained node can:
 * - Handle multiple communication channels (Feishu, REST, etc.)
 * - Execute Agent tasks locally
 * - Accept connections from Worker Nodes for horizontal scaling
 *
 * Architecture (Refactored - Issue #435):
 * ```
 * ┌─────────────────────────────────────────────────────────────┐
 *                      Primary Node                             │
 * │                                                             │
 *  ┌─────────────────────────────────────────────────────────┐  │
 *  │                    Coordination Layer                     │  │
 *  │   - Lifecycle management (start/stop)                     │  │
 *  │   - Channel registration                                   │  │
 *  │   - Local execution setup                                  │  │
 *  └─────────────────────────────────────────────────────────┘  │
 * │                                                             │
 *  ┌───────────────┐ ┌───────────────┐ ┌───────────────────┐   │
 *  │ExecNodeRegistry│ │FeedbackRouter│ │WebSocketServerSvc │   │
 *  └───────────────┘ └───────────────┘ └───────────────────┘   │
 * │                                                             │
 *  ┌─────────────────────────────────────────────────────────┐  │
 *  │              SchedulerService + LocalExecution           │  │
 *  └─────────────────────────────────────────────────────────┘  │
 * └─────────────────────────────────────────────────────────────┘
 * ```
 */

import { EventEmitter } from 'events';
import * as lark from '@larksuiteoapi/node-sdk';
import { Config } from '../config/index.js';
import { AgentFactory } from '../agents/index.js';
import { createLogger } from '../utils/logger.js';
import type { IChannel, IncomingMessage, ControlCommand, ControlResponse } from '../channels/index.js';
import { FeishuChannel } from '../channels/feishu-channel.js';
import { RestChannel } from '../channels/rest-channel.js';
import type { PromptMessage, CommandMessage, FeedbackMessage } from '../types/websocket-messages.js';
import type { FileRef } from '../file-transfer/types.js';
import type { FileStorageConfig } from '../file-transfer/node-transfer/file-storage.js';
import { TaskFlowOrchestrator } from '../feishu/task-flow-orchestrator.js';
import { TaskTracker } from '../utils/task-tracker.js';
import { ExecNodeRegistry } from './exec-node-registry.js';
import { SchedulerService } from './scheduler-service.js';
import { FeedbackRouter } from './feedback-router.js';
import { WebSocketServerService } from './websocket-server-service.js';
import type { PrimaryNodeConfig, NodeCapabilities } from './types.js';
// Group management (Issue #486)
import {
  createDiscussionChat,
  dissolveChat,
  addMembers,
  removeMembers,
  getMembers,
} from '../platforms/feishu/chat-ops.js';
import { GroupService, getGroupService } from '../platforms/feishu/group-service.js';
import { createFeishuClient } from '../platforms/feishu/create-feishu-client.js';
// Debug group (Issue #487)
import { getDebugGroupService } from './debug-group-service.js';
// Command system (Issue #463)
import {
  getCommandRegistry,
  registerDefaultCommands,
} from './commands/index.js';
// Welcome service (Issue #463)
import {
  initWelcomeService,
} from '../platforms/feishu/welcome-service.js';

const logger = createLogger('PrimaryNode');

/**
 * Feedback context for execution.
 */
interface FeedbackContext {
  sendFeedback: (feedback: FeedbackMessage) => void;
  threadId?: string;
}

/**
 * Primary Node - Self-contained node with both communication and execution capabilities.
 *
 * Responsibilities (after refactoring):
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
  private port: number;
  private host: string;
  private running = false;

  // Node configuration
  private localNodeId: string;
  private localExecEnabled: boolean;
  private fileStorageConfig?: FileStorageConfig;

  // Services (refactored)
  private execNodeRegistry: ExecNodeRegistry;
  private feedbackRouter: FeedbackRouter;
  private wsServerService?: WebSocketServerService;
  private schedulerService?: SchedulerService;

  // Local execution
  private sharedPilot?: ReturnType<typeof AgentFactory.createChatAgent>;
  private activeFeedbackChannels = new Map<string, FeedbackContext>();
  private taskFlowOrchestrator?: TaskFlowOrchestrator;

  // Group management (Issue #486)
  private groupService: GroupService;
  private feishuClient?: lark.Client;
  private feishuAppId?: string;
  private feishuAppSecret?: string;

  constructor(config: PrimaryNodeConfig) {
    super();
    this.port = config.port || 3001;
    this.host = config.host || '0.0.0.0';
    this.localNodeId = config.nodeId || `primary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.localExecEnabled = config.enableLocalExec !== false;
    this.fileStorageConfig = config.fileStorage;

    // Initialize GroupService
    this.groupService = getGroupService();

    // Store Feishu credentials for group management
    this.feishuAppId = config.appId || Config.FEISHU_APP_ID;
    this.feishuAppSecret = config.appSecret || Config.FEISHU_APP_SECRET;

    // Initialize ExecNodeRegistry
    this.execNodeRegistry = new ExecNodeRegistry({
      localNodeId: this.localNodeId,
      localExecEnabled: this.localExecEnabled,
    });

    // Forward registry events
    this.execNodeRegistry.on('node:registered', (nodeId) => this.emit('worker:connected', nodeId));
    this.execNodeRegistry.on('node:unregistered', (nodeId) => this.emit('worker:disconnected', nodeId));

    // Initialize FeedbackRouter
    this.feedbackRouter = new FeedbackRouter({
      sendFileToUser: this.sendFileToUser.bind(this),
    });

    // Issue #463: Initialize CommandRegistry with default commands
    const commandRegistry = getCommandRegistry();
    registerDefaultCommands(commandRegistry, () => commandRegistry.generateHelpText());

    // Register custom channels if provided
    if (config.channels) {
      for (const channel of config.channels) {
        this.registerChannel(channel);
      }
    }

    // Create Feishu channel (for backward compatibility)
    const appId = config.appId || Config.FEISHU_APP_ID;
    const appSecret = config.appSecret || Config.FEISHU_APP_SECRET;
    if (appId && appSecret) {
      const feishuChannel = new FeishuChannel({
        id: 'feishu',
        appId,
        appSecret,
      });

      // Initialize TaskFlowOrchestrator for Feishu channel
      void feishuChannel.initTaskFlowOrchestrator({
        sendMessage: this.sendMessage.bind(this),
        sendCard: this.sendCard.bind(this),
        sendFile: this.sendFileToUser.bind(this),
      });

      // Issue #463: Initialize WelcomeService and set to FeishuChannel
      const welcomeService = initWelcomeService({
        generateWelcomeMessage: () => commandRegistry.generateWelcomeMessage(),
        sendMessage: this.sendMessage.bind(this),
      });
      feishuChannel.setWelcomeService(welcomeService);

      this.registerChannel(feishuChannel);
      logger.info('Feishu channel registered');
    }

    // Create REST channel if enabled
    if (config.enableRestChannel !== false) {
      const restChannel = new RestChannel({
        id: 'rest',
        port: config.restPort || 3000,
        authToken: config.restAuthToken,
      });
      this.registerChannel(restChannel);
      logger.info({ port: config.restPort || 3000 }, 'REST channel registered');
    }

    logger.info({
      port: this.port,
      host: this.host,
      nodeId: this.localNodeId,
      localExecEnabled: this.localExecEnabled
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
   * Get or create Feishu client for group management with timeout configuration.
   */
  private getFeishuClient(): lark.Client {
    if (!this.feishuClient) {
      if (!this.feishuAppId || !this.feishuAppSecret) {
        throw new Error('Feishu credentials not configured');
      }
      this.feishuClient = createFeishuClient(this.feishuAppId, this.feishuAppSecret);
    }
    return this.feishuClient;
  }

  // ============================================================================
  // Channel Management
  // ============================================================================

  /**
   * Register a communication channel.
   */
  registerChannel(channel: IChannel): void {
    if (this.feedbackRouter.getChannels().some(c => c.id === channel.id)) {
      logger.warn({ channelId: channel.id }, 'Channel already registered, replacing');
    }

    // Register with FeedbackRouter
    this.feedbackRouter.registerChannel(channel);

    // Set up message handler
    channel.onMessage(async (message: IncomingMessage) => {
      try {
        logger.debug({ channelId: channel.id, messageId: message.messageId }, 'handleChannelMessage invoked');
        await this.handleChannelMessage(channel.id, message);
        logger.debug({ channelId: channel.id, messageId: message.messageId }, 'handleChannelMessage completed');
      } catch (error) {
        logger.error({ err: error, channelId: channel.id, messageId: message.messageId }, 'Failed to handle channel message');
      }
    });

    // Set up control handler
    channel.onControl((command: ControlCommand) => {
      return this.handleControlCommand(command);
    });

    logger.info({ channelId: channel.id, channelName: channel.name }, 'Channel registered');
  }

  /**
   * Get a registered channel by ID.
   */
  getChannel(channelId: string): IChannel | undefined {
    return this.feedbackRouter.getChannels().find(c => c.id === channelId);
  }

  /**
   * Get all registered channels.
   */
  getChannels(): IChannel[] {
    return this.feedbackRouter.getChannels();
  }

  // ============================================================================
  // Execution Node Management (delegated to ExecNodeRegistry)
  // ============================================================================

  /**
   * Switch a chat to a specific execution node.
   */
  switchChatNode(chatId: string, targetNodeId: string): boolean {
    return this.execNodeRegistry.switchChatNode(chatId, targetNodeId);
  }

  /**
   * Get list of all execution nodes (local + remote).
   */
  getExecNodes() {
    return this.execNodeRegistry.getNodes();
  }

  /**
   * Get the node assignment for a specific chat.
   */
  getChatNodeAssignment(chatId: string): string | undefined {
    return this.execNodeRegistry.getChatNodeAssignment(chatId);
  }

  // ============================================================================
  // Local Execution
  // ============================================================================

  /**
   * Initialize local execution capability.
   */
  private async initLocalExecution(): Promise<void> {
    if (!this.localExecEnabled) {
      return;
    }

    console.log('Initializing local execution capability...');

    // Create shared Pilot instance
    this.sharedPilot = AgentFactory.createChatAgent('pilot', {
      sendMessage: (chatId: string, text: string, threadMessageId?: string): Promise<void> => {
        const ctx = this.activeFeedbackChannels.get(chatId);
        if (ctx) {
          ctx.sendFeedback({ type: 'text', chatId, text, threadId: threadMessageId || ctx.threadId });
        } else {
          // Fallback for scheduled tasks: route directly through handleFeedback
          this.handleFeedback({ type: 'text', chatId, text, threadId: threadMessageId });
        }
        return Promise.resolve();
      },
      sendCard: (chatId: string, card: Record<string, unknown>, description?: string, threadMessageId?: string): Promise<void> => {
        const ctx = this.activeFeedbackChannels.get(chatId);
        if (ctx) {
          ctx.sendFeedback({ type: 'card', chatId, card, text: description, threadId: threadMessageId || ctx.threadId });
        } else {
          // Fallback for scheduled tasks: route directly through handleFeedback
          this.handleFeedback({ type: 'card', chatId, card, text: description, threadId: threadMessageId });
        }
        return Promise.resolve();
      },
      sendFile: async (chatId: string, filePath: string) => {
        const ctx = this.activeFeedbackChannels.get(chatId);
        if (ctx) {
          try {
            await this.sendFileToUser(chatId, filePath, ctx.threadId);
          } catch (error) {
            logger.error({ err: error, chatId, filePath }, 'Failed to send file');
            ctx.sendFeedback({
              type: 'error',
              chatId,
              error: `Failed to send file: ${(error as Error).message}`,
              threadId: ctx.threadId,
            });
          }
        } else {
          // Fallback for scheduled tasks: send file without threadId
          try {
            await this.sendFileToUser(chatId, filePath);
          } catch (error) {
            logger.error({ err: error, chatId, filePath }, 'Failed to send file for scheduled task');
          }
        }
      },
      onDone: (chatId: string, threadMessageId?: string): Promise<void> => {
        const ctx = this.activeFeedbackChannels.get(chatId);
        if (ctx) {
          ctx.sendFeedback({ type: 'done', chatId, threadId: threadMessageId || ctx.threadId });
          logger.info({ chatId }, 'Task completed, sent done signal');
        } else {
          // Fallback for scheduled tasks: route directly through handleFeedback
          this.handleFeedback({ type: 'done', chatId, threadId: threadMessageId });
          logger.info({ chatId }, 'Task completed (scheduled task)');
        }
        return Promise.resolve();
      },
    });

    // Initialize SchedulerService
    this.schedulerService = new SchedulerService({
      pilot: this.sharedPilot,
      callbacks: {
        sendMessage: async (chatId, text, threadId) => {
          await this.sendMessage(chatId, text, threadId);
        },
        sendCard: async (chatId, card, description, threadId) => {
          await this.sendCard(chatId, card, description, threadId);
        },
        sendFile: async (chatId, filePath) => {
          await this.sendFileToUser(chatId, filePath);
        },
        handleFeedback: (feedback) => {
          void this.handleFeedback(feedback);
        },
      },
    });

    await this.schedulerService.start();

    // Initialize TaskFlowOrchestrator
    const taskTracker = new TaskTracker();
    this.taskFlowOrchestrator = new TaskFlowOrchestrator(
      taskTracker,
      {
        sendMessage: (chatId: string, text: string, threadMessageId?: string): Promise<void> => {
          return this.sendMessage(chatId, text, threadMessageId);
        },
        sendCard: (chatId: string, card: Record<string, unknown>, _description?: string, threadMessageId?: string): Promise<void> => {
          return this.sendCard(chatId, card, undefined, threadMessageId);
        },
        sendFile: (chatId: string, filePath: string): Promise<void> => {
          return this.sendFileToUser(chatId, filePath);
        },
      },
      logger
    );

    await this.taskFlowOrchestrator.start();

    console.log('✓ Local execution capability initialized');
    console.log('✓ Scheduler started');
    console.log('✓ Schedule file watcher started');
    console.log('✓ TaskFlowOrchestrator started');
  }

  /**
   * Execute a prompt locally using the shared Pilot.
   */
  private executeLocally(message: PromptMessage): void {
    if (!this.sharedPilot) {
      throw new Error('Local execution not initialized');
    }

    const { chatId, prompt, messageId, senderOpenId, threadId, attachments, chatHistoryContext } = message;
    logger.info(
      { chatId, messageId, promptLength: prompt.length, threadId, hasAttachments: !!attachments, hasChatHistory: !!chatHistoryContext },
      'Executing prompt locally'
    );

    // Create send feedback function
    const sendFeedback = (feedback: FeedbackMessage) => {
      void this.handleFeedback(feedback);
    };

    // Register feedback channel for this chatId with threadId
    this.activeFeedbackChannels.set(chatId, { sendFeedback, threadId });

    try {
      // Use processMessage for persistent session context
      this.sharedPilot.processMessage(chatId, prompt, messageId, senderOpenId, attachments, chatHistoryContext);
    } catch (error) {
      const err = error as Error;
      logger.error({ err, chatId }, 'Local execution failed');
      sendFeedback({ type: 'error', chatId, error: err.message, threadId });
      sendFeedback({ type: 'done', chatId, threadId });
    }
  }

  // ============================================================================
  // Message Handling
  // ============================================================================

  /**
   * Handle message from a channel.
   */
  private async handleChannelMessage(_channelId: string, message: IncomingMessage): Promise<void> {
    logger.info(
      { chatId: message.chatId, messageId: message.messageId },
      'Processing channel message'
    );

    // Process attachments if present
    let attachments: FileRef[] | undefined;
    const fileStorageService = this.wsServerService?.getFileStorageService();
    if (message.attachments && message.attachments.length > 0 && fileStorageService) {
      attachments = [];
      for (const att of message.attachments) {
        try {
          const fileRef = await fileStorageService.storeFromLocal(
            att.filePath,
            att.fileName,
            att.mimeType,
            'user',
            message.chatId
          );
          attachments.push(fileRef);
          logger.info({ fileId: fileRef.id, fileName: att.fileName }, 'Attachment stored');
        } catch (error) {
          logger.error({ err: error, fileName: att.fileName }, 'Failed to store attachment');
        }
      }
    }

    // Send prompt to execution node
    await this.sendPrompt({
      type: 'prompt',
      chatId: message.chatId,
      prompt: message.content,
      messageId: message.messageId,
      senderOpenId: message.userId,
      threadId: message.threadId,
      attachments,
      chatHistoryContext: message.metadata?.chatHistoryContext as string | undefined,
    });
  }

  /**
   * Handle control command.
   */
  private async handleControlCommand(command: ControlCommand): Promise<ControlResponse> {
    switch (command.type) {
      case 'reset':
        await this.sendCommand({ type: 'command', command: 'reset', chatId: command.chatId });
        return { success: true, message: '✅ **对话已重置**\n\n新的会话已启动，之前的上下文已清除。' };

      case 'restart':
        await this.sendCommand({ type: 'command', command: 'restart', chatId: command.chatId });
        return { success: true, message: '🔄 **正在重启服务...**' };

      case 'status': {
        const status = this.running ? 'Running' : 'Stopped';
        const execNodesList = this.execNodeRegistry.getNodes();
        const execStatus = execNodesList.length > 0
          ? execNodesList.map(n => `${n.name} (${n.status}${n.isLocal ? ', local' : ''})`).join(', ')
          : 'None';
        const channelStatus = this.feedbackRouter.getChannels()
          .map(ch => `${ch.name}: ${ch.status}`)
          .join(', ');
        const currentNodeId = this.execNodeRegistry.getChatNodeAssignment(command.chatId);
        const currentNode = execNodesList.find(n => n.nodeId === currentNodeId);
        return {
          success: true,
          message: `📊 **状态**\n\n状态: ${status}\n节点ID: ${this.localNodeId}\n执行节点: ${execStatus}\n当前节点: ${currentNode?.name || '未分配'}\n通道: ${channelStatus}`,
        };
      }

      // Issue #463: Help command using CommandRegistry
      case 'help': {
        const registry = getCommandRegistry();
        return { success: true, message: registry.generateHelpText() };
      }

      case 'list-nodes': {
        const nodes = this.execNodeRegistry.getNodes();
        if (nodes.length === 0) {
          return { success: true, message: '📋 **执行节点列表**\n\n暂无执行节点' };
        }
        const currentNodeId = this.execNodeRegistry.getChatNodeAssignment(command.chatId);
        const nodesList = nodes.map(n => {
          const isCurrent = n.nodeId === currentNodeId ? ' ✓ (当前)' : '';
          const localTag = n.isLocal ? ' [本地]' : '';
          return `- ${n.name}${localTag} [${n.status}]${isCurrent} (${n.activeChats} 活跃会话)`;
        }).join('\n');
        return { success: true, message: `📋 **执行节点列表**\n\n${nodesList}` };
      }

      case 'switch-node': {
        const {targetNodeId} = command;
        if (!targetNodeId) {
          const nodes = this.execNodeRegistry.getNodes();
          const nodesList = nodes.map(n => `- \`${n.nodeId}\` (${n.name}${n.isLocal ? ', local' : ''})`).join('\n');
          return {
            success: false,
            error: `请指定目标节点ID。\n\n可用节点:\n${nodesList}`,
          };
        }

        const success = this.execNodeRegistry.switchChatNode(command.chatId, targetNodeId);
        if (success) {
          const node = this.execNodeRegistry.getNode(targetNodeId);
          return { success: true, message: `✅ **已切换执行节点**\n\n当前节点: ${node?.name || targetNodeId}` };
        } else {
          return { success: false, error: `切换失败，节点 \`${targetNodeId}\` 不可用` };
        }
      }

      // Issue #541: Node management command
      case 'node': {
        const args = command.data?.args as string[] | undefined;
        const subCommand = args?.[0]?.toLowerCase();

        if (!subCommand) {
          // Show help
          return {
            success: true,
            message: `🖥️ **节点管理指令**

用法: \`/node <子命令>\`

**可用子命令:**
- \`list\` - 列出所有节点及其状态
- \`status [node-id]\` - 查看节点详细状态（不指定则查看当前）
- \`info\` - 查看当前节点信息
- \`switch <node-id>\` - 切换到指定节点
- \`auto\` - 切换到自动选择模式

示例:
\`\`\`
/node list
/node status
/node switch worker-abc123
/node auto
\`\`\``,
          };
        }

        switch (subCommand) {
          case 'list': {
            const nodes = this.execNodeRegistry.getNodes();
            if (nodes.length === 0) {
              return { success: true, message: '📋 **节点列表**\n\n暂无执行节点' };
            }
            const currentNodeId = this.execNodeRegistry.getChatNodeAssignment(command.chatId);
            const nodesList = nodes.map(n => {
              const isCurrent = n.nodeId === currentNodeId ? ' ✓ (当前)' : '';
              const localTag = n.isLocal ? ' [本地]' : '';
              const statusIcon = n.status === 'connected' ? '🟢' : '🔴';
              return `${statusIcon} **${n.name}**${localTag}${isCurrent}\n   ID: \`${n.nodeId}\`\n   活跃会话: ${n.activeChats}`;
            }).join('\n\n');
            return { success: true, message: `🖥️ **节点列表**\n\n共 ${nodes.length} 个节点\n\n${nodesList}` };
          }

          case 'status': {
            const targetNodeId = args?.[1];
            const nodeId = targetNodeId || this.execNodeRegistry.getChatNodeAssignment(command.chatId);

            if (!nodeId) {
              return {
                success: true,
                message: '📊 **节点状态**\n\n当前会话未分配节点\n\n使用 `/node auto` 自动分配',
              };
            }

            const node = this.execNodeRegistry.getNode(nodeId);
            if (!node) {
              return { success: false, error: `节点 \`${nodeId}\` 不存在` };
            }

            const nodes = this.execNodeRegistry.getNodes();
            const nodeInfo = nodes.find(n => n.nodeId === nodeId);
            const connectedAt = node.connectedAt ? new Date(node.connectedAt).toLocaleString('zh-CN') : 'N/A';
            const statusIcon = nodeInfo?.status === 'connected' ? '🟢' : '🔴';
            const localTag = node.isLocal ? '\n类型: 本地执行' : '\n类型: 远程节点';

            return {
              success: true,
              message: `📊 **节点状态**\n\n名称: **${node.name}**\nID: \`${node.nodeId}\`\n状态: ${statusIcon} ${nodeInfo?.status || 'unknown'}${localTag}\n活跃会话: ${nodeInfo?.activeChats || 0}\n连接时间: ${connectedAt}`,
            };
          }

          case 'info': {
            const currentNodeId = this.execNodeRegistry.getChatNodeAssignment(command.chatId);
            if (!currentNodeId) {
              return {
                success: true,
                message: `📊 **当前节点信息**\n\n节点ID: ${this.localNodeId}\n会话分配: 未分配\n\n当前会话未分配执行节点，将使用自动选择模式。`,
              };
            }

            const node = this.execNodeRegistry.getNode(currentNodeId);
            const nodes = this.execNodeRegistry.getNodes();
            const nodeInfo = nodes.find(n => n.nodeId === currentNodeId);
            const connectedAt = node?.connectedAt ? new Date(node.connectedAt).toLocaleString('zh-CN') : 'N/A';
            const statusIcon = nodeInfo?.status === 'connected' ? '🟢' : '🔴';

            return {
              success: true,
              message: `📊 **当前节点信息**\n\n节点ID: ${this.localNodeId}\n执行节点: **${node?.name || currentNodeId}**\n执行节点ID: \`${currentNodeId}\`\n状态: ${statusIcon} ${nodeInfo?.status || 'unknown'}\n活跃会话: ${nodeInfo?.activeChats || 0}\n连接时间: ${connectedAt}`,
            };
          }

          case 'switch': {
            const targetNodeId = args?.[1];
            if (!targetNodeId) {
              const nodes = this.execNodeRegistry.getNodes();
              const nodesList = nodes.map(n => `- \`${n.nodeId}\` (${n.name}${n.isLocal ? ', local' : ''})`).join('\n');
              return {
                success: false,
                error: `请指定目标节点ID。\n\n用法: \`/node switch <node-id>\`\n\n可用节点:\n${nodesList}`,
              };
            }

            const success = this.execNodeRegistry.switchChatNode(command.chatId, targetNodeId);
            if (success) {
              const node = this.execNodeRegistry.getNode(targetNodeId);
              return { success: true, message: `✅ **已切换执行节点**\n\n当前节点: ${node?.name || targetNodeId}` };
            } else {
              return { success: false, error: `切换失败，节点 \`${targetNodeId}\` 不存在或不可用` };
            }
          }

          case 'auto': {
            // Get current assignment and switch to auto-selection
            const availableNode = this.execNodeRegistry.getFirstAvailableNode();

            if (availableNode) {
              // Assign to first available node (auto mode)
              this.execNodeRegistry.switchChatNode(command.chatId, availableNode.nodeId);
              const localTag = availableNode.isLocal ? ' (本地)' : '';
              return {
                success: true,
                message: `✅ **已切换到自动选择模式**\n\n自动分配到: **${availableNode.name}**${localTag}\n节点ID: \`${availableNode.nodeId}\``,
              };
            } else {
              return {
                success: false,
                error: '没有可用的执行节点',
              };
            }
          }

          default:
            return {
              success: false,
              error: `未知的子命令: \`${subCommand}\`\n\n可用子命令: list, status, info, switch, auto`,
            };
        }
      }

      // Group management commands (Issue #486)
      case 'create-group': {
        const args = command.data?.args as string[] | undefined;
        if (!args || args.length < 2) {
          return {
            success: false,
            error: '用法: `/create-group <群名称> <成员1,成员2,...>`\n\n示例: `/create-group 讨论组 ou_xxx,ou_yyy`',
          };
        }

        const [name, ...restArgs] = args;
        const membersArg = restArgs.join(' ');
        const members = membersArg.split(',').map(m => m.trim()).filter(m => m);

        if (members.length === 0) {
          return { success: false, error: '请至少指定一个成员 (open_id 格式: ou_xxx)' };
        }

        try {
          const client = this.getFeishuClient();
          const chatId = await createDiscussionChat(client, { topic: name, members });

          // Register the group
          this.groupService.registerGroup({
            chatId,
            name,
            createdAt: Date.now(),
            createdBy: command.data?.senderOpenId as string | undefined,
            initialMembers: members,
          });

          return {
            success: true,
            message: `✅ **群创建成功**\n\n群名称: ${name}\n群 ID: \`${chatId}\`\n成员数: ${members.length}`,
          };
        } catch (error) {
          logger.error({ err: error }, 'Failed to create group');
          return { success: false, error: `创建群失败: ${(error as Error).message}` };
        }
      }

      case 'add-member': {
        const args = command.data?.args as string[] | undefined;
        if (!args || args.length < 2) {
          return {
            success: false,
            error: '用法: `/add-member <群ID> <成员ID>`\n\n示例: `/add-member oc_xxx ou_yyy`',
          };
        }

        const [groupId, memberId] = args;

        try {
          const client = this.getFeishuClient();
          await addMembers(client, groupId, [memberId]);
          return { success: true, message: `✅ **成员添加成功**\n\n群 ID: \`${groupId}\`\n成员: \`${memberId}\`` };
        } catch (error) {
          logger.error({ err: error }, 'Failed to add member');
          return { success: false, error: `添加成员失败: ${(error as Error).message}` };
        }
      }

      case 'remove-member': {
        const args = command.data?.args as string[] | undefined;
        if (!args || args.length < 2) {
          return {
            success: false,
            error: '用法: `/remove-member <群ID> <成员ID>`\n\n示例: `/remove-member oc_xxx ou_yyy`',
          };
        }

        const [groupId, memberId] = args;

        try {
          const client = this.getFeishuClient();
          await removeMembers(client, groupId, [memberId]);
          return { success: true, message: `✅ **成员移除成功**\n\n群 ID: \`${groupId}\`\n成员: \`${memberId}\`` };
        } catch (error) {
          logger.error({ err: error }, 'Failed to remove member');
          return { success: false, error: `移除成员失败: ${(error as Error).message}` };
        }
      }

      case 'list-member': {
        const args = command.data?.args as string[] | undefined;
        if (!args || args.length < 1) {
          return {
            success: false,
            error: '用法: `/list-member <群ID>`\n\n示例: `/list-member oc_xxx`',
          };
        }

        const [groupId] = args;

        try {
          const client = this.getFeishuClient();
          const members = await getMembers(client, groupId);

          if (members.length === 0) {
            return { success: true, message: `📋 **群成员列表**\n\n群 ID: \`${groupId}\`\n成员数: 0` };
          }

          const memberList = members.map(m => `- \`${m}\``).join('\n');
          return {
            success: true,
            message: `📋 **群成员列表**\n\n群 ID: \`${groupId}\`\n成员数: ${members.length}\n\n${memberList}`,
          };
        } catch (error) {
          logger.error({ err: error }, 'Failed to list members');
          return { success: false, error: `获取成员列表失败: ${(error as Error).message}` };
        }
      }

      case 'list-group': {
        const groups = this.groupService.listGroups();

        if (groups.length === 0) {
          return { success: true, message: '📋 **管理的群列表**\n\n暂无管理的群' };
        }

        const groupList = groups.map(g => {
          const createdAt = new Date(g.createdAt).toLocaleString('zh-CN');
          return `- **${g.name}** \`${g.chatId}\`\n  创建时间: ${createdAt}\n  初始成员: ${g.initialMembers.length}`;
        }).join('\n\n');

        return {
          success: true,
          message: `📋 **管理的群列表**\n\n群数量: ${groups.length}\n\n${groupList}`,
        };
      }

      case 'dissolve-group': {
        const args = command.data?.args as string[] | undefined;
        if (!args || args.length < 1) {
          return {
            success: false,
            error: '用法: `/dissolve-group <群ID>`\n\n示例: `/dissolve-group oc_xxx`',
          };
        }

        const [groupId] = args;

        try {
          const client = this.getFeishuClient();
          await dissolveChat(client, groupId);

          // Unregister the group
          const wasManaged = this.groupService.unregisterGroup(groupId);

          return {
            success: true,
            message: `✅ **群解散成功**\n\n群 ID: \`${groupId}\`${wasManaged ? '' : ' (非托管群)'}`,
          };
        } catch (error) {
          logger.error({ err: error }, 'Failed to dissolve group');
          return { success: false, error: `解散群失败: ${(error as Error).message}` };
        }
      }

      // Debug group commands (Issue #487)
      case 'set-debug': {
        const debugGroupService = getDebugGroupService();
        const previous = debugGroupService.setDebugGroup(command.chatId);

        if (previous) {
          return {
            success: true,
            message: `✅ **调试群已转移**\n\n从 \`${previous.chatId}\` 转移至此群 (\`${command.chatId}\`)`,
          };
        }

        return {
          success: true,
          message: `✅ **调试群已设置**\n\n此群 (\`${command.chatId}\`) 已设为调试群`,
        };
      }

      case 'show-debug': {
        const debugGroupService = getDebugGroupService();
        const current = debugGroupService.getDebugGroup();

        if (!current) {
          return {
            success: true,
            message: '📋 **调试群状态**\n\n尚未设置调试群\n\n使用 `/set-debug` 设置当前群为调试群',
          };
        }

        const setAt = new Date(current.setAt).toLocaleString('zh-CN');
        return {
          success: true,
          message: `📋 **调试群状态**\n\n群 ID: \`${current.chatId}\`\n设置时间: ${setAt}`,
        };
      }

      case 'clear-debug': {
        const debugGroupService = getDebugGroupService();
        const previous = debugGroupService.clearDebugGroup();

        if (!previous) {
          return {
            success: true,
            message: '📋 **调试群状态**\n\n没有设置调试群，无需清除',
          };
        }

        return {
          success: true,
          message: `✅ **调试群已清除**\n\n原调试群: \`${previous.chatId}\``,
        };
      }

      default:
        return { success: false, error: `Unknown command: ${command.type}` };
    }
  }

  /**
   * Send prompt to execution node (local or remote).
   */
  private async sendPrompt(message: PromptMessage): Promise<void> {
    const execNode = this.execNodeRegistry.getNodeForChat(message.chatId);
    if (!execNode) {
      logger.warn('No Execution Node available');
      await this.sendMessage(message.chatId, '❌ 没有可用的执行节点');
      throw new Error('No Execution Node available');
    }

    // Execute locally
    if (execNode.isLocal) {
      await this.executeLocally(message);
      return;
    }

    // Execute remotely
    if (execNode.ws) {
      execNode.ws.send(JSON.stringify(message));
      logger.info({ chatId: message.chatId, messageId: message.messageId, threadId: message.threadId, nodeId: execNode.nodeId }, 'Prompt sent to Worker Node');
    }
  }

  /**
   * Send command to execution node (local or remote).
   */
  private async sendCommand(message: CommandMessage): Promise<void> {
    const execNode = this.execNodeRegistry.getNodeForChat(message.chatId);
    if (!execNode) {
      logger.warn('No Execution Node available');
      await this.sendMessage(message.chatId, '❌ 没有可用的执行节点');
      throw new Error('No Execution Node available');
    }

    // Handle locally
    if (execNode.isLocal && this.sharedPilot) {
      const { command, chatId } = message;
      logger.info({ command, chatId }, 'Executing command locally');

      try {
        if (command === 'reset' || command === 'restart') {
          this.sharedPilot.reset(chatId);
          logger.info({ chatId }, `Pilot ${command} executed for chatId`);
        }
      } catch (error) {
        const err = error as Error;
        logger.error({ err, command, chatId }, 'Command execution failed');
      }
      return;
    }

    // Send to remote node
    if (execNode.ws) {
      execNode.ws.send(JSON.stringify(message));
      logger.info({ chatId: message.chatId, command: message.command, nodeId: execNode.nodeId }, 'Command sent to Worker Node');
    }
  }

  /**
   * Handle feedback from execution node (remote or local).
   */
  private async handleFeedback(message: FeedbackMessage): Promise<void> {
    await this.feedbackRouter.handleFeedback(message);
  }

  // ============================================================================
  // Public Message API
  // ============================================================================

  /**
   * Send a text message to all channels (broadcast mode).
   */
  async sendMessage(chatId: string, text: string, threadMessageId?: string): Promise<void> {
    await this.feedbackRouter.sendMessage(chatId, text, threadMessageId);
  }

  /**
   * Send an interactive card to all channels (broadcast mode).
   */
  async sendCard(
    chatId: string,
    card: Record<string, unknown>,
    description?: string,
    threadMessageId?: string
  ): Promise<void> {
    await this.feedbackRouter.sendCard(chatId, card, description, threadMessageId);
  }

  /**
   * Send a file to all channels (broadcast mode).
   */
  async sendFileToUser(chatId: string, filePath: string, _threadId?: string): Promise<void> {
    // For now, broadcast file path as a message
    // TODO: Implement proper file handling through channels
    await this.feedbackRouter.sendMessage(chatId, `📎 文件: ${filePath}`, _threadId);
  }

  // ============================================================================
  // Lifecycle Management
  // ============================================================================

  /**
   * Start the Primary Node.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('PrimaryNode already running');
      return;
    }

    this.running = true;

    // Register local execution capability first
    this.execNodeRegistry.registerLocalNode();

    // Initialize WebSocket server service
    this.wsServerService = new WebSocketServerService({
      port: this.port,
      host: this.host,
      localNodeId: this.localNodeId,
      fileStorageConfig: this.fileStorageConfig,
      execNodeRegistry: this.execNodeRegistry,
      handleFeedback: (feedback) => {
        void this.handleFeedback(feedback);
      },
      getCapabilities: () => this.getCapabilities(),
      getChannelIds: () => this.feedbackRouter.getChannels().map(c => c.id),
    });

    // Start WebSocket server
    await this.wsServerService.start();

    // Initialize local execution capability
    await this.initLocalExecution();

    // Start all registered channels
    for (const channel of this.feedbackRouter.getChannels()) {
      try {
        await channel.start();
        logger.info({ channelId: channel.id }, 'Channel started');
      } catch (error) {
        logger.error({ err: error, channelId: channel.id }, 'Failed to start channel');
      }
    }

    logger.info('PrimaryNode started');
    console.log('✓ Primary Node ready');
    console.log();
    console.log(`Node ID: ${this.localNodeId}`);
    console.log(`WebSocket Server: ws://${this.host}:${this.port}`);
    console.log('Channels:');
    for (const channel of this.feedbackRouter.getChannels()) {
      console.log(`  - ${channel.name} (${channel.id}): ${channel.status}`);
    }
    console.log('Execution:');
    console.log(`  - Local: ${this.localExecEnabled ? 'Enabled' : 'Disabled'}`);
    console.log('Waiting for Worker Nodes to connect...');
    console.log();
    console.log('Control commands available:');
    console.log('  /list-nodes  - List all execution nodes');
    console.log('  /switch-node <nodeId> - Switch to a specific execution node');
  }

  /**
   * Stop the Primary Node.
   */
  async stop(): Promise<void> {
    if (!this.running) {return;}

    this.running = false;

    // Stop scheduler service
    this.schedulerService?.stop();
    await this.taskFlowOrchestrator?.stop();

    // Stop WebSocket server
    await this.wsServerService?.stop();

    // Stop all channels
    for (const channel of this.feedbackRouter.getChannels()) {
      try {
        await channel.stop();
        logger.info({ channelId: channel.id }, 'Channel stopped');
      } catch (error) {
        logger.error({ err: error, channelId: channel.id }, 'Failed to stop channel');
      }
    }

    // Clear execution nodes
    this.execNodeRegistry.clear();
    this.feedbackRouter.clear();

    logger.info('PrimaryNode stopped');
  }

  /**
   * Check if the node is running.
   */
  isRunning(): boolean {
    return this.running;
  }
}
