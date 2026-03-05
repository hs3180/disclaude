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
 * Options for creating a new group.
 */
export interface CreateGroupOptions {
  /** Group topic/name (optional, auto-generated if not provided) */
  topic?: string;
  /** Initial member open_ids */
  members?: string[];
  /** Creator open_id (will be auto-added if no members) */
  creatorId?: string;
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
   * Options for creating a group.
   */
  createGroup(client: lark.Client, options: CreateGroupOptions = {}): Promise<GroupInfo> {
    return this.createGroupWithClient(client, options);
  }

  /**
   * Create a group with Feishu client and auto-register.
   *
   * This method combines group creation and registration in one operation,
   * making it easier for agents to create groups without going through
   * the command system.
   *
   * @param client - Feishu API client
   * @param options - Group creation options
   * @returns Created group info
   * @throws Error if group creation fails
   *
   * @example
   * ```typescript
   * const groupInfo = await groupService.createGroup(client, {
   *   topic: '讨论组',
   *   members: ['ou_user1', 'ou_user2'],
   *   creatorId: 'ou_creator'
   * });
   * console.log(groupInfo.chatId); // New group chat ID
   * ```
   */
  async createGroupWithClient(
    client: lark.Client,
    options: CreateGroupOptions = {}
  ): Promise<GroupInfo> {
    const { topic, members, creatorId } = options;

    // Create the chat using ChatOps
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

    // Auto-register the group
    this.registerGroup(groupInfo);

    logger.info({ chatId, topic, memberCount: actualMembers.length }, 'Group created and registered');

    return groupInfo;
  }

  /**
   * Get the storage file path.
   */
  getFilePath(): string {
    return this.filePath;
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
