/**
 * Primary Node Local Execution Setup
 *
 * Extracted from primary-node.ts (Issue #695)
 * Handles initialization of local execution capability including AgentPool,
 * SchedulerService, and TaskFlowOrchestrator.
 */

import { AgentFactory, AgentPool } from '../agents/index.js';
import { TaskFlowOrchestrator } from '../feishu/task-flow-orchestrator.js';
import { TaskTracker } from '../utils/task-tracker.js';
import { SchedulerService } from './scheduler-service.js';
import { createLogger } from '../utils/logger.js';
import type { FeedbackMessage } from '../types/websocket-messages.js';
import type { ChannelCapabilities } from '../channels/types.js';

const logger = createLogger('PrimaryNodeLocalExec');

/**
 * Feedback context for execution.
 */
export interface FeedbackContext {
  sendFeedback: (feedback: FeedbackMessage) => void;
  threadId?: string;
}

/**
 * Dependencies needed for local execution setup.
 */
export interface LocalExecDeps {
  localExecEnabled: boolean;
  activeFeedbackChannels: Map<string, FeedbackContext>;
  sendMessage: (chatId: string, text: string, threadMessageId?: string) => Promise<void>;
  sendCard: (chatId: string, card: Record<string, unknown>, description?: string, threadMessageId?: string) => Promise<void>;
  sendFileToUser: (chatId: string, filePath: string, threadId?: string) => Promise<void>;
  handleFeedback: (feedback: FeedbackMessage) => Promise<void>;
  getChannelCapabilities: (chatId: string) => ChannelCapabilities | undefined;
}

/**
 * Result of local execution initialization.
 */
export interface LocalExecResult {
  agentPool: AgentPool;
  schedulerService: SchedulerService;
  taskFlowOrchestrator: TaskFlowOrchestrator;
}

/**
 * Primary Node Local Execution Setup
 *
 * Encapsulates local execution initialization logic extracted from PrimaryNode.
 */
export class PrimaryNodeLocalExec {
  private localExecEnabled: boolean;
  private activeFeedbackChannels: Map<string, FeedbackContext>;
  private sendMessage: LocalExecDeps['sendMessage'];
  private sendCard: LocalExecDeps['sendCard'];
  private sendFileToUser: LocalExecDeps['sendFileToUser'];
  private handleFeedback: LocalExecDeps['handleFeedback'];
  private getChannelCapabilities: LocalExecDeps['getChannelCapabilities'];

  constructor(deps: LocalExecDeps) {
    this.localExecEnabled = deps.localExecEnabled;
    this.activeFeedbackChannels = deps.activeFeedbackChannels;
    this.sendMessage = deps.sendMessage;
    this.sendCard = deps.sendCard;
    this.sendFileToUser = deps.sendFileToUser;
    this.handleFeedback = deps.handleFeedback;
    this.getChannelCapabilities = deps.getChannelCapabilities;
  }

  /**
   * Initialize local execution capability.
   *
   * Issue #644: Uses AgentPool instead of sharedPilot.
   * Each chatId gets its own Pilot instance for complete isolation.
   */
  async init(): Promise<LocalExecResult | null> {
    if (!this.localExecEnabled) {
      return null;
    }

    console.log('Initializing local execution capability...');

    // Issue #644: Create AgentPool with factory function
    // Each chatId gets its own Pilot instance for complete isolation
    const agentPool = this.createAgentPool();

    // Initialize SchedulerService
    const schedulerService = this.createSchedulerService(agentPool);
    await schedulerService.start();

    // Initialize TaskFlowOrchestrator
    const taskFlowOrchestrator = this.createTaskFlowOrchestrator();
    await taskFlowOrchestrator.start();

    console.log('✓ Local execution capability initialized');
    console.log('✓ Scheduler started');
    console.log('✓ TaskFlowOrchestrator started');

    return { agentPool, schedulerService, taskFlowOrchestrator };
  }

  /**
   * Create AgentPool with pilot factory.
   */
  private createAgentPool(): AgentPool {
    return new AgentPool({
      pilotFactory: (chatId: string) => {
        return AgentFactory.createChatAgent('pilot', chatId, {
          sendMessage: (chatId: string, text: string, threadMessageId?: string): Promise<void> => {
            const ctx = this.activeFeedbackChannels.get(chatId);
            if (ctx) {
              ctx.sendFeedback({ type: 'text', chatId, text, threadId: threadMessageId || ctx.threadId });
            } else {
              // Fallback for scheduled tasks: route directly through handleFeedback
              void this.handleFeedback({ type: 'text', chatId, text, threadId: threadMessageId });
            }
            return Promise.resolve();
          },
          sendCard: (chatId: string, card: Record<string, unknown>, description?: string, threadMessageId?: string): Promise<void> => {
            const ctx = this.activeFeedbackChannels.get(chatId);
            if (ctx) {
              ctx.sendFeedback({ type: 'card', chatId, card, text: description, threadId: threadMessageId || ctx.threadId });
            } else {
              // Fallback for scheduled tasks: route directly through handleFeedback
              void this.handleFeedback({ type: 'card', chatId, card, text: description, threadId: threadMessageId });
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
              void this.handleFeedback({ type: 'done', chatId, threadId: threadMessageId });
              logger.info({ chatId }, 'Task completed (scheduled task)');
            }
            return Promise.resolve();
          },
          // Capability-aware prompt generation (Issue #582)
          getCapabilities: (chatId: string) => {
            return this.getChannelCapabilities(chatId);
          },
        });
      },
    });
  }

  /**
   * Create SchedulerService.
   */
  private createSchedulerService(agentPool: AgentPool): SchedulerService {
    return new SchedulerService({
      agentPool,
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
  }

  /**
   * Create TaskFlowOrchestrator.
   */
  private createTaskFlowOrchestrator(): TaskFlowOrchestrator {
    const taskTracker = new TaskTracker();
    return new TaskFlowOrchestrator(
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
  }
}
