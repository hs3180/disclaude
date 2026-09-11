/**
 * Shared Channel Handler Utilities.
 *
 * Issue #1555 Phase 2: Extracted from wired-descriptors.ts to make
 * channel handler creation reusable across all channel types.
 *
 * These utilities encapsulate the common patterns for:
 * - Creating ChatAgentCallbacks from any IChannel instance
 * - Processing incoming messages through the agent pool
 *
 * New channels (WeChat, etc.) should use these utilities instead of
 * duplicating handler registration logic.
 *
 * @module utils/channel-handlers
 */
import { createLogger as coreCreateLogger, } from "../../../core/dist/index.js";
const routingLogger = coreCreateLogger('ChannelMessageRouter');
/** Convert a timestamp (seconds or milliseconds) to ISO string, falling back to now. */
function toISOStringSafe(ts) {
    if (ts === null || ts === undefined || !Number.isFinite(ts)) {
        return new Date().toISOString();
    }
    // Feishu create_time is in seconds; values < 1e12 are seconds, otherwise ms
    const ms = ts < 1e12 ? ts * 1000 : ts;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}
// ============================================================================
// createChannelCallbacksFactory
// ============================================================================
/**
 * Create a ChatAgentCallbacks factory for a channel.
 *
 * Wraps channel.sendMessage() into the ChatAgentCallbacks interface.
 * The returned factory captures the channel via closure.
 *
 * @param channel - The channel instance to send messages through
 * @param logger - Logger instance for warnings
 * @param options - Options for channel-specific behavior
 * @returns A factory function that takes a chatId and returns ChatAgentCallbacks
 *
 * @example
 * ```typescript
 * const callbacksFactory = createChannelCallbacksFactory(channel, logger, {
 *   sendDoneSignal: true,
 * });
 * const callbacks = callbacksFactory('chat-123');
 * await callbacks.sendMessage('chat-123', 'Hello!');
 * ```
 */
export function createChannelCallbacksFactory(channel, logger, options) {
    return (_chatId) => ({
        sendMessage: async (chatId, text, parentMessageId) => {
            return await channel.sendMessage({
                chatId,
                type: 'text',
                text,
                threadId: parentMessageId,
            });
        },
        sendCard: async (chatId, card, description, parentMessageId) => {
            await channel.sendMessage({
                chatId,
                type: 'card',
                card,
                description,
                threadId: parentMessageId,
            });
        },
        // eslint-disable-next-line require-await
        sendFile: async (chatId, filePath) => {
            logger.warn({ chatId, filePath }, 'File sending not fully implemented');
        },
        onDone: options?.sendDoneSignal
            ? async (chatId, parentMessageId) => {
                logger.info({ chatId }, 'Task completed');
                await channel.sendMessage({
                    chatId,
                    type: 'done',
                    threadId: parentMessageId,
                });
            }
            : // eslint-disable-next-line require-await
                async (chatId) => {
                    logger.info({ chatId }, 'Task completed');
                },
        // Issue #1863: Wire getChatHistory callback for session restoration
        getChatHistory: options?.getChatHistory,
        // Issue #3996: Wire getChatLogFilePaths so agent knows where log files are
        getChatLogFilePaths: options?.getChatLogFilePaths,
        // Issue #3530: Wire getCapabilities so message construction can correctly
        // include/exclude channel operations based on actual channel support.
        // Since #4652 ChatAgent no longer injects channel-mcp; this capability now
        // governs channel CLI Skill guidance only.
        getCapabilities: (_chatId) => channel.getCapabilities(),
        // Issue #4400 (#4208 P2-c): wire the IChannel streaming callbacks when the
        // channel exposes them. The ChatAgent gate additionally requires
        // `getCapabilities().supportsStreaming === true` (per chatId) before
        // constructing the StreamingReplyDriver, so wiring here is safe for any
        // channel — non-streaming channels leave these unset and degrade to
        // sendMessage unchanged.
        ...(() => {
            const { startStreaming, streamText, finalizeStreaming } = channel;
            if (!startStreaming || !streamText || !finalizeStreaming) {
                return {};
            }
            return {
                startStreaming: (chatId, parentMessageId) => startStreaming.call(channel, chatId, parentMessageId),
                streamText: (id, text) => streamText.call(channel, id, text),
                finalizeStreaming: (id) => finalizeStreaming.call(channel, id),
            };
        })(),
    });
}
// ============================================================================
// createDefaultMessageHandler
// ============================================================================
/**
 * Create a default message handler using the shared processing pattern.
 *
 * Pattern: extract data → get/create agent → optional attachment conversion → process → error handling
 *
 * @param channel - The channel instance (for error response)
 * @param context - Wired context with agentPool and callbacks factory
 * @param options - Channel-specific options
 * @returns A message handler function for processing incoming messages
 *
 * @example
 * ```typescript
 * const handler = createDefaultMessageHandler(channel, wiredContext, {
 *   channelName: 'Feishu channel',
 *   extractAttachments: (msg) => msg.attachments?.map(convertAttachment),
 * });
 * channel.onMessage(handler);
 * ```
 */
