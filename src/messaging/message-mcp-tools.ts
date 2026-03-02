/**
 * Generic Message MCP Tools - Multi-channel message sending.
 *
 * This module provides MCP tool definitions that work across all channels
 * (Feishu, CLI, REST). It replaces the Feishu-specific tools with
 * channel-aware implementations.
 *
 * Tools provided:
 * - send_user_feedback: Send a message to a chat (text or card format)
 * - send_file_to_chat: Send a file to a chat
 * - update_card: Update an existing interactive card
 * - wait_for_interaction: Wait for user to interact with a card
 *
 * @see Issue #445
 */

import { z } from 'zod';
import { getProvider, type InlineToolDefinition } from '../sdk/index.js';
import {
  getMessageAdapterService,
  resetMessageAdapterService,
} from './message-adapter-service.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('MessageMCPTools');

// ============================================================================
// Pending Interaction Management (for wait_for_interaction)
// ============================================================================

/**
 * Pending interaction tracker for wait_for_interaction tool.
 */
interface PendingInteraction {
  messageId: string;
  chatId: string;
  resolve: (action: { actionValue: string; actionType: string; userId: string }) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Global map of pending interactions waiting for user response.
 */
const pendingInteractions = new Map<string, PendingInteraction>();

/**
 * Message sent callback type.
 */
export type MessageSentCallback = (chatId: string) => void;

/**
 * Set the callback to be invoked when messages are successfully sent.
 */
export function setMessageSentCallback(callback: MessageSentCallback | null): void {
  // Set in the message adapter service
  getMessageAdapterService().setMessageSentCallback(callback);
}

/**
 * Handle incoming card action for wait_for_interaction.
 * Called by FeishuChannel when a card action is received.
 */
export function resolvePendingInteraction(
  messageId: string,
  actionValue: string,
  actionType: string,
  userId: string
): boolean {
  const pending = pendingInteractions.get(messageId);
  if (pending) {
    clearTimeout(pending.timeout);
    pendingInteractions.delete(messageId);
    pending.resolve({ actionValue, actionType, userId });
    logger.debug({ messageId, actionValue, actionType, userId }, 'Pending interaction resolved');
    return true;
  }
  return false;
}

// ============================================================================
// Tool Handlers
// ============================================================================

/**
 * Helper to create a successful tool result.
 */
function toolSuccess(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

/**
 * Tool: Send user feedback (text or card message)
 *
 * This tool works across all channels (Feishu, CLI, REST).
 * Automatically detects the channel type based on chatId format.
 */
export async function send_user_feedback(params: {
  content: string | Record<string, unknown>;
  format: 'text' | 'card';
  chatId: string;
  parentMessageId?: string;
}): Promise<{ success: boolean; message: string; error?: string }> {
  const { content, format, chatId, parentMessageId } = params;

  logger.info({
    chatId,
    format,
    contentType: typeof content,
    contentPreview: typeof content === 'string' ? content.substring(0, 100) : JSON.stringify(content).substring(0, 100),
  }, 'send_user_feedback called');

  try {
    if (!content) {
      throw new Error('content is required');
    }
    if (!format) {
      throw new Error('format is required (must be "text" or "card")');
    }
    if (!chatId) {
      throw new Error('chatId is required');
    }

    const service = getMessageAdapterService();

    if (format === 'text') {
      const textContent = typeof content === 'string' ? content : JSON.stringify(content);
      return await service.sendText(chatId, textContent, parentMessageId);
    } else {
      // Card format
      let cardContent: Record<string, unknown>;

      if (typeof content === 'object') {
        cardContent = content;
      } else if (typeof content === 'string') {
        try {
          cardContent = JSON.parse(content);
        } catch (parseError) {
          return {
            success: false,
            error: `Invalid JSON: ${parseError instanceof Error ? parseError.message : 'Parse failed'}`,
            message: '❌ Content is not valid JSON. Expected a card object.',
          };
        }
      } else {
        return {
          success: false,
          error: `Invalid content type: ${typeof content}`,
          message: '❌ Invalid content type. Expected card object or JSON string.',
        };
      }

      return await service.sendCard(chatId, cardContent, parentMessageId);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error, chatId }, 'send_user_feedback FAILED');
    return {
      success: false,
      error: errorMessage,
      message: `❌ Failed to send feedback: ${errorMessage}`,
    };
  }
}

/**
 * Tool: Send a file to a chat
 *
 * Supports multi-channel file sending.
 */
export async function send_file_to_chat(params: {
  filePath: string;
  chatId: string;
}): Promise<{
  success: boolean;
  message: string;
  fileName?: string;
  fileSize?: number;
  sizeMB?: string;
  error?: string;
}> {
  const { filePath, chatId } = params;

  try {
    if (!chatId) {
      throw new Error('chatId is required');
    }
    if (!filePath) {
      throw new Error('filePath is required');
    }

    const service = getMessageAdapterService();
    const result = await service.sendFile(chatId, filePath);

    return {
      ...result,
      fileName: result.data?.fileName as string | undefined,
      fileSize: result.data?.fileSize as number | undefined,
      sizeMB: result.data?.sizeMB as string | undefined,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error, filePath, chatId }, 'send_file_to_chat FAILED');
    return {
      success: false,
      error: errorMessage,
      message: `❌ Failed to send file: ${errorMessage}`,
    };
  }
}

