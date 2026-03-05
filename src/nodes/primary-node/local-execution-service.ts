/**
 * LocalExecutionService - Manages local execution capability.
 *
 * Extracted from PrimaryNode (Issue #695):
 * - AgentPool initialization
 * - SchedulerService initialization
 * - TaskFlowOrchestrator initialization
 * - Feedback channel management
 * - Local prompt execution
 *
 * Issue #644: Uses AgentPool instead of sharedPilot.
 * Each chatId gets its own Pilot instance for complete isolation.
 */

import { createLogger } from '../../utils/logger.js';
import { AgentFactory, AgentPool } from '../../agents/index.js';
import { TaskFlowOrchestrator } from '../../feishu/task-flow-orchestrator.js';
import { TaskTracker } from '../../utils/task-tracker.js';
import { SchedulerService } from '../scheduler-service.js';
import type { FeedbackMessage, PromptMessage, CommandMessage } from '../../types/websocket-messages.js';
import type { ChannelCapabilities } from '../../channels/types.js';

const logger = createLogger('LocalExecutionService');

/**
 * Feedback context for execution.
 */
export interface FeedbackContext {
  sendFeedback: (feedback: FeedbackMessage) => void;
  threadId?: string;
}

/**
 * Callbacks for local execution.
 */
export interface LocalExecutionCallbacks {
  sendMessage: (chatId: string, text: string, threadMessageId?: string) => Promise<void>;
  sendCard: (chatId: string, card: Record<string, unknown>, description?: string, threadMessageId?: string) => Promise<void>;
  sendFileToUser: (chatId: string, filePath: string, threadId?: string) => Promise<void>;
  handleFeedback: (feedback: FeedbackMessage) => void;
  getChannelCapabilities: (chatId: string) => ChannelCapabilities | undefined;
  triggerNextStepRecommendation: (chatId: string, threadId?: string) => void;
}

/**
 * Configuration for LocalExecutionService.
 */
export interface LocalExecutionServiceConfig {
  localExecEnabled: boolean;
  callbacks: LocalExecutionCallbacks;
}

/**
 * LocalExecutionService - Manages local Agent execution.
 *
 * Responsibilities:
 * - Initialize AgentPool with per-chatId Pilot instances
 * - Initialize SchedulerService for scheduled tasks
 * - Initialize TaskFlowOrchestrator for task flow management
 * - Manage feedback channels for active conversations
 */
export class LocalExecutionService {
  private localExecEnabled: boolean;
  private callbacks: LocalExecutionCallbacks;

  // Services
  private agentPool?: AgentPool;
  private schedulerService?: SchedulerService;
  private taskFlowOrchestrator?: TaskFlowOrchestrator;

  // Feedback channels
  private activeFeedbackChannels = new Map<string, FeedbackContext>();

  constructor(config: LocalExecutionServiceConfig) {
    this.localExecEnabled = config.localExecEnabled;
    this.callbacks = config.callbacks;
  }

