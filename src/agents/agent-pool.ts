/**
 * AgentPool - Manage Pilot lifecycle by chatId into Pilot instances.
 *
 * This solves the concurrent issue where multiple chatId may
 * use the same Pilot instance, avoiding message routing confusion.
 *
 * Architecture:
 * ```
 *  PrimaryNode.ts                ┌──────────────────────────┐
 *  REST Channel (handleRequest)  │   ┌─────────────────────┐ │
 *                               │   │       AgentPool      │ │
 *                               │   │  ┌───────────────┐  │ │
 *                               │   │  │ Pilot (A)     │  │ │
 *                               │   │  └───────────────┘  │ │
 *                               │   │  ┌───────────────┐  │ │
 *                               │   │  │ Pilot (B)     │  │ │
 *                               │   │  └───────────────┘  │ │
 *                               │   └─────────────────────┘ │
 *                               └──────────────────────────┘
 *
 * In the architecture:
 * - PrimaryNode uses AgentPool instead of a single shared Pilot
 * - Each chatId gets its own Pilot instance
 * - Pilot instances are completely isolated
 */

import { createLogger } from '../utils/logger.js';
import { AgentFactory } from './index.js';
import type { ChatAgent } from './types.js';
import type { PilotCallbacks } from './pilot.js';

const logger = createLogger('AgentPool');

/**
 * Represents an active pilot session.
 */
interface AgentSession {
  pilot: ChatAgent;
  createdAt: Date;
}

/**
 * Configuration for AgentPool.
 */
export interface AgentPoolConfig {
  /** Callbacks for creating Pilot instances */
  callbacks: PilotCallbacks;
  /** Logger instance */
  logger?: ReturnType<typeof createLogger>;
}

/**
 * AgentPool - Manages Pilot lifecycle by chatId.
 *
 * Each chatId gets its own independent Pilot instance, ensuring
 * message routing isolation and preventing cross-chatId interference.
 */
export class AgentPool {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly callbacks: PilotCallbacks;
  private readonly logger: typeof logger;

  constructor(config: AgentPoolConfig) {
    this.callbacks = config.callbacks;
    this.logger = config.logger || logger;
  }

  /**
   * Check if a pilot exists for the given chatId.
   */
  has(chatId: string): boolean {
    return this.sessions.has(chatId);
  }

  /**
   * Get an existing pilot for the chatId.
   * Returns undefined if no pilot exists.
   */
  get(chatId: string): ChatAgent | undefined {
    return this.sessions.get(chatId)?.pilot;
  }

  /**
   * Get or create a pilot for the chatId.
   * Creates a new Pilot if one doesn't exist.
   *
   * IMPORTANT: The chatId is bound at pilot creation time, ensuring
   * callbacks always use the correct chatId.
   *
   * @param chatId - The chatId to create a pilot for
   * @returns The pilot instance
   */
  getOrCreate(chatId: string): ChatAgent {
    let session = this.sessions.get(chatId);
    if (!session) {
      // Create new pilot with chatId bound in callbacks
      // Each chatId gets its own Pilot instance, preventing message routing confusion
      const pilot = AgentFactory.createChatAgent('pilot', {
        sendMessage: (text: string, parentMessageId?: string): Promise<void> => {
          return this.callbacks.sendMessage(chatId, text, parentMessageId);
        },
        sendCard: (card: Record<string, unknown>, description?: string, parentMessageId?: string): Promise<void> => {
          return this.callbacks.sendCard(chatId, card, description, parentMessageId);
        },
        sendFile: (filePath: string): Promise<void> => {
          return this.callbacks.sendFile(chatId, filePath);
        },
        onDone: (parentMessageId?: string): Promise<void> => {
          return this.callbacks.onDone?.(chatId, parentMessageId) ?? Promise.resolve();
        },
        getCapabilities: () => {
          return this.callbacks.getCapabilities?.(chatId);
        },
      });

      session = { pilot, createdAt: new Date() };
      this.sessions.set(chatId, session);
      this.logger.info({ chatId }, 'AgentPool: Created new pilot');
    }
    return session!.pilot;
  }

  /**
   * Delete a pilot for the chatId.
   *
   * @param chatId - The chat identifier
   * @returns true if pilot was deleted, false if it didn't exist
   */
  delete(chatId: string): boolean {
    const session = this.sessions.get(chatId);
    if (!session) {
      return false;
    }

    // Remove from map FIRST for explicit close detection
    this.sessions.delete(chatId);

    // Dispose the pilot
    session!.pilot.dispose?.();

    this.logger.info({ chatId }, 'AgentPool: Deleted pilot');
    return true;
  }

  /**
   * Delete session tracking without disposing resources.
   * Used when resources are already closed or will be closed externally.
   */
  deleteTracking(chatId: string): boolean {
    const session = this.sessions.get(chatId);
    if (!session) {
      return false;
    }

    this.sessions.delete(chatId);
    // Don't close the pilot - will be closed externally
    // Log for debugging
    this.logger.debug({ chatId }, 'AgentPool: Session tracking removed (pilot not disposed)');

    return true;
  }

  /**
   * Get the number of active pilots.
   */
  size(): number {
    return this.sessions.size;
  }

  /**
   * Get all chatIds with active pilots.
   */
  getActiveChatIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Close all pilots and clear tracking.
   */
  closeAll(): void {
    // Clear map FIRST
    const sessions = Array.from(this.sessions.entries());
    this.sessions.clear();

    // Then dispose all pilots
    for (const [_chatId, session] of sessions) {
      session.pilot.dispose();
      this.logger.info({ chatId: _chatId }, 'AgentPool: Closed pilot');
    }

    this.logger.info('AgentPool: All pilots closed');
  }

  /**
   * Dispose all resources.
   */
  dispose(): void {
    this.closeAll();
    this.logger.info('AgentPool disposed');
  }
}
