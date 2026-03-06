/**
 * Cooldown State - Manages cooldown periods for scheduled tasks.
 *
 * Issue #869: 定时任务增加冷静期设计
 *
 * Features:
 * - File-based persistence (survives service restarts)
 * - Per-task cooldown tracking
 * - Automatic expiration check
 * - Manual cooldown clearing
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('CooldownState');

/**
 * Default cooldown period in milliseconds (5 minutes).
 */
export const DEFAULT_COOLDOWN_PERIOD = 5 * 60 * 1000;

/**
 * Cooldown entry for a task.
 */
export interface CooldownEntry {
  /** Task ID */
  taskId: string;
  /** Last execution timestamp (ISO string) */
  lastExecutedAt: string;
  /** Cooldown period in milliseconds */
  cooldownPeriod: number;
}

/**
 * All cooldown entries indexed by task ID.
 */
interface CooldownStateFile {
  [taskId: string]: CooldownEntry;
}

/**
 * Cooldown check result.
 */
export interface CooldownStatus {
  /** Whether the task is in cooldown */
  inCooldown: boolean;
  /** Last execution time (if any) */
  lastExecutedAt?: string;
  /** Cooldown end time (if in cooldown) */
  cooldownEndsAt?: string;
  /** Remaining cooldown time in milliseconds (if in cooldown) */
  remainingMs?: number;
}

/**
 * CooldownStateManager - Manages cooldown periods for scheduled tasks.
 *
 * Uses file-based persistence to survive service restarts.
 * State is stored in `workspace/schedules-state/cooldown.json`.
 *
 * Usage:
 * ```typescript
 * const cooldownManager = new CooldownStateManager();
 *
 * // Check if task is in cooldown
 * const status = await cooldownManager.getStatus('schedule-daily-report');
 * if (status.inCooldown) {
 *   console.log(`Task in cooldown, ends at ${status.cooldownEndsAt}`);
 * }
 *
 * // Record execution (starts cooldown)
 * await cooldownManager.recordExecution('schedule-daily-report', 300000);
 *
 * // Clear cooldown manually
 * await cooldownManager.clearCooldown('schedule-daily-report');
 * ```
 */
export class CooldownStateManager {
  private readonly stateDir: string;
  private readonly stateFile: string;
  private cache: CooldownStateFile | null = null;

  constructor(baseDir?: string) {
    const workspaceDir = baseDir || Config.getWorkspaceDir();
    this.stateDir = path.join(workspaceDir, 'schedules-state');
    this.stateFile = path.join(this.stateDir, 'cooldown.json');
  }

  /**
   * Ensure state directory exists.
   */
  private async ensureStateDir(): Promise<void> {
    try {
      await fs.mkdir(this.stateDir, { recursive: true });
    } catch (error) {
      logger.error({ err: error }, 'Failed to create cooldown state directory');
    }
  }

  /**
   * Load state from disk.
   */
  private async loadState(): Promise<CooldownStateFile> {
    if (this.cache) {
      return this.cache;
    }

    try {
      const content = await fs.readFile(this.stateFile, 'utf-8');
      const parsed = JSON.parse(content) as CooldownStateFile;
      this.cache = parsed;
      return this.cache;
    } catch {
      // File doesn't exist or is invalid
      this.cache = {} as CooldownStateFile;
      return this.cache;
    }
  }

  /**
   * Save state to disk.
   */
  private async saveState(state: CooldownStateFile): Promise<void> {
    await this.ensureStateDir();
    await fs.writeFile(this.stateFile, JSON.stringify(state, null, 2), 'utf-8');
    this.cache = state;
  }

  /**
   * Check if a task is in cooldown.
   *
   * @param taskId - Task ID to check
   * @returns Cooldown status
   */
  async getStatus(taskId: string): Promise<CooldownStatus> {
    const state = await this.loadState();
    const entry = state[taskId];

    if (!entry) {
      return { inCooldown: false };
    }

    const lastExecuted = new Date(entry.lastExecutedAt).getTime();
    const cooldownEnds = lastExecuted + entry.cooldownPeriod;
    const now = Date.now();

    if (now < cooldownEnds) {
      const remainingMs = cooldownEnds - now;
      return {
        inCooldown: true,
        lastExecutedAt: entry.lastExecutedAt,
        cooldownEndsAt: new Date(cooldownEnds).toISOString(),
        remainingMs,
      };
    }

    // Cooldown expired
    return {
      inCooldown: false,
      lastExecutedAt: entry.lastExecutedAt,
    };
  }

  /**
   * Record task execution (starts cooldown).
   *
   * @param taskId - Task ID
   * @param cooldownPeriod - Cooldown period in milliseconds
   */
  async recordExecution(taskId: string, cooldownPeriod: number): Promise<void> {
    const state = await this.loadState();
    const now = new Date().toISOString();

    state[taskId] = {
      taskId,
      lastExecutedAt: now,
      cooldownPeriod,
    };

    await this.saveState(state);
    logger.info({ taskId, cooldownPeriod }, 'Recorded task execution, cooldown started');
  }

  /**
   * Clear cooldown for a task.
   *
   * @param taskId - Task ID
   * @returns true if cooldown was cleared, false if not in cooldown
   */
  async clearCooldown(taskId: string): Promise<boolean> {
    const state = await this.loadState();

    if (!state[taskId]) {
      return false;
    }

    delete state[taskId];
    await this.saveState(state);
    logger.info({ taskId }, 'Cleared cooldown for task');
    return true;
  }

  /**
   * Get all tasks currently in cooldown.
   *
   * @returns Map of task IDs to cooldown entries
   */
  async getAllInCooldown(): Promise<Map<string, CooldownEntry>> {
    const state = await this.loadState();
    const now = Date.now();
    const result = new Map<string, CooldownEntry>();

    for (const [taskId, entry] of Object.entries(state)) {
      const lastExecuted = new Date(entry.lastExecutedAt).getTime();
      const cooldownEnds = lastExecuted + entry.cooldownPeriod;

      if (now < cooldownEnds) {
        result.set(taskId, entry);
      }
    }

    return result;
  }

  /**
   * Clean up expired cooldown entries.
   *
   * @returns Number of entries removed
   */
  async cleanupExpired(): Promise<number> {
    const state = await this.loadState();
    const now = Date.now();
    let removed = 0;

    for (const [taskId, entry] of Object.entries(state)) {
      const lastExecuted = new Date(entry.lastExecutedAt).getTime();
      const cooldownEnds = lastExecuted + entry.cooldownPeriod;

      // Remove entries that expired more than 24 hours ago
      if (now > cooldownEnds + 24 * 60 * 60 * 1000) {
        delete state[taskId];
        removed++;
      }
    }

    if (removed > 0) {
      await this.saveState(state);
      logger.info({ removed }, 'Cleaned up expired cooldown entries');
    }

    return removed;
  }

  /**
   * Clear the in-memory cache (for testing).
   */
  clearCache(): void {
    this.cache = null;
  }
}

// Singleton instance
let cooldownStateManagerInstance: CooldownStateManager | undefined;

/**
 * Get the global CooldownStateManager instance.
 */
export function getCooldownStateManager(): CooldownStateManager {
  if (!cooldownStateManagerInstance) {
    cooldownStateManagerInstance = new CooldownStateManager();
  }
  return cooldownStateManagerInstance;
}

/**
 * Reset the global CooldownStateManager (for testing).
 */
export function resetCooldownStateManager(): void {
  cooldownStateManagerInstance = undefined;
}
