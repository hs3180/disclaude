/**
 * Debug Group Service - Manages the debug group setting.
 *
 * This service provides a simple in-memory storage for the debug group chat ID.
 * The debug group is where debug-level messages are sent.
 *
 * Features:
 * - Single instance pattern - only one debug group per bot instance
 * - Memory-only storage - resets on restart
 * - Automatic transfer - setting a new group overwrites the previous one
 *
 * Issue #487: Debug group management
 * Issue #1040: Migrated to @disclaude/primary-node
 */

import { createLogger } from '@disclaude/core';

const logger = createLogger('DebugGroupService');

/**
 * Debug group configuration.
 */
export interface DebugGroupInfo {
  /** The chat ID of the debug group */
  chatId: string;

  /** The name of the debug group (if available) */
  name?: string;

  /** When the debug group was set */
  setAt: number;
}

/**
 * Debug Group Service - manages the debug group setting.
 */
export class DebugGroupService {
  private debugGroup: DebugGroupInfo | null = null;

  /**
   * Set the debug group.
   * @param chatId - The chat ID of the debug group
   * @param name - Optional name of the group
   * @returns The previous debug group info if there was one, null otherwise
   */
  setDebugGroup(chatId: string, name?: string): DebugGroupInfo | null {
    const previous = this.debugGroup;

    this.debugGroup = {
      chatId,
      name,
      setAt: Date.now(),
    };

    logger.info({ chatId, name, previousChatId: previous?.chatId }, 'Debug group set');

    return previous;
  }

  /**
   * Get the current debug group info.
   * @returns The current debug group info, or null if not set
   */
  getDebugGroup(): DebugGroupInfo | null {
    return this.debugGroup;
  }

  /**
   * Clear the debug group setting.
   * @returns The previous debug group info if there was one, null otherwise
   */
  clearDebugGroup(): DebugGroupInfo | null {
    const previous = this.debugGroup;
    this.debugGroup = null;

    logger.info({ previousChatId: previous?.chatId }, 'Debug group cleared');

    return previous;
  }

  /**
   * Check if a chat ID is the debug group.
   * @param chatId - The chat ID to check
   * @returns True if the chat ID is the debug group
   */
  isDebugGroup(chatId: string): boolean {
    return this.debugGroup?.chatId === chatId;
  }
}

// Singleton instance
let debugGroupService: DebugGroupService | null = null;

/**
 * Get the singleton DebugGroupService instance.
 */
export function getDebugGroupService(): DebugGroupService {
  if (!debugGroupService) {
    debugGroupService = new DebugGroupService();
  }
  return debugGroupService;
}

/**
 * Reset the singleton instance (for testing).
 */
export function resetDebugGroupService(): void {
  debugGroupService = null;
}
