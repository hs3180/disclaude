/**
 * UserStateStore - Persistent user state storage.
 *
 * Stores user-specific states like admin mode status, preferences, etc.
 * Data is persisted to workspace/user-states.json.
 *
 * @see Issue #347 - Dynamic admin mode setup
 */

import fs from 'fs/promises';
import path from 'path';
import { Config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('UserStateStore');

/**
 * User state data structure.
 */
export interface UserState {
  /** User open_id */
  userId: string;
  /** Chat ID where user interacts */
  chatId: string;
  /** Whether admin mode is enabled */
  adminModeEnabled: boolean;
  /** Log chat ID for admin mode (if created) */
  logChatId?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
  /** Last updated timestamp */
  updatedAt: string;
}

/**
 * All user states indexed by userId.
 */
interface UserStatesData {
  [userId: string]: UserState;
}

/**
 * UserStateStore - Manages persistent user states.
 */
export class UserStateStore {
  private states: UserStatesData = {};
  private filePath: string;
  private initialized = false;

  constructor() {
    const workspaceDir = Config.getWorkspaceDir();
    this.filePath = path.join(workspaceDir, 'user-states.json');
  }

  /**
   * Initialize the store by loading existing data.
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const data = await fs.readFile(this.filePath, 'utf-8');
      this.states = JSON.parse(data);
      logger.info({ userCount: Object.keys(this.states).length }, 'User states loaded');
    } catch (_error) {
      // File doesn't exist or is invalid, start fresh
      this.states = {};
      logger.info('Starting with empty user states');
    }

    this.initialized = true;
  }

  /**
   * Get user state by user ID.
   */
  get(userId: string): UserState | undefined {
    return this.states[userId];
  }

  /**
   * Get or create user state.
   */
  getOrCreate(userId: string, chatId: string): UserState {
    if (!this.states[userId]) {
      this.states[userId] = {
        userId,
        chatId,
        adminModeEnabled: false,
        updatedAt: new Date().toISOString(),
      };
    }
    return this.states[userId];
  }

  /**
   * Update user state.
   */
  async update(userId: string, updates: Partial<Omit<UserState, 'userId' | 'updatedAt'>>): Promise<UserState> {
    const state = this.states[userId];
    if (!state) {
      throw new Error(`User state not found: ${userId}`);
    }

    Object.assign(state, updates, { updatedAt: new Date().toISOString() });
    await this.save();

    logger.info({ userId, updates }, 'User state updated');
    return state;
  }

  /**
   * Set admin mode status.
   */
  async setAdminMode(userId: string, enabled: boolean, logChatId?: string): Promise<UserState> {
    const state = this.getOrCreate(userId, '');
    state.adminModeEnabled = enabled;
    if (logChatId) {
      state.logChatId = logChatId;
    }
    state.updatedAt = new Date().toISOString();
    await this.save();

    logger.info({ userId, enabled, logChatId }, 'Admin mode updated');
    return state;
  }

  /**
   * Check if admin mode is enabled for a user.
   */
  isAdminModeEnabled(userId: string): boolean {
    return this.states[userId]?.adminModeEnabled ?? false;
  }

  /**
   * Get log chat ID for a user (if admin mode is enabled).
   */
  getLogChatId(userId: string): string | undefined {
    const state = this.states[userId];
    if (state?.adminModeEnabled) {
      return state.logChatId;
    }
    return undefined;
  }

  /**
   * Get all users with admin mode enabled.
   */
  getAdminUsers(): UserState[] {
    return Object.values(this.states).filter((state) => state.adminModeEnabled);
  }

  /**
   * Remove user state.
   */
  async remove(userId: string): Promise<void> {
    delete this.states[userId];
    await this.save();
    logger.info({ userId }, 'User state removed');
  }

  /**
   * Save states to file.
   */
  private async save(): Promise<void> {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.filePath);
      await fs.mkdir(dir, { recursive: true });

      await fs.writeFile(this.filePath, JSON.stringify(this.states, null, 2), 'utf-8');
    } catch (error) {
      logger.error({ err: error }, 'Failed to save user states');
      throw error;
    }
  }

  /**
   * Clear all states (for testing).
   */
  clear(): void {
    this.states = {};
    this.initialized = false;
  }
}

// Singleton instance
export const userStateStore = new UserStateStore();
