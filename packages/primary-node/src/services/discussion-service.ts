/**
 * Discussion Service - orchestrates offline discussions (Issue #631).
 *
 * This service runs in the Primary Node and handles:
 * - Creating Feishu discussion groups via chat-ops
 * - Registering groups with GroupService
 * - Coordinating with DiscussionManager for record tracking
 * - Sending initial discussion messages
 *
 * The discussion flow:
 * 1. Agent detects a topic needing discussion
 * 2. DiscussionService.createDiscussion() creates a Feishu group
 * 3. The group gets a ChatAgent via AgentPool (automatic on first message)
 * 4. Discussion concludes when users reach a decision
 * 5. Follow-up actions are executed based on results
 *
 * @module primary-node/services/discussion-service
 */

import type * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '@disclaude/core';
import { getDiscussionManager, type DiscussionTopic, type DiscussionResult } from '@disclaude/core';
import { createDiscussionChat } from '../platforms/feishu/chat-ops.js';
import { getGroupService } from '../platforms/feishu/group-service.js';

const logger = createLogger('DiscussionService');

export interface DiscussionServiceConfig {
  /** Lark client for Feishu API calls */
  larkClient: lark.Client;
  /** Workspace directory for persistence */
  workspaceDir?: string;
}

export interface CreateDiscussionResult {
  success: boolean;
  discussionId: string;
  chatId?: string;
  error?: string;
}

/**
 * Discussion Service.
 *
 * Orchestrates the creation and lifecycle management of offline discussions.
 * This is the primary-node-side implementation that uses Feishu APIs directly.
 */
export class DiscussionService {
  private larkClient: lark.Client;

  constructor(config: DiscussionServiceConfig) {
    this.larkClient = config.larkClient;
  }

  /**
   * Create a new discussion.
   *
   * Steps:
   * 1. Create a discussion record via DiscussionManager
   * 2. Create a Feishu group via chat-ops
   * 3. Register the group with GroupService
   * 4. Activate the discussion record with the new chatId
   *
   * @param topic - Discussion topic
   * @param sourceChatId - Chat where the discussion was initiated
   * @param creatorOpenId - Open ID of the discussion creator
   * @returns Result with discussion ID and chat ID
   */
  async createDiscussion(
    topic: DiscussionTopic,
    sourceChatId: string,
    creatorOpenId?: string
  ): Promise<CreateDiscussionResult> {
    const manager = getDiscussionManager();

    // Step 1: Create discussion record
    const record = manager.createDiscussion({
      topic,
      sourceChatId,
      creatorOpenId,
    });

    try {
      // Step 2: Create Feishu group
      const members = topic.participants?.length
        ? topic.participants
        : creatorOpenId
          ? [creatorOpenId]
          : undefined;

      const chatId = await createDiscussionChat(
        this.larkClient,
        {
          topic: topic.title,
          members,
        },
        creatorOpenId
      );

      // Step 3: Register with GroupService
      const groupService = getGroupService();
      groupService.registerGroup({
        chatId,
        name: topic.title,
        createdBy: creatorOpenId,
        initialMembers: members || [],
        createdAt: Date.now(),
        isTopicGroup: false,
      });

      // Step 4: Activate the discussion
      const activated = manager.activateDiscussion(record.id, chatId);
      if (!activated) {
        logger.error({ discussionId: record.id, chatId }, 'Failed to activate discussion');
        return {
          success: false,
          discussionId: record.id,
          error: 'Failed to activate discussion',
        };
      }

      logger.info({
        discussionId: record.id,
        chatId,
        topic: topic.title,
        sourceChatId,
      }, 'Discussion created successfully');

      return {
        success: true,
        discussionId: record.id,
        chatId,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({
        err: error,
        discussionId: record.id,
        topic: topic.title,
      }, 'Failed to create discussion');

      return {
        success: false,
        discussionId: record.id,
        error: errorMessage,
      };
    }
  }

  /**
   * Conclude a discussion with results.
   *
   * @param chatId - Discussion group chat ID
   * @param result - Discussion result
   */
  concludeDiscussion(chatId: string, result: DiscussionResult): boolean {
    const manager = getDiscussionManager();
    const record = manager.concludeDiscussion({ chatId, result });

    if (!record) {
      logger.warn({ chatId }, 'Failed to conclude discussion: not found or not active');
      return false;
    }

    logger.info({
      discussionId: record.id,
      chatId,
      outcome: result.outcome,
      actionCount: result.actions?.length ?? 0,
    }, 'Discussion concluded');

    return true;
  }

  /**
   * Get discussion info for a chat ID.
   */
  getDiscussion(chatId: string) {
    const manager = getDiscussionManager();
    return manager.findByChatId(chatId);
  }

  /**
   * List active discussions.
   */
  listActiveDiscussions() {
    const manager = getDiscussionManager();
    return manager.listActiveDiscussions();
  }

  /**
   * Clean up expired discussions.
   *
   * @returns Number of discussions expired
   */
  cleanupExpiredDiscussions(): number {
    const manager = getDiscussionManager();
    return manager.expireStaleDiscussions();
  }

  /**
   * Dispose of the service.
   */
  dispose(): void {
    logger.info('DiscussionService disposed');
  }
}

// Singleton
let serviceInstance: DiscussionService | null = null;

/**
 * Get the global DiscussionService instance.
 */
export function getDiscussionService(): DiscussionService | null {
  return serviceInstance;
}

/**
 * Initialize the global DiscussionService.
 */
export function initDiscussionService(config: DiscussionServiceConfig): DiscussionService {
  if (serviceInstance) {
    serviceInstance.dispose();
  }
  serviceInstance = new DiscussionService(config);
  logger.info('DiscussionService initialized');
  return serviceInstance;
}

/**
 * Reset the global DiscussionService (for testing).
 */
export function resetDiscussionService(): void {
  if (serviceInstance) {
    serviceInstance.dispose();
    serviceInstance = null;
  }
}
