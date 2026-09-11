/**
 * Channel abstraction types.
 *
 * A Channel represents a communication pathway between users and the agent.
 * Different platforms (Feishu, REST API, etc.) can implement this interface
 * to provide a unified way of receiving and sending messages.
 *
 * These types are shared between @disclaude/core and @disclaude/primary-node.
 *
 * @module types/channel
 */
/**
 * Default capabilities for a basic channel.
 */
export const DEFAULT_CHANNEL_CAPABILITIES = {
    supportsCard: false,
    supportsThread: false,
    supportsFile: false,
    supportsMarkdown: true,
    supportsMention: false,
    supportsUpdate: false,
    supportsStreaming: false,
    supportedMcpTools: [],
};
