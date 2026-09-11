/**
 * Input Message types for unified agent input abstraction.
 *
 * These types represent messages entering the system from different sources
 * (user chat, system infrastructure) and are routed to ChatAgent via
 * MessageRouter.
 *
 * Issue #3580: Message types (UserMessage + SystemMessage) and MessageRouter
 * Part of RFC #3329: Message — Unified Agent Input Abstraction (Phase 1)
 *
 * Design: Fully decoupled from Project system. All messages carry chatId;
 * MessageRouter routes by chatId only, unaware of projectKey.
 */
// ============================================================================
// Type Guards
// ============================================================================
/**
 * Check if a Message is a UserMessage.
 */
export function isUserMessage(message) {
    return message.source === 'user';
}
/**
 * Check if a Message is a SystemMessage.
 */
export function isSystemMessage(message) {
    return message.source === 'system';
}
