/**
 * AgentPool - Manages Pilot instances per chatId.
 *
 * This class solves the concurrency issue (Issue #644) where messages
 * were being routed to the wrong agent instance.
 *
 * Issue #711: Distinguishes ChatAgent from other Agent types:
 * - ChatAgent (Pilot): Long-lived, bound to chatId, stored in AgentPool
 * - SkillAgent/ScheduleAgent/TaskAgent: Short-lived, not stored
 *
 * Key Design:
 * - Each chatId gets its own Pilot instance
 * - Pilot instances are created with chatId bound at construction time
 * - No session management needed inside Pilot (each Pilot = one chatId)
 * - Other agent types are created on-demand and NOT stored
 *
 * Architecture:
 * ```
 * PrimaryNode
 *     └── AgentPool
 *             └── Map<chatId, Pilot>  (ChatAgent only)
 *                     └── Each Pilot handles ONE chatId only
 * ```
 *
 * Lifecycle Management (Issue #711):
 * | Agent Type     | chatId Binding | Max Lifetime | Storage Location          |
 * |----------------|----------------|--------------|---------------------------|
 * | ChatAgent      | ✅ Yes         | Unlimited    | AgentPool (Map<chatId, Pilot>) |
 * | SkillAgent     | ❌ No          | Task done    | Not stored (caller manages) |
 * | ScheduleAgent  | ❌ No          | 24 hours     | Not stored                |
 * | TaskAgent      | ❌ No          | Task done    | Not stored                |
 */

import type pino from 'pino';
import { createLogger } from '../utils/logger.js';
import type { ChatAgent, SkillAgent } from './types.js';
import { AgentFactory } from './factory.js';

const logger = createLogger('AgentPool');

/**
 * Factory function type for creating Pilot instances.
 */
export type PilotFactory = (chatId: string) => ChatAgent;

/**
 * Factory function type for creating SkillAgent instances.
 */
export type SkillAgentFactory = (skillName: string) => Promise<SkillAgent>;

/**
 * Configuration for AgentPool.
 */
export interface AgentPoolConfig {
  /** Factory function to create Pilot instances */
  pilotFactory: PilotFactory;
  /** Optional factory function to create SkillAgent instances (defaults to AgentFactory) */
  skillAgentFactory?: SkillAgentFactory;
  /** Optional logger */
  logger?: pino.Logger;
}

/**
 * AgentPool - Manages Pilot instances per chatId.
 *
 * Ensures complete isolation between different chat sessions by
 * giving each chatId its own Pilot instance.
 *
 * Issue #711: Distinguishes ChatAgent from other Agent types.
 * - ChatAgent: Long-lived, stored in pool
 * - SkillAgent/ScheduleAgent/TaskAgent: Short-lived, not stored
 */
export class AgentPool {
  private readonly pilotFactory: PilotFactory;
  private readonly skillAgentFactory: SkillAgentFactory;
  private readonly pilots = new Map<string, ChatAgent>();
  private readonly log: pino.Logger;

  constructor(config: AgentPoolConfig) {
    this.pilotFactory = config.pilotFactory;
    this.skillAgentFactory = config.skillAgentFactory ?? this.defaultSkillAgentFactory;
    this.log = config.logger ?? logger;
  }

  /**
   * Default SkillAgent factory using AgentFactory.
   */
  private async defaultSkillAgentFactory(skillName: string): Promise<SkillAgent> {
    return AgentFactory.createSkillAgent(skillName);
  }

  // ============================================================================
  // ChatAgent Management (Issue #711)
  // ============================================================================

  /**
   * Get or create a ChatAgent (Pilot) instance for the given chatId.
   *
   * Issue #711: This is the primary method for ChatAgent management.
   * ChatAgents are long-lived and stored in the pool.
   *
   * If a Pilot already exists for this chatId, returns it.
   * Otherwise, creates a new Pilot using the factory.
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
   * Get or create a Pilot instance for the given chatId.
   *
   * @deprecated Use getOrCreateChatAgent() instead. This method will be removed in v0.5.0.
   * @param chatId - The chat identifier
   * @returns The Pilot instance for this chatId
   */
  getOrCreate(chatId: string): ChatAgent {
    return this.getOrCreateChatAgent(chatId);
  }

  // ============================================================================
  // SkillAgent Management (Issue #711)
  // ============================================================================

  /**
   * Create a SkillAgent for a specific skill.
   *
   * Issue #711: SkillAgents are short-lived and NOT stored in the pool.
   * The caller is responsible for disposing the agent after use.
   * Recommended to dispose within 24 hours.
   *
   * @param skillName - The skill name (e.g., 'next-step', 'evaluator')
   * @returns The SkillAgent instance (NOT stored in pool)
   */
  async createSkillAgent(skillName: string): Promise<SkillAgent> {
    this.log.debug({ skillName }, 'Creating SkillAgent (not stored in pool)');
    return this.skillAgentFactory(skillName);
  }

  // ============================================================================
  // Legacy Methods (backward compatibility)
  // ============================================================================

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
