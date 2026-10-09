/**
 * Universal Message Format (UMF) - Platform-agnostic message types.
 *
 * This module defines a platform-independent message format that can be
 * converted to platform-specific formats (Feishu Card, CLI Text, REST JSON).
 *
 * Issue #515: Universal Message Format + Channel Adapters (Phase 2)
 *
 * @example
 * ```typescript
 * // Text message
 * const textMsg: UniversalMessage = {
 *   chatId: 'oc_xxx',
 *   content: { type: 'text', text: 'Hello!' }
 * };
 *
 * // Card message
 * const cardMsg: UniversalMessage = {
 *   chatId: 'oc_xxx',
 *   content: {
 *     type: 'card',
 *     title: 'Task Complete',
 *     sections: [
 *       { type: 'text', content: 'All files processed.' }
 *     ],
 *     actions: [
 *       { type: 'button', label: 'View Results', value: 'view_results' }
 *     ]
 *   }
 * };
 * ```
 */
// ============================================================================
// Type Guards
// ============================================================================
/**
 * Check if content is TextContent.
 */
export function isTextContent(content) {
    return content.type === 'text';
}
/**
 * Check if content is MarkdownContent.
 */
export function isMarkdownContent(content) {
    return content.type === 'markdown';
}
/**
 * Check if content is CardContent.
 */
export function isCardContent(content) {
    return content.type === 'card';
}
/**
 * Check if content is FileContent.
 */
export function isFileContent(content) {
    return content.type === 'file';
}
/**
 * Check if content is DoneContent.
 */
export function isDoneContent(content) {
    return content.type === 'done';
}
// ============================================================================
// Helper Functions
// ============================================================================
/**
 * Create a simple text message.
 */
export function createTextMessage(chatId, text, threadId) {
    return {
        chatId,
        threadId,
        content: { type: 'text', text },
    };
}
/**
 * Create a simple markdown message.
 */
export function createMarkdownMessage(chatId, text, threadId) {
    return {
        chatId,
        threadId,
        content: { type: 'markdown', text },
    };
}
/**
 * Create a card message.
 */
export function createCardMessage(chatId, title, sections, options) {
    return {
        chatId,
        threadId: options?.threadId,
        content: {
            type: 'card',
            title,
            subtitle: options?.subtitle,
            sections,
            actions: options?.actions,
            theme: options?.theme,
        },
    };
}
/**
 * Create a done signal message.
 */
export function createDoneMessage(chatId, success, message, error) {
    return {
        chatId,
        content: {
            type: 'done',
            success,
            message,
            error,
        },
    };
}
