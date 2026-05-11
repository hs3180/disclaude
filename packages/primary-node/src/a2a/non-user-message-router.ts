/**
 * NonUserMessageRouter — routes NonUserMessages to target ChatAgents.
 *
 * Provides A2A (Agent-to-Agent) task delegation by:
 * 1. Looking up the target chatId for a given projectKey
 * 2. Enforcing anti-recursion (no self-enqueue)
 * 3. Rate limiting per source chatId
 * 4. Injecting the task message into the target agent's conversation
 *
 * @see Issue #3334 (A2A messaging — Agent-to-Agent task delegation)
 * @module primary-node/a2a/non-user-message-router
 */

import {
  createLogger,
  createA2AMessage,
  readProjectState,
  type NonUserMessage,
  type NonUserMessagePriority,
  type ProjectManager,
} from '@disclaude/core';
import type { PrimaryAgentPool } from '../primary-agent-pool.js';
import type { ChatAgentCallbacks } from '../agents/types.js';

const logger = createLogger('NonUserMessageRouter');

// ============================================================================
// Rate Limiter
// ============================================================================

/**
 * Simple sliding-window rate limiter keyed by source chatId.
 */
class RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private readonly maxMessages: number;
  private readonly windowMs: number;

  constructor(maxMessages: number, windowMs: number) {
    this.maxMessages = maxMessages;
    this.windowMs = windowMs;
  }

  /**
   * Check if a request is allowed and record it.
   * @returns true if the request is within rate limits
   */
  check(key: string): boolean {
    const now = Date.now();

    let bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      // Start a new window
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
    }

    bucket.count++;
    return bucket.count <= this.maxMessages;
  }

  /**
   * Get remaining quota for a key (0 if exceeded).
   */
  remaining(key: string): number {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      return this.maxMessages;
    }
    return Math.max(0, this.maxMessages - bucket.count);
  }

  /**
   * Clear all buckets (for testing).
   */
  clear(): void {
    this.buckets.clear();
  }
}

// ============================================================================
// NonUserMessageRouter
// ============================================================================

export interface NonUserMessageRouterOptions {
  /** Agent pool for accessing target agents */
  agentPool: PrimaryAgentPool;
  /** Project manager for projectKey → chatId lookup */
  projectManager: ProjectManager;
  /** Max A2A messages per source chatId per window (default: 10) */
  maxMessagesPerWindow?: number;
  /** Rate limit window in milliseconds (default: 300000 = 5 minutes) */
  rateLimitWindowMs?: number;
}

export class NonUserMessageRouter {
  private readonly agentPool: PrimaryAgentPool;
  private readonly projectManager: ProjectManager;
  private readonly rateLimiter: RateLimiter;

  // Cache: projectKey → chatId (rebuilt on each enqueue for simplicity)
  // Could be optimized with event-driven invalidation if needed

  constructor(options: NonUserMessageRouterOptions) {
    this.agentPool = options.agentPool;
    this.projectManager = options.projectManager;
    this.rateLimiter = new RateLimiter(
      options.maxMessagesPerWindow ?? 10,
      options.rateLimitWindowMs ?? 5 * 60 * 1000,
    );
  }

  /**
   * Enqueue an A2A task for a target project agent.
   *
   * @returns Result with success status and optional messageId
   */
  async enqueue(
    sourceChatId: string,
    projectKey: string,
    payload: string,
    priority: NonUserMessagePriority,
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    // 1. Anti-recursion check
    const sourceProjectKey = this.resolveProjectKey(sourceChatId);
    if (sourceProjectKey === projectKey) {
      logger.warn({ sourceChatId, projectKey }, 'Anti-recursion: agent tried to enqueue to its own project');
      return {
        success: false,
        error: `Anti-recursion: cannot enqueue task to your own project (${projectKey})`,
      };
    }

    // 2. Rate limiting
    if (!this.rateLimiter.check(sourceChatId)) {
      const remaining = this.rateLimiter.remaining(sourceChatId);
      logger.warn({ sourceChatId, projectKey, remaining }, 'Rate limit exceeded for A2A task');
      return {
        success: false,
        error: `Rate limit exceeded: ${remaining} tasks remaining in current window`,
      };
    }

    // 3. Look up target chatId from projectKey
    const targetChatId = this.findChatIdByProjectKey(projectKey);
    if (!targetChatId) {
      logger.warn({ projectKey }, 'No active chatId found for projectKey');
      return {
        success: false,
        error: `No active agent found for project: ${projectKey}`,
      };
    }

    // 4. Create NonUserMessage
    const message: NonUserMessage = createA2AMessage({
      source: `chat:${sourceChatId}`,
      projectKey,
      payload,
      priority,
    });

    // 5. Inject message into target agent's conversation
    try {
      const callbacks = this.createCallbacksForAgent(targetChatId);
      const agent = this.agentPool.getOrCreateChatAgent(targetChatId, callbacks);

      const messageId = `a2a-${message.id}`;
      const prefixedPayload = `[A2A Task from ${sourceChatId}]\n\n${payload}`;

      void agent.processMessage(targetChatId, prefixedPayload, messageId);

      // Ensure async semantics — the method signature returns a Promise
      await Promise.resolve();

      logger.info(
        { messageId: message.id, sourceChatId, targetChatId, projectKey, priority },
        'A2A task enqueued successfully',
      );

      return {
        success: true,
        messageId: message.id,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, sourceChatId, targetChatId, projectKey }, 'Failed to enqueue A2A task');
      return {
        success: false,
        error: `Failed to enqueue task: ${msg}`,
      };
    }
  }

  /**
   * Resolve the projectKey for a given chatId.
   */
  private resolveProjectKey(chatId: string): string | undefined {
    const projectInfo = this.projectManager.getActive(chatId);
    if (!projectInfo || projectInfo.name === 'default') {
      return undefined;
    }

    const state = readProjectState(projectInfo.workingDir);
    return state?.projectKey;
  }

  /**
   * Find the chatId bound to a project with the given projectKey.
   */
  private findChatIdByProjectKey(projectKey: string): string | undefined {
    const instances = this.projectManager.listInstances();

    for (const instance of instances) {
      if (!instance.chatIds || instance.chatIds.length === 0) {continue;}

      const state = readProjectState(instance.workingDir);
      if (state?.projectKey === projectKey) {
        // Return the first bound chatId
        return instance.chatIds[0];
      }
    }

    return undefined;
  }

  /**
   * Create minimal callbacks for the target agent.
   */
  private createCallbacksForAgent(chatId: string): ChatAgentCallbacks {
    return {
      sendMessage: (text: string) => {
        logger.debug({ chatId, textLength: text.length }, 'A2A target agent send message');
        return Promise.resolve();
      },
      sendCard: () => Promise.resolve(),
      sendFile: () => Promise.resolve(),
      onDone: () => Promise.resolve(),
    };
  }
}
