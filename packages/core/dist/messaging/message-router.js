/**
 * Input MessageRouter — routes incoming Messages to AgentPool by chatId.
 *
 * This is the unified input routing layer for all messages entering the system.
 * Both UserMessage (from chat channels) and SystemMessage (from scheduler/webhook/REST API)
 * are routed through this single router to the appropriate ChatAgent.
 *
 * Design: Fully decoupled from Project system. Routes by chatId only.
 *
 * Issue #3580: Message types (UserMessage + SystemMessage) and MessageRouter
 * Part of RFC #3329: Message — Unified Agent Input Abstraction (Phase 1)
 */
import { createLogger } from '../utils/logger.js';
import { isUserMessage, isSystemMessage } from '../types/message.js';
const defaultLogger = createLogger('InputMessageRouter');
// ============================================================================
// Routing Error
// ============================================================================
/**
 * Error thrown when message routing fails.
 */
export class MessageRoutingError extends Error {
    cause;
    constructor(message, cause) {
        super(message);
        this.cause = cause;
        this.name = 'MessageRoutingError';
    }
}
/**
 * Input MessageRouter — routes incoming Messages to agents by chatId.
 *
 * All messages carry chatId. The router extracts it and delegates to
 * the IAgentMessageHandler which manages agent lifecycle and delivery.
 *
 * @example
 * ```typescript
 * const router = new MessageRouter({
 *   handler: {
 *     handleUserMessage({ chatId, payload, messageId, senderOpenId, attachments, chatHistoryContext }) {
 *       const agent = agentPool.getOrCreateChatAgent(chatId);
 *       agent.processMessage({ chatId, payload, messageId, senderOpenId, attachments, chatHistoryContext });
 *     },
 *     handleSystemMessage(chatId, payload, messageId) {
 *       const agent = agentPool.getOrCreateChatAgent(chatId);
 *       agent.processMessage({ chatId, payload, messageId });
 *     },
 *   },
 * });
 *
 * // Route a user message
 * await router.route({
 *   id: 'msg-1',
 *   source: 'user',
 *   payload: 'Hello!',
 *   chatId: 'oc_xxx',
 *   messageId: 'feishu-msg-id',
 *   createdAt: new Date().toISOString(),
 * });
 * ```
 */
export class MessageRouter {
    handler;
    log;
    constructor(config) {
        this.handler = config.handler;
        this.log = config.logger ?? defaultLogger;
    }
    /**
     * Route a message to the appropriate agent by chatId.
     *
     * Extracts chatId from the message and delegates to the handler.
     * Throws MessageRoutingError if chatId is missing or source is unknown.
     *
     * @param message - The message to route
     */
    async route(message) {
        // Validate chatId
        if (!message.chatId) {
            throw new MessageRoutingError('Message missing chatId — cannot route');
        }
        this.log.debug({ chatId: message.chatId, source: message.source, messageId: message.id }, 'Routing message');
        try {
            if (isUserMessage(message)) {
                await this.routeUserMessage(message);
            }
            else if (isSystemMessage(message)) {
                await this.routeSystemMessage(message);
            }
            else {
                throw new MessageRoutingError(`Unknown message source: ${message.source}`);
            }
        }
        catch (err) {
            if (err instanceof MessageRoutingError) {
                throw err;
            }
            throw new MessageRoutingError(`Failed to route message ${message.id} to chatId ${message.chatId}`, err);
        }
    }
    async routeUserMessage(message) {
        await this.handler.handleUserMessage({
            chatId: message.chatId,
            payload: message.payload,
            messageId: message.messageId,
            senderOpenId: message.senderOpenId,
            attachments: message.attachments,
            chatHistoryContext: message.chatHistoryContext,
            chatType: message.chatType,
            threadContext: message.threadContext,
            threadRootId: message.threadRootId,
            ...(message.agentSession ? { agentSession: message.agentSession } : {}),
        });
    }
    async routeSystemMessage(message) {
        await this.handler.handleSystemMessage(message.chatId, message.payload, message.id, { waitForCompletion: message.waitForCompletion, ...(message.agentSession ? { agentSession: message.agentSession } : {}) });
    }
}
