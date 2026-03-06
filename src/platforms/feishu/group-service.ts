/**
 * GroupService - Manages group chat registry for bot-created groups.
 *
 * Tracks groups created by the bot for management purposes.
 * Stores group metadata in workspace/groups.json.
 *
 * @see Issue #486 - Group management commands
 * @see Issue #692 - GroupService.createGroup() method
 */

import type * as lark from '@larksuiteoapi/node-sdk';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../utils/logger.js';
import { createDiscussionChat } from './chat-ops.js';

const logger = createLogger('GroupService');

/**
 * Group metadata.
 */
export interface GroupInfo {
  /** Group chat ID */
  chatId: string;
  /** Group name/topic */
  name: string;
  /** Creation timestamp */
  createdAt: number;
  /** Creator open_id */
  createdBy?: string;
  /** Initial members */
  initialMembers: string[];
  /**
   * Whether this is a topic group (BBS mode).
   * Topic groups support agent-initiated messages and don't expect user responses.
   *
   * @see Issue #721 - 话题群基础设施
   */
  isTopicGroup?: boolean;
}

/**
 * Options for creating a group.
 *
 * @see Issue #692 - GroupService 支持创建群聊
 */
export interface CreateGroupOptions {
  /** Chat topic/name (optional, auto-generated if not provided) */
  topic?: string;
  /** Initial member open_ids (optional, creator will be auto-added) */
  members?: string[];
  /** Creator open_id (optional, used for auto-adding and tracking) */
  creatorId?: string;
}

/**
 * Group registry storage format.
 */
interface GroupRegistry {
  /** Version for future migrations */
  version: number;
  /** Groups indexed by chatId */
  groups: Record<string, GroupInfo>;
}

/**
 * GroupService configuration.
 */
export interface GroupServiceConfig {
  /** Storage file path (default: workspace/groups.json) */
  filePath?: string;
}

/**
 * Service for managing bot-created groups.
 *
 * Features:
 * - Track groups created by bot
 * - Persist group metadata
 * - List managed groups
 */
export class GroupService {
  private filePath: string;
  private registry: GroupRegistry;

  constructor(config: GroupServiceConfig = {}) {
    this.filePath = config.filePath || path.join(process.cwd(), 'workspace', 'groups.json');
    this.registry = this.load();
  }

