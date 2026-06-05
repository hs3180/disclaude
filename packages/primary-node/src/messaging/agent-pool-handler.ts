/**
 * AgentPoolMessageHandler — IAgentMessageHandler that delegates to agent pool.
 *
 * Bridges the InputMessageRouter with the existing ChatAgent system.
 * Both UserMessage and SystemMessage are routed through persistent agents
 * from the pool (RFC #3329 unified path).
 *
 * Issue #3582: Channel + Scheduler integration via MessageRouter (Phase 3)
 * Issue #3806: Removed systemExecutor — SystemMessage now always uses AgentPool
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
    const { chatId, messageId, senderOpenId, attachments, chatType } = params;
    this.log.info(
      { chatId, messageId, senderOpenId, hasAttachments: !!attachments?.length, chatType },
      'Handling user message via agent pool',
    );

    const callbacks = this.callbacksFactory(chatId);

    let agent;
    try {
      agent = this.agentPool.getOrCreateChatAgent(chatId, callbacks);
    } catch (err) {
      this.log.error({ err, chatId, messageId }, 'Failed to create/get ChatAgent for user message');
      void callbacks.sendMessage(chatId, '⚠️ Agent 创建失败，请发送 /reset 重试。', messageId).catch(() => {});
      return Promise.resolve();
    }

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
  ): Promise<void> {
    this.log.info(
      { chatId, messageId },
      'Handling system message',
    );

    // Unified path: use persistent agent from pool (RFC #3329)
    const callbacks = this.callbacksFactory(chatId);

    let agent;
    try {
      agent = this.agentPool.getOrCreateChatAgent(chatId, callbacks);
    } catch (err) {
      this.log.error({ err, chatId, messageId }, 'Failed to create/get ChatAgent for system message');
      void callbacks.sendMessage(chatId, '⚠️ Agent 创建失败，请发送 /reset 重试。', messageId).catch(() => {});
      return Promise.resolve();
    }

    // Issue #3962: Catch processMessage errors instead of silently swallowing
    void agent.processMessage({ chatId, payload, messageId }).catch((err) => {
      this.log.error({ err, chatId, messageId }, 'Agent processMessage failed for system message');
    });
    return Promise.resolve();
  }
}
