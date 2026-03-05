/**
 * AgentPool - Manages Pilot instances per chatId.
 *
 * This class solves the concurrency issue (Issue #644) where messages
 * were being routed to the wrong agent instance.
 *
 * Key Design:
 * - Each chatId gets its own Pilot instance
 * - Pilot instances are created with chatId bound at construction time
 * - No session management needed inside Pilot (each Pilot = one chatId)
 *
 * Architecture:
 * ```
 * PrimaryNode
 *     └── AgentPool
 *             └── Map<chatId, Pilot>
 *                     └── Each Pilot handles ONE chatId only
 * ```
 */

import type pino from 'pino';
import { createLogger } from '../utils/logger.js';
import type { ChatAgent } from './types.js';

const logger = createLogger('AgentPool');

/**
 * Factory function type for creating Pilot instances.
 */
export type PilotFactory = (chatId: string) => ChatAgent;

/**
 * Configuration for AgentPool.
 */
export interface AgentPoolConfig {
  /** Factory function to create Pilot instances */
  pilotFactory: PilotFactory;
  /** Optional logger */
  logger?: pino.Logger;
}

/**
 * AgentPool - Manages Pilot instances per chatId.
 *
 * Ensures complete isolation between different chat sessions by
 * giving each chatId its own Pilot instance.
 */
export class AgentPool {
  private readonly pilotFactory: PilotFactory;
  private readonly pilots = new Map<string, ChatAgent>();
  private readonly log: pino.Logger;

  constructor(config: AgentPoolConfig) {
    this.pilotFactory = config.pilotFactory;
    this.log = config.logger ?? logger;
  }

  /**
   * Get or create a ChatAgent (Pilot) instance for the given chatId.
   *
   * ChatAgents are long-lived and bound to a specific chatId for conversation context.
   * If a ChatAgent already exists for this chatId, returns it.
   * Otherwise, creates a new ChatAgent using the factory.
   *
   * Note: This method is specifically for ChatAgent (Pilot) lifecycle management.
   * Other agent types (ScheduleAgent, TaskAgent, SkillAgent) should be created
   * directly via their factories and have short lifecycles (max 24 hours).
   *
   * @param chatId - The chat identifier
   * @returns The ChatAgent instance for this chatId
   */
  getOrCreateChatAgent(chatId: string): ChatAgent {
    let pilot = this.pilots.get(chatId);
    if (!pilot) {
      this.log.info({ chatId }, 'Creating new ChatAgent instance for chatId');
      pilot = this.pilotFactory(chatId);
      this.pilots.set(chatId, pilot);
    }
    return pilot;
  }

  /**
   * Check if a Pilot exists for the given chatId.
   *
   * @param chatId - The chat identifier
   * @returns true if a Pilot exists
   */
  has(chatId: string): boolean {
    return this.pilots.has(chatId);
  }

  /**
   * Get an existing Pilot without creating one.
   *
   * @param chatId - The chat identifier
   * @returns The Pilot instance or undefined
   */
  get(chatId: string): ChatAgent | undefined {
    return this.pilots.get(chatId);
  }

  /**
   * Dispose and remove the Pilot for a chatId.
   *
   * This properly disposes the Pilot's resources before removing it.
   *
   * @param chatId - The chat identifier
   * @returns true if a Pilot was disposed, false if not found
   */
  dispose(chatId: string): boolean {
    const pilot = this.pilots.get(chatId);
    if (!pilot) {
      return false;
    }

    this.log.info({ chatId }, 'Disposing Pilot instance for chatId');
    this.pilots.delete(chatId);
    pilot.dispose();
    return true;
  }

  /**
   * Reset the Pilot for a chatId (clear conversation context).
   *
   * If the Pilot exists, calls its reset method.
   *
   * @param chatId - The chat identifier
   */
  reset(chatId: string): void {
    const pilot = this.pilots.get(chatId);
    if (pilot) {
      this.log.debug({ chatId }, 'Resetting Pilot for chatId');
      pilot.reset(chatId);
    }
  }

  /**
   * Get the number of active Pilot instances.
   *
   * @returns Number of pilots
   */
  size(): number {
    return this.pilots.size;
  }

  /**
   * Get all chatIds with active Pilots.
   *
   * @returns Array of chatIds
   */
  getActiveChatIds(): string[] {
    return Array.from(this.pilots.keys());
  }

  /**
   * Dispose all Pilots and clear the pool.
   * Used during shutdown.
   */
  disposeAll(): void {
    this.log.info('Disposing all Pilot instances');

    // Clear map first
    const pilots = Array.from(this.pilots.entries());
    this.pilots.clear();

    // Then dispose all pilots
    for (const [chatId, pilot] of pilots) {
      try {
        pilot.dispose();
        this.log.debug({ chatId }, 'Pilot disposed');
      } catch (err) {
        this.log.error({ err, chatId }, 'Error disposing Pilot');
      }
    }

    this.log.info('All Pilots disposed');
  }
}