  /**
   * Load registry from file.
   */
  private load(): GroupRegistry {
    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        const data = JSON.parse(content) as GroupRegistry;
        logger.info({ groupCount: Object.keys(data.groups || {}).length }, 'Group registry loaded');
        return data;
      }
    } catch (error) {
      logger.warn({ err: error }, 'Failed to load group registry, starting fresh');
    }
    return { version: 1, groups: {} };
  }

  /**
   * Save registry to file.
   */
  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.registry, null, 2));
      logger.debug({ groupCount: Object.keys(this.registry.groups).length }, 'Group registry saved');
    } catch (error) {
      logger.error({ err: error }, 'Failed to save group registry');
    }
  }

  /**
   * Register a new group.
   *
   * @param info - Group information
   */
  registerGroup(info: GroupInfo): void {
    this.registry.groups[info.chatId] = info;
    this.save();
    logger.info({ chatId: info.chatId, name: info.name }, 'Group registered');
  }

  /**
   * Unregister a group.
   *
   * @param chatId - Group chat ID
   * @returns Whether the group was removed
   */
  unregisterGroup(chatId: string): boolean {
    if (this.registry.groups[chatId]) {
      delete this.registry.groups[chatId];
      this.save();
      logger.info({ chatId }, 'Group unregistered');
      return true;
    }
    return false;
  }

  /**
   * Get group info.
   *
   * @param chatId - Group chat ID
   * @returns Group info or undefined
   */
  getGroup(chatId: string): GroupInfo | undefined {
    return this.registry.groups[chatId];
  }

  /**
   * Check if a group is managed.
   *
   * @param chatId - Group chat ID
   */
  isManaged(chatId: string): boolean {
    return chatId in this.registry.groups;
  }

  /**
   * List all managed groups.
   *
   * @returns Array of group info
   */
  listGroups(): GroupInfo[] {
    return Object.values(this.registry.groups);
  }

  /**
   * Mark or unmark a group as a topic group (BBS mode).
   *
   * Topic groups support agent-initiated messages and don't expect user responses.
   * This is useful for BBS-style discussions like daily questions or topic posts.
   *
   * @param chatId - Group chat ID
   * @param isTopic - Whether to mark as topic group (default: true)
   * @returns Whether the operation succeeded
   *
   * @see Issue #721 - 话题群基础设施
   */
  markAsTopicGroup(chatId: string, isTopic: boolean = true): boolean {
    const group = this.registry.groups[chatId];
    if (!group) {
      logger.warn({ chatId }, 'Cannot mark as topic group: group not found');
      return false;
    }

    if (isTopic) {
      group.isTopicGroup = true;
    } else {
      delete group.isTopicGroup;
    }
    this.save();

    logger.info({ chatId, name: group.name, isTopicGroup: isTopic }, 'Group topic status updated');
    return true;
  }

  /**
   * Check if a group is a topic group.
   *
   * @param chatId - Group chat ID
   * @returns Whether the group is a topic group
   *
   * @see Issue #721 - 话题群基础设施
   */
  isTopicGroup(chatId: string): boolean {
    const group = this.registry.groups[chatId];
    return group?.isTopicGroup === true;
  }

  /**
   * List all topic groups.
   *
   * @returns Array of topic group info
   *
   * @see Issue #721 - 话题群基础设施
   */
  listTopicGroups(): GroupInfo[] {
    return Object.values(this.registry.groups).filter(g => g.isTopicGroup === true);
  }

  /**
   * Batch mark or unmark multiple groups as topic groups.
   *
   * This is useful for managing topic groups in bulk, especially when
   * integrating with external systems or performing batch operations.
   *
   * @param chatIds - Array of chat IDs to update
   * @param isTopic - Whether to mark as topic groups (default: true)
   * @returns Object with success count and failed chat IDs
   *
   * @see Issue #873 - 话题群扩展 - 批量管理
   */
  markMultipleAsTopicGroups(
    chatIds: string[],
    isTopic: boolean = true
  ): { successCount: number; failedChatIds: string[] } {
    let successCount = 0;
    const failedChatIds: string[] = [];

    for (const chatId of chatIds) {
      const success = this.markAsTopicGroup(chatId, isTopic);
      if (success) {
        successCount++;
      } else {
        failedChatIds.push(chatId);
      }
    }

    logger.info(
      { successCount, failedCount: failedChatIds.length, isTopic },
      'Batch topic group operation completed'
    );

    return { successCount, failedChatIds };
  }

  /**
   * Get all non-topic groups (regular groups).
   *
   * Useful for identifying groups that could be converted to topic groups.
   *
   * @returns Array of non-topic group info
   *
   * @see Issue #873 - 话题群扩展
   */
  listNonTopicGroups(): GroupInfo[] {
    return Object.values(this.registry.groups).filter(g => g.isTopicGroup !== true);
  }

  /**
   * Get the storage file path.
   */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Create a new group chat and register it.
   *
   * This method combines the create and register operations into a single call,
   * making it easier for agents to create groups without dealing with the
   * command system.
   *
   * @param client - Feishu API client
   * @param options - Group creation options
   * @returns The created group info
   * @throws Error if group creation fails
   *
   * @see Issue #692 - GroupService 支持创建群聊
   */
  async createGroup(client: lark.Client, options: CreateGroupOptions = {}): Promise<GroupInfo> {
    const { topic, members, creatorId } = options;

    // Create the chat via Feishu API
    const chatId = await createDiscussionChat(client, { topic, members }, creatorId);

    // Determine actual members for registration
    const actualMembers = members && members.length > 0
      ? members
      : (creatorId ? [creatorId] : []);

    // Build group info
    const groupInfo: GroupInfo = {
      chatId,
      name: topic || '自动命名',
      createdAt: Date.now(),
      createdBy: creatorId,
      initialMembers: actualMembers,
    };

    // Register the group
    this.registerGroup(groupInfo);

    logger.info({ chatId, topic, memberCount: actualMembers.length }, 'Group created and registered via GroupService');

    return groupInfo;
  }
}

// Singleton instance for convenience
let defaultInstance: GroupService | undefined;

/**
 * Get the default GroupService instance.
 */
export function getGroupService(): GroupService {
  if (!defaultInstance) {
    defaultInstance = new GroupService();
  }
  return defaultInstance;
}
