/**
 * Admin Status Manager - Manages dynamic admin status for users.
 *
 * This module implements the dynamic admin settings feature from Issue #347:
 * - Users can request to receive all operational messages
 * - Bot automatically creates/reuses log chat groups
 * - Users can stop receiving operational messages
 *
 * @see Issue #347
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../utils/logger.js';
import { Config } from '../config/index.js';

const logger = createLogger('AdminStatusManager');

/**
 * Admin status for a user.
 */
export interface AdminStatus {
  /** User ID */
  userId: string;
  /** Whether admin mode is enabled */
  enabled: boolean;
  /** Log chat ID for operational messages */
  logChatId?: string;
  /** When the admin status was created */
  createdAt: string;
  /** When the admin status was last updated */
  updatedAt: string;
}

/**
 * Admin status storage structure.
 */
interface AdminStatusStorage {
  /** Map of user ID to admin status */
  users: Record<string, AdminStatus>;
  /** Version for migration support */
  version: number;
}

/**
 * Options for AdminStatusManager.
 */
export interface AdminStatusManagerOptions {
  /** Storage file path (default: workspace/.admin-status.json) */
  storagePath?: string;
}

/**
 * Manager for dynamic admin status.
 *
 * Provides functionality to:
 * - Enable/disable admin mode for users
 * - Associate log chat IDs with users
 * - Persist admin status to disk
 *
 * @example
 * ```typescript
 * const manager = new AdminStatusManager();
 *
 * // Enable admin mode for a user
 * await manager.enableAdmin('user_123', 'log_chat_456');
 *
 * // Check if user is admin
 * const status = manager.getAdminStatus('user_123');
 * console.log(status?.enabled); // true
 *
 * // Disable admin mode
 * await manager.disableAdmin('user_123');
 * ```
 */
export class AdminStatusManager {
  private readonly storagePath: string;
  private storage: AdminStatusStorage;
  private initialized = false;

  constructor(options: AdminStatusManagerOptions = {}) {
    this.storagePath = options.storagePath ?? path.join(Config.getWorkspaceDir(), '.admin-status.json');
    this.storage = { users: {}, version: 1 };
  }

  /**
   * Initialize the manager by loading storage from disk.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      if (fs.existsSync(this.storagePath)) {
        const content = await fs.promises.readFile(this.storagePath, 'utf-8');
        this.storage = JSON.parse(content);
        logger.info({ userCount: Object.keys(this.storage.users).length }, 'Loaded admin status storage');
      } else {
        logger.info('No existing admin status storage, starting fresh');
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to load admin status storage, starting fresh');
      this.storage = { users: {}, version: 1 };
    }

    this.initialized = true;
  }

  /**
   * Save storage to disk.
   */
  private async save(): Promise<void> {
    try {
      await fs.promises.writeFile(
        this.storagePath,
        JSON.stringify(this.storage, null, 2),
        'utf-8'
      );
      logger.debug({ path: this.storagePath }, 'Saved admin status storage');
    } catch (error) {
      logger.error({ error, path: this.storagePath }, 'Failed to save admin status storage');
      throw error;
    }
  }

  /**
   * Ensure manager is initialized.
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      logger.warn('AdminStatusManager not initialized, auto-initializing');
      this.storage = { users: {}, version: 1 };
      this.initialized = true;
    }
  }

  /**
   * Enable admin mode for a user.
   *
   * @param userId - User ID
   * @param logChatId - Optional log chat ID for operational messages
   * @returns The updated admin status
   */
  async enableAdmin(userId: string, logChatId?: string): Promise<AdminStatus> {
    this.ensureInitialized();

    const now = new Date().toISOString();
    const existing = this.storage.users[userId];

    const status: AdminStatus = {
      userId,
      enabled: true,
      logChatId: logChatId ?? existing?.logChatId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.storage.users[userId] = status;
    await this.save();

    logger.info({ userId, logChatId: status.logChatId }, 'Enabled admin mode for user');
    return status;
  }

  /**
   * Disable admin mode for a user.
   *
   * @param userId - User ID
   * @returns The updated admin status, or undefined if user wasn't admin
   */
  async disableAdmin(userId: string): Promise<AdminStatus | undefined> {
    this.ensureInitialized();

    const existing = this.storage.users[userId];
    if (!existing) {
      return undefined;
    }

    const status: AdminStatus = {
      ...existing,
      enabled: false,
      updatedAt: new Date().toISOString(),
    };

    this.storage.users[userId] = status;
    await this.save();

    logger.info({ userId }, 'Disabled admin mode for user');
    return status;
  }

  /**
   * Get admin status for a user.
   *
   * @param userId - User ID
   * @returns Admin status, or undefined if not set
   */
  getAdminStatus(userId: string): AdminStatus | undefined {
    this.ensureInitialized();
    return this.storage.users[userId];
  }

  /**
   * Check if a user has admin mode enabled.
   *
   * @param userId - User ID
   * @returns true if admin mode is enabled
   */
  isAdminEnabled(userId: string): boolean {
    const status = this.getAdminStatus(userId);
    return status?.enabled ?? false;
  }

  /**
   * Get the log chat ID for a user.
   *
   * @param userId - User ID
   * @returns Log chat ID, or undefined if not set
   */
  getLogChatId(userId: string): string | undefined {
    const status = this.getAdminStatus(userId);
    return status?.logChatId;
  }

  /**
   * Set the log chat ID for a user.
   *
   * @param userId - User ID
   * @param logChatId - Log chat ID
   * @returns The updated admin status
   */
  async setLogChatId(userId: string, logChatId: string): Promise<AdminStatus> {
    this.ensureInitialized();

    const now = new Date().toISOString();
    const existing = this.storage.users[userId];

    const status: AdminStatus = {
      userId,
      enabled: existing?.enabled ?? false,
      logChatId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.storage.users[userId] = status;
    await this.save();

    logger.info({ userId, logChatId }, 'Set log chat ID for user');
    return status;
  }

  /**
   * Get all users with admin mode enabled.
   *
   * @returns Array of admin statuses
   */
  getAllAdmins(): AdminStatus[] {
    this.ensureInitialized();
    return Object.values(this.storage.users).filter((s) => s.enabled);
  }

  /**
   * Remove a user's admin status entirely.
   *
   * @param userId - User ID
   */
  async removeAdmin(userId: string): Promise<void> {
    this.ensureInitialized();

    if (this.storage.users[userId]) {
      delete this.storage.users[userId];
      await this.save();
      logger.info({ userId }, 'Removed admin status for user');
    }
  }

  /**
   * Clear all admin statuses.
   */
  async clearAll(): Promise<void> {
    this.ensureInitialized();
    this.storage.users = {};
    await this.save();
    logger.info('Cleared all admin statuses');
  }
}

// Singleton instance
let defaultInstance: AdminStatusManager | undefined;

/**
 * Get the default AdminStatusManager instance.
 */
export function getAdminStatusManager(): AdminStatusManager {
  if (!defaultInstance) {
    defaultInstance = new AdminStatusManager();
  }
  return defaultInstance;
}

/**
 * Reset the default instance (for testing).
 */
export function resetAdminStatusManager(): void {
  defaultInstance = undefined;
}
