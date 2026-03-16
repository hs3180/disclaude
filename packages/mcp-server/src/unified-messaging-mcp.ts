/**
 * Unified Messaging MCP Tools - Channel-agnostic message sending.
 *
 * This module provides a unified interface for sending messages across
 * different channels (Feishu, REST, CLI). It routes messages based on
 * chatId prefix and uses the appropriate channel adapter.
 *
 * Issue #590 Phase 2: MCP Tools 与 Channel 解耦
 * Issue #1042: Migrated to @disclaude/mcp-server package
 *
 * Tools provided:
 * - send_message: Unified message sending (text or card format)
 *
 * Architecture:
 * ```
 * ┌─────────────────┐
 * │   Chat Agent    │
 * └────────┬────────┘
 *          │
 * ┌────────▼────────┐
 * │  send_message   │  ← Unified interface
 * │  (this module)  │
 * └────────┬────────┘
 *          │
 *     ┌────┴────┬──────────┐
 *     ▼         ▼          ▼
 *  Feishu    REST       CLI
 * Channel  Channel    Channel
 * ```
 */

import { z } from 'zod';
import { createLogger, getProvider, type SdkInlineToolDefinition } from '@disclaude/core';
import { send_message as send_message_impl, setMessageSentCallback, type MessageSentCallback } from './feishu-context-mcp.js';

const logger = createLogger('UnifiedMessagingMCP');

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

// ============================================================================
// Unified send_message Tool
// ============================================================================

/**
 * Result from send_message tool.
 */
export interface SendMessageResult {
  success: boolean;
  message: string;
  channel: ChannelType;
  error?: string;
}

/**
 * Unified message sending tool.
 *
 * Routes to the appropriate channel based on chatId:
 * - Feishu (oc_*, ou_*): Uses Feishu API
 * - Other chatIds: Uses Feishu API (requires configured credentials)
 *
 * Note: CLI and unconfigured credential fallbacks have been removed (Issue #849).
 * If Feishu credentials are not configured, an error is returned.
 *
 * @param params - Tool parameters
 * @returns Result with success status and channel info
 */
export async function send_message(params: {
  content: string | Record<string, unknown>;
  format: 'text' | 'card';
  chatId: string;
  parentMessageId?: string;
}): Promise<SendMessageResult> {
  const { content, format, chatId, parentMessageId } = params;

  // Detect channel
  const channel = detectChannel(chatId);

  logger.info({
    chatId,
    channel,
    format,
    contentType: typeof content,
    hasParent: !!parentMessageId,
  }, 'send_message called');

  try {
    // Use the existing send_message implementation
    // It already handles graceful degradation for non-Feishu channels
    const result = await send_message_impl({
      content,
      format,
      chatId,
      parentMessageId,
    });

    return {
      success: result.success,
      message: result.message,
      channel,
      error: result.error,
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({
      err: error,
      chatId,
      channel,
      format,
    }, 'send_message failed');

    return {
      success: false,
      message: `❌ Failed to send message via ${channel}: ${errorMessage}`,
      channel,
      error: errorMessage,
    };
  }
}

// ============================================================================
// Tool Definitions for SDK
// ============================================================================

/**
 * Helper to create a successful tool result.
 */
function toolSuccess(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text }],
  };
}

/**
 * Unified messaging tool definitions for Agent SDK.
 *
 * These tools provide a channel-agnostic interface for message sending,
 * automatically routing to the appropriate channel based on chatId.
 *
 * Issue #1155: Consolidated from 9 tools to 4 tools to reduce token overhead.
 */
export const unifiedMessagingToolDefinitions: SdkInlineToolDefinition[] = [
  {
    name: 'send_message',
    description: `Send a message to a chat. Supports text, card, and interactive modes.

## Modes
1. **Text**: Simple text message
2. **Card**: Display-only card (no interactions)
3. **Interactive**: Card with buttons/actions (requires actionPrompts)

## Examples

### Text Message
\`\`\`json
{"content": "Hello", "format": "text", "chatId": "oc_xxx"}
\`\`\`

### Interactive Card
\`\`\`json
{
  "content": {"config": {}, "header": {"title": {"content": "Confirm?"}}, "elements": [
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "OK"}, "value": "ok"},
      {"tag": "button", "text": {"content": "Cancel"}, "value": "cancel"}
    ]}
  ]},
  "format": "card",
  "chatId": "oc_xxx",
  "actionPrompts": {
    "ok": "[用户] 点击了确认",
    "cancel": "[用户] 点击了取消"
  }
}
\`\`\`

## Parameters
- **content**: Text string or card object
- **format**: "text" or "card"
- **chatId**: Target chat ID
- **parentMessageId**: Optional, for thread reply
- **actionPrompts**: Optional, enables interactive mode

**Reference:** https://open.feishu.cn/document/common-capabilities/message-card`,
    parameters: z.object({
      content: z.union([z.string(), z.object({}).passthrough()]).describe('Content to send. String for text, object for cards.'),
      format: z.enum(['text', 'card']).describe('Format: "text" or "card"'),
      chatId: z.string().describe('Chat ID'),
      parentMessageId: z.string().optional().describe('Optional parent message ID for thread replies'),
      actionPrompts: z.record(z.string(), z.string()).optional().describe('Optional action prompts for interactive cards'),
    }),
    handler: async ({ content, format, chatId, parentMessageId, actionPrompts }: {
      content: string;
      format: 'text' | 'card';
      chatId: string;
      parentMessageId?: string;
      actionPrompts?: unknown;
    }) => {
      try {
        // If actionPrompts provided with card, use interactive message
        if (actionPrompts && Object.keys(actionPrompts).length > 0 && format === 'card') {
          // Import send_interactive_message dynamically to avoid circular deps
          const { send_interactive_message } = await import('./feishu-context-mcp.js');
          const cardContent = content as unknown as Record<string, unknown>;
          const result = await send_interactive_message({
            card: cardContent,
            actionPrompts: actionPrompts as Record<string, string>,
            chatId,
            parentMessageId
          });
          return toolSuccess(result.success ? `${result.message}` : `⚠️ ${result.message}`);
        }
        // Otherwise use regular send_message
        const result = await send_message({ content, format, chatId, parentMessageId });
        if (result.success) {
          return toolSuccess(`${result.message} (via ${result.channel})`);
        } else {
          return toolSuccess(`⚠️ ${result.message}`);
        }
      } catch (error) {
        return toolSuccess(`⚠️ Message failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
];

/**
 * SDK MCP Server factory for unified messaging tools.
 *
 * **Usage:**
 * ```typescript
 * query({
 *   prompt: "...",
 *   options: {
 *     mcpServers: {
 *       'unified-messaging': createUnifiedMessagingMcpServer(),
 *     },
 *   },
 * })
 * ```
 */
export function createUnifiedMessagingMcpServer() {
  return getProvider().createMcpServer({
    type: 'inline',
    name: 'unified-messaging',
    version: '1.0.0',
    tools: unifiedMessagingToolDefinitions,
  });
}

// Re-export callback setter for compatibility
export { setMessageSentCallback, type MessageSentCallback };