  /**
   * Initialize local execution capability.
   */
  async init(): Promise<void> {
    if (!this.localExecEnabled) {
      return;
    }

    console.log('Initializing local execution capability...');

    // Issue #644: Create AgentPool with factory function
    // Each chatId gets its own Pilot instance for complete isolation
    this.agentPool = new AgentPool({
      pilotFactory: (chatId: string) => {
        return AgentFactory.createChatAgent('pilot', chatId, this.createPilotCallbacks(chatId));
      },
    });

    // Initialize SchedulerService
    this.schedulerService = new SchedulerService({
      agentPool: this.agentPool,
      callbacks: {
        sendMessage: async (chatId, text, threadId) => {
          await this.callbacks.sendMessage(chatId, text, threadId);
        },
        sendCard: async (chatId, card, description, threadId) => {
          await this.callbacks.sendCard(chatId, card, description, threadId);
        },
        sendFile: async (chatId, filePath) => {
          await this.callbacks.sendFileToUser(chatId, filePath);
        },
        handleFeedback: (feedback) => {
          this.callbacks.handleFeedback(feedback);
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
          return this.callbacks.sendMessage(chatId, text, threadMessageId);
        },
        sendCard: (chatId: string, card: Record<string, unknown>, _description?: string, threadMessageId?: string): Promise<void> => {
          return this.callbacks.sendCard(chatId, card, undefined, threadMessageId);
        },
        sendFile: (chatId: string, filePath: string): Promise<void> => {
          return this.callbacks.sendFileToUser(chatId, filePath);
        },
      },
      logger
    );

    await this.taskFlowOrchestrator.start();

    console.log('✓ Local execution capability initialized');
    console.log('✓ Scheduler started');
    console.log('✓ TaskFlowOrchestrator started');
  }

  /**
   * Create Pilot callbacks for a specific chatId.
   * Note: The outer chatId parameter is used for context, but the callbacks
   * receive chatId as a parameter to support flexible routing.
   */
  private createPilotCallbacks(_chatId: string) {
    return {
      sendMessage: (chatId: string, text: string, threadMessageId?: string): Promise<void> => {
        const ctx = this.activeFeedbackChannels.get(chatId);
        if (ctx) {
          ctx.sendFeedback({ type: 'text', chatId, text, threadId: threadMessageId || ctx.threadId });
        } else {
          // Fallback for scheduled tasks: route directly through handleFeedback
          this.callbacks.handleFeedback({ type: 'text', chatId, text, threadId: threadMessageId });
        }
        return Promise.resolve();
      },
      sendCard: (chatId: string, card: Record<string, unknown>, description?: string, threadMessageId?: string): Promise<void> => {
        const ctx = this.activeFeedbackChannels.get(chatId);
        if (ctx) {
          ctx.sendFeedback({ type: 'card', chatId, card, text: description, threadId: threadMessageId || ctx.threadId });
        } else {
          // Fallback for scheduled tasks: route directly through handleFeedback
          this.callbacks.handleFeedback({ type: 'card', chatId, card, text: description, threadId: threadMessageId });
        }
        return Promise.resolve();
      },
      sendFile: async (chatId: string, filePath: string) => {
        const ctx = this.activeFeedbackChannels.get(chatId);
        if (ctx) {
          try {
            await this.callbacks.sendFileToUser(chatId, filePath, ctx.threadId);
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
            await this.callbacks.sendFileToUser(chatId, filePath);
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
          this.callbacks.handleFeedback({ type: 'done', chatId, threadId: threadMessageId });
          logger.info({ chatId }, 'Task completed (scheduled task)');
        }
        return Promise.resolve();
      },
      // Capability-aware prompt generation (Issue #582)
      getCapabilities: (chatId: string) => {
        return this.callbacks.getChannelCapabilities(chatId);
      },
    };
  }

  /**
   * Execute a prompt locally using the AgentPool.
   *
   * Issue #644: Uses AgentPool to get Pilot for this chatId.
   */
  executePrompt(message: PromptMessage): void {
    if (!this.agentPool) {
      throw new Error('Local execution not initialized');
    }

    const { chatId, prompt, messageId, senderOpenId, threadId, attachments, chatHistoryContext } = message;
    logger.info(
      { chatId, messageId, promptLength: prompt.length, threadId, hasAttachments: !!attachments, hasChatHistory: !!chatHistoryContext },
      'Executing prompt locally'
    );

    // Create send feedback function
    const sendFeedback = (feedback: FeedbackMessage) => {
      this.callbacks.handleFeedback(feedback);
    };

    // Register feedback channel for this chatId with threadId
    this.activeFeedbackChannels.set(chatId, { sendFeedback, threadId });

    try {
      // Issue #644: Get Pilot for this chatId from AgentPool
      const pilot = this.agentPool.getOrCreate(chatId);
      pilot.processMessage(chatId, prompt, messageId, senderOpenId, attachments, chatHistoryContext);
    } catch (error) {
      const err = error as Error;
      logger.error({ err, chatId }, 'Local execution failed');
      sendFeedback({ type: 'error', chatId, error: err.message, threadId });
      sendFeedback({ type: 'done', chatId, threadId });
    }
  }

  /**
   * Execute a command locally.
   */
  executeCommand(message: CommandMessage): void {
    if (!this.agentPool) {
      throw new Error('Local execution not initialized');
    }

    const { command, chatId } = message;
    logger.info({ command, chatId }, 'Executing command locally');

    try {
      if (command === 'reset' || command === 'restart') {
        // Issue #644: Reset the Pilot for this chatId via AgentPool
        this.agentPool.reset(chatId);
        logger.info({ chatId }, `Pilot ${command} executed for chatId`);
      }
    } catch (error) {
      const err = error as Error;
      logger.error({ err, command, chatId }, 'Command execution failed');
    }
  }

  /**
   * Get the AgentPool instance.
   */
  getAgentPool(): AgentPool | undefined {
    return this.agentPool;
  }

  /**
   * Get the SchedulerService instance.
   */
  getSchedulerService(): SchedulerService | undefined {
    return this.schedulerService;
  }

  /**
   * Stop the local execution service.
   */
  async stop(): Promise<void> {
    this.schedulerService?.stop();
    await this.taskFlowOrchestrator?.stop();
    this.activeFeedbackChannels.clear();
  }
}
