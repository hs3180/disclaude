/**
 * AgentPoolMessageHandler — IAgentMessageHandler that delegates to agent pool.
 *
 * Bridges the InputMessageRouter with the existing ChatAgent system.
 * Both UserMessage and SystemMessage are routed through persistent agents
 * from the pool (RFC #3329 unified path).
 *
 * Issue #3582: Channel + Scheduler integration via MessageRouter (Phase 3)
 * Issue #3806: SystemMessage now always uses AgentPool
 */

import {
  createLogger,
  type IAgentMessageHandler,
  type UserMessageParams,
} from '@disclaude/core';
import type { Logger } from 'pino';
import type { ChatAgent } from '../agents/chat-agent.js';
import type { ChatAgentCallbacks } from '../agents/types.js';

const defaultLogger = createLogger('AgentPoolHandler');

const AGENT_CREATION_FAILED_MESSAGE = '⚠️ Agent 创建失败，请发送 /reset 重试。';

/**
 * Options for creating AgentPoolMessageHandler.
 */
export interface AgentPoolHandlerOptions {
  /** Agent pool for creating/getting persistent agents */
  agentPool: {
    /**
     * Issue #4587 (part 2): `threadRootId` (topic-group messages only)
     * selects that thread's agent — one session per thread. Omitted for
     * p2p / plain groups / system messages (chat-scoped agent).
     */
    getOrCreateChatAgent: (
      chatId: string,
      callbacks: ChatAgentCallbacks,
      threadRootId?: string
    ) => ChatAgent;
  };
  /** Callbacks factory for ChatAgent creation */
  callbacksFactory: (chatId: string) => ChatAgentCallbacks;
  /** Optional logger */
  logger?: Logger;
}

/**
 * AgentPoolMessageHandler implements IAgentMessageHandler.
 *
 * - handleUserMessage: gets/creates persistent ChatAgent from pool, processes message
 * - handleSystemMessage: gets/creates persistent ChatAgent from pool (unified path, RFC #3329)
 *
 * Design: Both user and system messages use the same AgentPool path,
 * ensuring persistent context across sessions.
 */
export class AgentPoolMessageHandler implements IAgentMessageHandler {
  private readonly agentPool: AgentPoolHandlerOptions['agentPool'];
  private readonly callbacksFactory: (chatId: string) => ChatAgentCallbacks;
  private readonly log: Logger;

  constructor(options: AgentPoolHandlerOptions) {
    this.agentPool = options.agentPool;
    this.callbacksFactory = options.callbacksFactory;
    this.log = options.logger ?? defaultLogger;
  }

  handleUserMessage(params: UserMessageParams): Promise<void> {
    const { chatId, messageId, senderOpenId, attachments, chatType, threadRootId } = params;
    this.log.info(
      { chatId, messageId, senderOpenId, hasAttachments: !!attachments?.length, chatType, threadRootId },
      'Handling user message via agent pool',
    );

    // Issue #4587 (part 2): a topic-group thread message routes to that
    // thread's own agent (pool keys on chatId::threadRoot); everything else
    // keeps the chat-scoped agent.
    const agent = this.getAgentSafely(chatId, messageId, 'user message', threadRootId);
    if (!agent) {return Promise.resolve();}

    // Issue #3962: Catch processMessage errors instead of silently swallowing
    void agent.processMessage(params).catch((err) => {
      this.log.error({ err, chatId, messageId }, 'Agent processMessage failed for user message');
    });

    return Promise.resolve();
  }

  handleSystemMessage(
    chatId: string,
    payload: string,
    messageId: string,
    options?: { waitForCompletion?: boolean },
  ): Promise<void> {
    this.log.info(
      { chatId, messageId, waitForCompletion: options?.waitForCompletion },
      'Handling system message',
    );

    // Unified path: use persistent agent from pool (RFC #3329)
    const agent = this.getAgentSafely(chatId, messageId, 'system message');
    if (!agent) {
      if (options?.waitForCompletion) {
        // Issue #4649 (review ⑤): with waitForCompletion the caller
        // (Scheduler, Loop Runner) derives its completion status from this
        // promise — resolving here recorded "completed" for a message that
        // never reached an agent, making chronic agent-creation failures
        // invisible to the #4648 consecutive-failure alert. Reject instead.
        // (The user-facing "⚠️ Agent 创建失败" notice was already sent by
        // getAgentSafely; the rejection is the countable signal.)
        return Promise.reject(
          new Error('ChatAgent creation failed — system message not processed'),
        );
      }
      return Promise.resolve();
    }

    if (options?.waitForCompletion) {
      // Issue #4063: Wait for agent turn to complete (for Loop Runner).
      // Uses turnComplete (per-turn) instead of taskComplete (session-level),
      // because pool agents run in persistent mode where taskComplete never resolves.
      return agent.processMessage({ chatId, payload, messageId })
        .then(() => {
          // Issue #4649 (review ③): per-MESSAGE lookup — the agent.turnComplete
          // getter returns whichever message pushed LAST, which under
          // interleaving is a different message's promise (fake "completed"
          // for this one). turnCompleteFor pins this message's own outcome.
          const turnDone = agent.turnCompleteFor(messageId);
          if (!turnDone) {
            // Issue #4649 (review ⑤): no promise = the message never entered
            // a turn (no session channel). This previously logged a warning
            // and resolved — recording "completed" for infrastructure
            // failures, exactly the chronic class the #4648 alert exists to
            // catch. Reject so the failure path fires.
            throw new Error(
              'Agent turn never started — message was not processed (no active session channel)',
            );
          }
          return turnDone;
        })
        .catch((err) => {
          this.log.error({ err, chatId, messageId }, 'Agent processMessage or turnComplete failed for system message (waitForCompletion)');
          throw err; // Propagate error so IPC caller knows the agent failed
        });
    }

    // Issue #3962: Catch processMessage errors instead of silently swallowing
    void agent.processMessage({ chatId, payload, messageId }).catch((err) => {
      this.log.error({ err, chatId, messageId }, 'Agent processMessage failed for system message');
    });
    return Promise.resolve();
  }

  /**
   * Safely get or create a ChatAgent from the pool.
   * Returns null if agent creation fails (logs error + notifies user).
   * Issue #3962: Prevents silent failures when agent subprocess fails to spawn.
   * Issue #4587 (part 2): `threadRootId` (user messages only) selects the
   * thread's agent; system messages stay chat-scoped by design (scheduler /
   * loop tasks have no thread identity).
   */
  private getAgentSafely(
    chatId: string,
    messageId: string,
    context: string,
    threadRootId?: string,
  ): ChatAgent | null {
    const callbacks = this.callbacksFactory(chatId);
    try {
      return this.agentPool.getOrCreateChatAgent(chatId, callbacks, threadRootId);
    } catch (err) {
      this.log.error({ err, chatId, messageId }, `Failed to create/get ChatAgent for ${context}`);
      // Silent catch: agent itself is broken, notification failure should not cause further errors
      void callbacks.sendMessage(chatId, AGENT_CREATION_FAILED_MESSAGE, messageId).catch(() => {});
      return null;
    }
  }
}
