/**
 * GroupService - Manages group chat registry for bot-created groups.
 *
 * Tracks groups created by the bot for management purposes.
 * Stores group metadata in workspace/groups.json.
 *
 * @see Issue #486 - Group management commands
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../utils/logger.js';

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
