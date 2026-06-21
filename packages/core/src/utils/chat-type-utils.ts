/**
 * Chat type classification utilities.
 *
 * These classify a conversation by its authoritative `chat_type` value — the
 * field carried on the incoming message/event (e.g.
 * `FeishuMessageEvent.message.chat_type`) and threaded through the message
 * pipeline (`MessageRouter`, `IncomingMessage.chatType`). They intentionally do
 * NOT inspect chat ID prefixes: chat IDs are addresses, not type signals, and
 * deriving chat type from a prefix couples callers to a specific platform's ID
 * scheme and is fragile. Issue #4136.
 *
 * @module core/utils/chat-type-utils
 */

/**
 * Canonical chat type values flowing through the message pipeline.
 */
export type ChatType = 'p2p' | 'group' | 'topic';

/**
 * Whether a chat type represents a multi-participant group conversation.
 *
 * 'topic' (a thread inside a group) is treated as group-like, matching the
 * existing message-routing behavior.
 *
 * @param chatType - The `chat_type` value to check
 * @returns true if the chat type is a group (or topic) conversation
 */
export function isGroupChat(chatType?: string): boolean {
  return chatType === 'group' || chatType === 'topic';
}

/**
 * Whether a chat type represents a private (P2P) conversation.
 *
 * @param chatType - The `chat_type` value to check
 * @returns true if the chat type is a private (P2P) conversation
 */
export function isPrivateChat(chatType?: string): boolean {
  return chatType === 'p2p';
}