export function createDefaultMessageHandler(channel, context, options) {
    return async (message) => {
        const { chatId, content, messageId, userId, metadata, messageType } = message;
        context.logger.info({ chatId, messageId, messageType, contentLength: content.length, hasAttachments: !!message.attachments }, `Processing message from ${options.channelName}`);
        // Issue #3582: Route through InputMessageRouter when available (Phase 3)
        if (context.inputMessageRouter) {
            const senderOpenId = userId;
            const chatHistoryContext = metadata?.chatHistoryContext;
            const chatType = metadata?.chatType;
            const threadContext = metadata?.threadContext;
            // Issue #4587 (part 1): thread root for topic-group session keying (part 2)
            const threadRootId = metadata?.threadRootId;
            const fileRefs = options.extractAttachments?.(message);
            const userMessage = {
                id: messageId,
                source: 'user',
                payload: content,
                chatId,
                messageId,
                senderOpenId,
                attachments: fileRefs,
                chatHistoryContext,
                chatType,
                threadContext,
                threadRootId,
                createdAt: toISOStringSafe(message.timestamp),
            };
            try {
                await context.inputMessageRouter.route(userMessage);
            }
            catch (error) {
                routingLogger.error({ err: error, chatId, messageId }, 'Failed to route user message via InputMessageRouter');
                await channel.sendMessage({
                    chatId,
                    type: 'text',
                    text: `❌ Error: ${error instanceof Error ? error.message : String(error)}`,
                });
                if (options.sendDoneSignal) {
                    await channel.sendMessage({ chatId, type: 'done' });
                }
            }
            return;
        }
        // Existing path: direct agent pool access (backward compatible fallback)
        // Extract context
        const senderOpenId = userId;
        const chatHistoryContext = metadata?.chatHistoryContext;
        const chatType = metadata?.chatType;
        const threadContext = metadata?.threadContext;
        // Issue #4587 (part 2): thread root for per-thread session keying
        const threadRootId = metadata?.threadRootId;
        const callbacks = context.callbacks(chatId);
        const agent = context.agentPool.getOrCreateChatAgent(chatId, callbacks, threadRootId);
        // Convert attachments if the channel supports them
        const fileRefs = options.extractAttachments?.(message);
        try {
            void agent.processMessage({ chatId, payload: content, messageId, senderOpenId, attachments: fileRefs, chatHistoryContext, chatType, threadContext, threadRootId });
        }
        catch (error) {
            context.logger.error({ err: error, chatId, messageId }, 'Failed to process message');
            const errorMsg = error instanceof Error ? error.message : String(error);
            await channel.sendMessage({
                chatId,
                type: 'text',
                text: `❌ Error: ${errorMsg}`,
            });
            if (options.sendDoneSignal) {
                await channel.sendMessage({ chatId, type: 'done' });
            }
        }
    };
}
/**
 * Create common ChannelApiHandlers from a channel instance.
 *
 * Extracts the shared REST API handler pattern (sendMessage, sendCard, uploadFile)
 * that was previously duplicated in each channel descriptor's setup() method.
 * Callers can spread the result and add channel-specific handlers
 * (sendInteractive, listTempChats, etc.) on top.
 *
 * This unifies the REST API handler creation with the same `channel.sendMessage()`
 * delegation pattern used by `createChannelCallbacksFactory`.
 *
 * @see createChannelCallbacksFactory — for ChatAgentCallbacks (worker-to-channel),
 *      this function creates ChannelApiHandlers (MCP server-to-channel).
 *
 * @param channel - The channel instance to send messages through
 * @param options - Options for handler creation
 * @returns Partial ChannelApiHandlers with sendMessage, sendCard, uploadFile
 *
 * @example
 * ```typescript
 * const baseHandlers = createChannelApiHandlers(feishuChannel, { logger, channelName: 'Feishu' });
 * const fullHandlers: ChannelApiHandlers = {
 *   ...baseHandlers,
 *   sendInteractive: async (chatId, params) => { ... },
 *   listTempChats: () => { ... },
 * };
 * context.primaryNode.registerFeishuHandlers(fullHandlers);
 * ```
 */
export function createChannelApiHandlers(channel, options) {
    const { logger, channelName } = options;
    return {
        sendMessage: async (chatId, text, threadId, mentions) => {
            try {
                await channel.sendMessage({ chatId, type: 'text', text, threadId, mentions });
            }
            catch (error) {
                logger.error({ err: error, chatId, channel: channelName, handler: 'sendMessage' }, 'REST API handler failed');
                throw error;
            }
        },
        sendCard: async (chatId, card, threadId, description) => {
            try {
                await channel.sendMessage({ chatId, type: 'card', card, threadId, description });
            }
            catch (error) {
                logger.error({ err: error, chatId, channel: channelName, handler: 'sendCard' }, 'REST API handler failed');
                throw error;
            }
        },
        uploadFile: async (chatId, filePath, threadId) => {
            logger.debug({ chatId, filePath, channel: channelName }, 'uploadFile: using channel.sendMessage — file metadata may be incomplete');
            try {
                await channel.sendMessage({ chatId, type: 'file', filePath, threadId });
            }
            catch (error) {
                logger.error({ err: error, chatId, channel: channelName, handler: 'uploadFile' }, 'REST API handler failed');
                throw error;
            }
            // NOTE: fileKey and fileSize are synthetic placeholders.
            // channel.sendMessage() does not return real file metadata.
            // Callers should not rely on these fields for business logic.
            return {
                fileKey: '', // synthetic — not available via sendMessage
                fileType: 'file',
                fileName: filePath.split('/').pop() || 'file',
                fileSize: 0, // synthetic — not available via sendMessage
            };
        },
    };
}