/**
 * Tool: Update an existing interactive card message.
 */
export async function update_card(params: {
  messageId: string;
  card: Record<string, unknown>;
  chatId: string;
}): Promise<{ success: boolean; message: string; error?: string }> {
  const { messageId, card, chatId } = params;

  logger.info({
    messageId,
    chatId,
    cardPreview: JSON.stringify(card).substring(0, 100),
  }, 'update_card called');

  try {
    if (!messageId) {
      throw new Error('messageId is required');
    }
    if (!card) {
      throw new Error('card is required');
    }
    if (!chatId) {
      throw new Error('chatId is required');
    }

    const service = getMessageAdapterService();
    return await service.updateCard(chatId, messageId, card);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error, messageId, chatId }, 'update_card FAILED');
    return {
      success: false,
      error: errorMessage,
      message: `❌ Failed to update card: ${errorMessage}`,
    };
  }
}

/**
 * Tool: Wait for user to interact with a card.
 */
export async function wait_for_interaction(params: {
  messageId: string;
  chatId: string;
  timeoutSeconds?: number;
}): Promise<{
  success: boolean;
  message: string;
  actionValue?: string;
  actionType?: string;
  userId?: string;
  error?: string;
}> {
  const { messageId, chatId, timeoutSeconds = 300 } = params;

  logger.info({
    messageId,
    chatId,
    timeoutSeconds,
  }, 'wait_for_interaction called');

  try {
    if (!messageId) {
      throw new Error('messageId is required');
    }
    if (!chatId) {
      throw new Error('chatId is required');
    }

    // CLI mode: Simulate immediate response
    if (chatId.startsWith('cli-')) {
      logger.info({ messageId, chatId }, 'CLI mode: Simulating interaction response');
      return {
        success: true,
        message: '✅ Interaction received (CLI mode - simulated)',
        actionValue: 'simulated',
        actionType: 'button',
        userId: 'cli-user',
      };
    }

    // Check if there's already a pending interaction for this message
    if (pendingInteractions.has(messageId)) {
      return {
        success: false,
        error: 'Already waiting for interaction on this message',
        message: '❌ Another wait is already pending for this card',
      };
    }

    // Create a promise that resolves when the user interacts
    const interactionPromise = new Promise<{
      actionValue: string;
      actionType: string;
      userId: string;
    }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingInteractions.delete(messageId);
        reject(new Error(`Interaction timeout after ${timeoutSeconds} seconds`));
      }, timeoutSeconds * 1000);

      pendingInteractions.set(messageId, {
        messageId,
        chatId,
        resolve,
        reject,
        timeout,
      });

      logger.debug({ messageId, chatId, timeoutSeconds }, 'Waiting for interaction');
    });

    // Wait for the interaction
    const result = await interactionPromise;

    logger.info({
      messageId,
      chatId,
      actionValue: result.actionValue,
      actionType: result.actionType,
      userId: result.userId,
    }, 'Interaction received');

    return {
      success: true,
      message: `✅ User interaction received: ${result.actionValue}`,
      actionValue: result.actionValue,
      actionType: result.actionType,
      userId: result.userId,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Clean up pending interaction on error
    pendingInteractions.delete(messageId);

    logger.error({ err: error, messageId, chatId }, 'wait_for_interaction FAILED');

    return {
      success: false,
      error: errorMessage,
      message: `❌ Wait failed: ${errorMessage}`,
    };
  }
}

// ============================================================================
// SDK Tool Definitions
// ============================================================================

/**
 * SDK-compatible tool definitions for Agent SDK.
 */
