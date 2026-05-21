/**
 * AgentPoolMessageHandler — IAgentMessageHandler that delegates to agent pool.
 *
 * Bridges the InputMessageRouter (Phase 1) with the existing ChatAgent system.
 * For UserMessage: reuses persistent agents from the pool (backward compatible).
 * For SystemMessage: creates short-lived agents via injected executor.
 *
 * Issue #3582: Channel + Scheduler integration via MessageRouter (Phase 3)
 */

import {
  createLogger,
  type IAgentMessageHandler,
  type FileRef,
} from '@disclaude/core';
import type { Logger } from 'pino';
import type { ChatAgent } from '../agents/chat-agent.js';
import type { ChatAgentCallbacks } from '../agents/types.js';

const defaultLogger = createLogger('AgentPoolHandler');

/**
 * Options for creating AgentPoolMessageHandler.
 */
export interface AgentPoolHandlerOptions {
  /** Agent pool for creating/getting persistent agents */
  agentPool: {
    getOrCreateChatAgent: (chatId: string, callbacks: ChatAgentCallbacks) => ChatAgent;
  };
  /** Callbacks factory for ChatAgent creation */
  callbacksFactory: (chatId: string) => ChatAgentCallbacks;
  /** Optional executor for short-lived system message agents */
  systemExecutor?: (chatId: string, payload: string, messageId: string) => Promise<void>;
  /** Optional logger */
  logger?: Logger;
}

/**
 * AgentPoolMessageHandler implements IAgentMessageHandler.
 *
 * - handleUserMessage: gets/creates persistent ChatAgent from pool, processes message
 * - handleSystemMessage: delegates to injected systemExecutor (short-lived agent pattern)
 *
 * Design: Fully backward compatible with existing agent pool behavior.
 */
export class AgentPoolMessageHandler implements IAgentMessageHandler {
  private readonly agentPool: AgentPoolHandlerOptions['agentPool'];
  private readonly callbacksFactory: (chatId: string) => ChatAgentCallbacks;
  private readonly systemExecutor?: AgentPoolHandlerOptions['systemExecutor'];
  private readonly log: Logger;

  constructor(options: AgentPoolHandlerOptions) {
    this.agentPool = options.agentPool;
    this.callbacksFactory = options.callbacksFactory;
    this.systemExecutor = options.systemExecutor;
    this.log = options.logger ?? defaultLogger;
  }

  handleUserMessage(
    chatId: string,
    payload: string,
    messageId: string,
    senderOpenId?: string,
    attachments?: FileRef[],
    chatHistoryContext?: string,
    chatType?: string,
    threadContext?: string,
  ): Promise<void> {
    this.log.info(
      { chatId, messageId, senderOpenId, hasAttachments: !!attachments?.length, chatType },
      'Handling user message via agent pool',
    );

    const callbacks = this.callbacksFactory(chatId);
    const agent = this.agentPool.getOrCreateChatAgent(chatId, callbacks);

    // Fire-and-forget pattern matches existing createDefaultMessageHandler
    void agent.processMessage(
      chatId,
      payload,
      messageId,
      senderOpenId,
      attachments,
      chatHistoryContext,
      chatType,
      threadContext,
    );

    return Promise.resolve();
  }

  async handleSystemMessage(
    chatId: string,
    payload: string,
    messageId: string,
  ): Promise<void> {
    this.log.info(
      { chatId, messageId },
      'Handling system message',
    );

    if (this.systemExecutor) {
      // Delegate to injected executor (short-lived agent pattern)
      await this.systemExecutor(chatId, payload, messageId);
    } else {
      // Fallback: use persistent agent from pool
      const callbacks = this.callbacksFactory(chatId);
      const agent = this.agentPool.getOrCreateChatAgent(chatId, callbacks);
      void agent.processMessage(chatId, payload, messageId);
    }
  }
}
