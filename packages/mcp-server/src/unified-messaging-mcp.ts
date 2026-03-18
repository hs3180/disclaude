/**
 * Channel Detection Utility.
 *
 * This module provides channel detection utilities for routing messages
 * based on chatId prefix.
 *
 * Issue #590 Phase 2: MCP Tools 与 Channel 解耦
 * Issue #1042: Migrated to @disclaude/mcp-server package
 *
 * Note: The unified send_message tool has been removed.
 * Use send_text, send_card, send_interactive, or send_file instead.
 */

// ============================================================================
// Channel Detection
// ============================================================================

/**
 * Channel type based on chatId prefix.
 */
export type ChannelType = 'feishu' | 'cli' | 'rest';

/**
 * Detect channel type from chatId.
 *
 * @param chatId - Chat ID to analyze
 * @returns Detected channel type
 */
export function detectChannel(chatId: string): ChannelType {
  // CLI mode: chatId starts with 'cli-'
  if (chatId.startsWith('cli-')) {
    return 'cli';
  }

  // Feishu: chatId starts with 'oc_' (group) or 'ou_' (private)
  if (chatId.startsWith('oc_') || chatId.startsWith('ou_')) {
    return 'feishu';
  }

  // REST or other: treat as REST channel
  return 'rest';
}