export const messageToolDefinitions: InlineToolDefinition[] = [
  {
    name: 'send_user_feedback',
    description: `Send a message to a chat. Automatically detects the channel type (Feishu, CLI, REST) based on chatId.

**Thread Support:**
When parentMessageId is provided, the message is sent as a reply to that message.

**Card Format Requirements (for Feishu):**
When format="card", content must be a valid card object:
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"tag": "plain_text", "content": "Title"}, "template": "blue"},
  "elements": [
    {"tag": "markdown", "content": "**Bold** text"},
    {"tag": "hr"},
    {"tag": "div", "text": {"tag": "plain_text", "content": "Content"}}
  ]
}

**Note:** For non-Feishu channels, card content may be displayed in a simplified format.`,
    parameters: z.object({
      content: z.union([z.string(), z.object({}).passthrough()]).describe('The content to send. String for text, object for cards.'),
      format: z.enum(['text', 'card']).describe('Format specifier: "text" for plain text, "card" for interactive cards.'),
      chatId: z.string().describe('Chat ID (get this from task context/metadata)'),
      parentMessageId: z.string().optional().describe('Optional parent message ID for thread replies.'),
    }),
    handler: async ({ content, format, chatId, parentMessageId }) => {
      try {
        const result = await send_user_feedback({ content, format, chatId, parentMessageId });
        if (result.success) {
          return toolSuccess(result.message);
        } else {
          return toolSuccess(`⚠️ ${result.message}`);
        }
      } catch (error) {
        return toolSuccess(`⚠️ Feedback failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'send_file_to_chat',
    description: 'Send a file to a chat. Supports multi-channel file sending.',
    parameters: z.object({
      filePath: z.string().describe('Path to the file to send (relative to workspace or absolute)'),
      chatId: z.string().describe('Chat ID (get this from task context/metadata)'),
    }),
    handler: async ({ filePath, chatId }) => {
      try {
        const result = await send_file_to_chat({ filePath, chatId });
        if (result.success) {
          return toolSuccess(result.message);
        } else {
          return toolSuccess(`⚠️ ${result.message}`);
        }
      } catch (error) {
        return toolSuccess(`⚠️ File send failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'update_card',
    description: 'Update an existing interactive card message.',
    parameters: z.object({
      messageId: z.string().describe('The message ID of the card to update'),
      card: z.object({}).passthrough().describe('The new card content'),
      chatId: z.string().describe('Chat ID where the card was sent'),
    }),
    handler: async ({ messageId, card, chatId }) => {
      try {
        const result = await update_card({ messageId, card, chatId });
        if (result.success) {
          return toolSuccess(result.message);
        } else {
          return toolSuccess(`⚠️ ${result.message}`);
        }
      } catch (error) {
        return toolSuccess(`⚠️ Card update failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'wait_for_interaction',
    description: 'Wait for the user to interact with a card (click a button, select from menu, etc.). This tool blocks until the user interacts or a timeout is reached.',
    parameters: z.object({
      messageId: z.string().describe('The message ID of the card to wait for'),
      chatId: z.string().describe('Chat ID where the card was sent'),
      timeoutSeconds: z.number().optional().describe('Maximum time to wait in seconds (default: 300)'),
    }),
    handler: async ({ messageId, chatId, timeoutSeconds }) => {
      try {
        const result = await wait_for_interaction({ messageId, chatId, timeoutSeconds });
        if (result.success) {
          return toolSuccess(`${result.message}\nAction: ${result.actionValue}\nType: ${result.actionType}\nUser: ${result.userId}`);
        } else {
          return toolSuccess(`⚠️ ${result.message}`);
        }
      } catch (error) {
        return toolSuccess(`⚠️ Wait failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
];

/**
 * SDK MCP Server factory for message tools.
 *
 * Creates an in-process MCP server that provides multi-channel messaging tools.
 */
export function createMessageSdkMcpServer() {
  return getProvider().createMcpServer({
    type: 'inline',
    name: 'message-tools',
    version: '1.0.0',
    tools: messageToolDefinitions,
  });
}

/**
 * SDK-compatible tools array (for backward compatibility).
 */
export const messageSdkTools = messageToolDefinitions.map(def => getProvider().createInlineTool(def));

// ============================================================================
// Backward Compatibility Exports
// ============================================================================

/**
 * Backward compatibility: Alias for send_file_to_chat.
 * @deprecated Use send_file_to_chat instead.
 */
export const send_file_to_feishu = send_file_to_chat;

/**
 * Backward compatibility: Tool definitions with Feishu-specific naming.
 * @deprecated Use messageToolDefinitions instead.
 */
export const feishuToolDefinitions = messageToolDefinitions.map(def => ({
  ...def,
  name: def.name === 'send_file_to_chat' ? 'send_file_to_feishu' : def.name,
}));

/**
 * Backward compatibility: SDK MCP Server factory.
 * @deprecated Use createMessageSdkMcpServer instead.
 */
export const createFeishuSdkMcpServer = createMessageSdkMcpServer;

/**
 * Reset all state (for testing).
 */
export function resetAllState(): void {
  pendingInteractions.clear();
  resetMessageAdapterService();
}
