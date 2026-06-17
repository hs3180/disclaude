/**
 * Chat ID utility functions for Feishu platform.
 *
 * Issue #4136: Shared chat ID classification to replace duplicated
 * isGroupChat/isPrivateChat implementations across primary-node.
 *
 * @module core/utils/chat-id-utils
 */

/**
 * Feishu group chat ID prefix.
 */
const GROUP_CHAT_PREFIX = 'oc_';

/**
 * Feishu private (P2P) chat ID prefix.
 */
const PRIVATE_CHAT_PREFIX = 'ou_';

/**
 * Check if a chat ID represents a group chat.
 *
 * In Feishu, group chat IDs start with 'oc_'.
 *
 * @param chatId - The chat ID to check
 * @returns true if the chat ID is a group chat
 */
export function isGroupChat(chatId: string): boolean {
  return chatId.startsWith(GROUP_CHAT_PREFIX);
}

/**
 * Check if a chat ID represents a private (P2P) chat.
 *
 * In Feishu, private chat IDs start with 'ou_'.
 *
 * @param chatId - The chat ID to check
 * @returns true if the chat ID is a private chat
 */
export function isPrivateChat(chatId: string): boolean {
  return chatId.startsWith(PRIVATE_CHAT_PREFIX);
}
