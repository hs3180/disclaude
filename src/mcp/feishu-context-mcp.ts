/**
 * Feishu Context MCP Tools - In-process tool implementation.
 *
 * This module provides tool definitions that allow agents to send feedback
 * and files to Feishu chats directly using Feishu API.
 *
 * Tools provided:
 * - send_user_feedback: Send a message to a Feishu chat (text or card format, REQUIRED)
 * - send_file_to_feishu: Send a file to a Feishu chat
 *
 * **Note**: task_done is now an inline tool provided by the Evaluator agent,
 * not part of the Feishu MCP server.
 *
 * **No global state**: Credentials are read from Config, chatId is passed as parameter.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../utils/logger.js';
import { Config } from '../config/index.js';

const logger = createLogger('FeishuContextMCP');

/**
 * Message sent callback type.
 * Called when a message is successfully sent to track user communication.
 */
export type MessageSentCallback = (chatId: string) => void;

/**
 * Global callback for tracking when messages are sent.
 * Set by FeishuBot to bridge MCP tool calls with message tracking.
 */
let messageSentCallback: MessageSentCallback | null = null;

/**
 * Set the callback to be invoked when messages are successfully sent.
 * This allows MCP tools to notify the dialogue bridge when user messages are sent.
 *
 * @param callback - Function to call on successful message send
 */
export function setMessageSentCallback(callback: MessageSentCallback | null): void {
  messageSentCallback = callback;
}

/**
 * Internal helper: Send a message to Feishu chat.
 *
 * Handles the common logic for sending messages to Feishu API.
 *
 * @param client - Lark client instance
 * @param chatId - Feishu chat ID
 * @param msgType - Message type ('text' or 'interactive')
 * @param content - Message content (JSON stringified)
 * @throws Error if sending fails
 */
async function sendMessageToFeishu(
  client: lark.Client,
  chatId: string,
  msgType: 'text' | 'interactive',
  content: string
): Promise<void> {
  await client.im.message.create({
    params: {
      receive_id_type: 'chat_id',
    },
    data: {
      receive_id: chatId,
      msg_type: msgType,
      content,
    },
  });
}

/**
 * Check if content is a valid Feishu interactive card structure.
 * Valid cards must have: config, header (with title), and elements array.
 *
 * @param content - Object to validate
 * @returns true if valid Feishu card structure
 */
function isValidFeishuCard(content: Record<string, unknown>): boolean {
  return (
    typeof content === 'object' &&
    content !== null &&
    'config' in content &&
    'header' in content &&
    'elements' in content &&
    Array.isArray(content.elements) &&
    typeof content.header === 'object' &&
    content.header !== null &&
    'title' in content.header
  );
}

/**
 * Build a simple Feishu card from Markdown text content.
 * Creates a minimal valid card structure with a single markdown element.
 *
 * Reference: src/feishu/write-card-builder.ts
 *
 * @param markdownContent - Markdown text to display
 * @param title - Optional card title (default: 'Assistant')
 * @returns Valid Feishu card structure
 */
function buildMarkdownCard(markdownContent: string, title = 'Assistant'): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: 'plain_text',
        content: title,
      },
      template: 'blue',
    },
    elements: [
      {
        tag: 'markdown',
        content: markdownContent,
      },
    ],
  };
}

/**
 * Tool: Send user feedback (text or card message)
 *
 * This tool allows agents to send messages directly to Feishu chats.
 * Requires explicit format specification: 'text' or 'card'.
 * Credentials are read from Config, chatId is required parameter.
 *
 * CLI Mode: When chatId starts with "cli-", the message is logged
 * instead of being sent to Feishu API.
 *
 * @param params - Tool parameters
 * @returns Result object with success status
 */
export async function send_user_feedback(params: {
  content: string | Record<string, unknown>;
  format: 'text' | 'card';
  chatId: string;
}): Promise<{
  success: boolean;
  message: string;
  error?: string;
}> {
  const { content, format, chatId } = params;

  // DIAGNOSTIC: Log all send_user_feedback calls
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

    // CLI mode: Log the message instead of sending to Feishu
    if (chatId.startsWith('cli-')) {
      const displayContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
      logger.info({ chatId, format, contentPreview: displayContent.substring(0, 100) }, 'CLI mode: User feedback');
      // Use console.log for direct visibility in CLI mode
      console.log(`\n${displayContent}\n`);

      // Notify callback that a message was sent (for dialogue bridge tracking)
      if (messageSentCallback) {
        try {
          messageSentCallback(chatId);
        } catch (error) {
          logger.error({ err: error }, 'Failed to invoke message sent callback');
        }
      }

      return {
        success: true,
        message: `✅ Feedback displayed (CLI mode, format: ${format})`,
      };
    }

    // Read credentials from Config
    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET must be configured in Config');
    }

    // Create Lark client and send message
    const client = new lark.Client({
      appId,
      appSecret,
      domain: lark.Domain.Feishu,
    });

    if (format === 'text') {
      // Send as text message
      const textContent = typeof content === 'string' ? content : JSON.stringify(content);
      await sendMessageToFeishu(client, chatId, 'text', JSON.stringify({ text: textContent }));

      logger.debug({
        chatId,
        messageLength: textContent.length,
        message: textContent
      }, 'User feedback sent (text)');
    } else {
      // Card format: validate before sending
      if (typeof content === 'object' && isValidFeishuCard(content)) {
        // Valid card - send as-is
        await sendMessageToFeishu(client, chatId, 'interactive', JSON.stringify(content));
        logger.debug({ chatId, hasValidStructure: true }, 'User card sent (interactive)');
      } else if (typeof content === 'string') {
        // String content - convert to valid markdown card
        const card = buildMarkdownCard(content);
        await sendMessageToFeishu(client, chatId, 'interactive', JSON.stringify(card));
        logger.debug({ chatId, contentLength: content.length }, 'User markdown card sent (converted)');
      } else {
        // Invalid object - fallback to text message
        const fallbackText = JSON.stringify(content, null, 2);
        await sendMessageToFeishu(client, chatId, 'text', JSON.stringify({ text: fallbackText }));
        logger.warn({ chatId, reason: 'invalid_card_structure' }, 'Invalid card format, sent as text instead');
      }
    }

    // Notify callback that a message was sent (for dialogue bridge tracking)
    if (messageSentCallback) {
      try {
        messageSentCallback(chatId);
      } catch (error) {
        logger.error({ err: error }, 'Failed to invoke message sent callback');
      }
    }

    return {
      success: true,
      message: `✅ Feedback sent (format: ${format})`,
    };

  } catch (error) {
    // DIAGNOSTIC: Enhanced error logging
    logger.error({
      err: error,
      chatId,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
    }, 'send_user_feedback FAILED');

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return {
      success: false,
      error: errorMessage,
      message: `❌ Failed to send feedback: ${errorMessage}`,
    };
  }
}

/**
 * Tool: Send a file to Feishu chat
 *
 * This tool allows agents to upload a local file and send it to a Feishu chat.
 * Credentials are read from Config, chatId is required parameter.
 *
 * @param params - Tool parameters
 * @returns Result object with success status and file details
 */
export async function send_file_to_feishu(params: {
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

    // Read credentials from Config
    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET must be configured in Config');
    }

    // Resolve file path
    const workspaceDir = Config.getWorkspaceDir();
    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(workspaceDir, filePath);

    logger.debug({ filePath, resolvedPath, workspaceDir, chatId }, 'send_file_to_feishu called');

    // Check file exists
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${filePath}`);
    }

    // Import Feishu uploader (dynamic import to avoid circular dependencies)
    const { uploadAndSendFile } = await import('../feishu/file-uploader.js');

    // Create client with credentials from Config
    const client = new lark.Client({
      appId,
      appSecret,
      domain: lark.Domain.Feishu,
    });

    // Upload and send file
    const fileSize = await uploadAndSendFile(client, resolvedPath, chatId);

    const sizeMB = (fileSize / 1024 / 1024).toFixed(2);
    const fileName = path.basename(resolvedPath);

    logger.info({
      fileName,
      fileSize,
      sizeMB,
      filePath: resolvedPath,
      chatId
    }, 'File sent successfully');

    return {
      success: true,
      message: `✅ File sent: ${fileName} (${sizeMB} MB)`,
      fileName,
      fileSize,
      sizeMB,
    };

  } catch (error) {
    logger.error({ err: error, filePath }, 'Tool: send_file_to_feishu failed');

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return {
      success: false,
      error: errorMessage,
      message: `❌ Failed to send file: ${errorMessage}`,
    };
  }
}

/**
 * Tool definitions for Agent SDK integration.
 *
 * Export tools in a format compatible with inline MCP servers.
 *
 * IMPORTANT: These tools should be registered via the `tools` parameter
 * in createSdkOptions(), not listed in `allowedTools`.
 */
export const feishuContextTools = {
  send_user_feedback: {
    description: 'Send a message to a Feishu chat. Requires explicit format: "text" or "card". Use this to report progress, provide updates, or send rich content like code diffs to users.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          oneOf: [
            { type: 'string' },
            { type: 'object' }
          ],
          description: 'The content to send. Use a string for text messages, or an object for interactive cards.',
        },
        format: {
          type: 'string',
          enum: ['text', 'card'],
          description: 'Format specifier (required): "text" for plain text, "card" for interactive cards.',
        },
        chatId: {
          type: 'string',
          description: 'Feishu chat ID (get this from the task context/metadata)',
        },
      },
      required: ['content', 'format', 'chatId'],
    },
    handler: send_user_feedback,
  },
  send_file_to_feishu: {
    description: 'Send a file to a Feishu chat. Supports images, audio, video, and documents.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to the file to send (relative to workspace or absolute)',
        },
        chatId: {
          type: 'string',
          description: 'Feishu chat ID (get this from the task context/metadata)',
        },
      },
      required: ['filePath', 'chatId'],
    },
    handler: send_file_to_feishu,
  },
};

/**
 * SDK-compatible tool definitions.
 *
 * Converts feishuContextTools to the format expected by the Agent SDK:
 * - Array format (not object with keys)
 * - Zod schemas for input validation
 * - Proper SdkMcpToolDefinition structure
 */
import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

/**
 * Helper to create a successful tool result.
 * Returns content in MCP CallToolResult format.
 */
function toolSuccess(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text }],
  };
}

/**
 * Helper to create an error tool result.
 */
function toolError(errorMessage: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [{ type: 'text', text: `❌ Error: ${errorMessage}` }],
    isError: true,
  };
}

// SDK-compatible tools array
export const feishuSdkTools = [
  tool(
    'send_user_feedback',
    'Send a message to a Feishu chat. Requires explicit format: "text" or "card". Use this to report progress, provide updates, or send rich content like code diffs to users.',
    {
      content: z.union([z.string(), z.object({}).passthrough()]).describe('The content to send. Use a string for text messages, or an object for interactive cards.'),
      format: z.enum(['text', 'card']).describe('Format specifier (required): "text" for plain text, "card" for interactive cards.'),
      chatId: z.string().describe('Feishu chat ID (get this from the task context/metadata)'),
    },
    async ({ content, format, chatId }) => {
      try {
        const result = await send_user_feedback({ content, format, chatId });
        if (result.success) {
          return toolSuccess(result.message);
        } else {
          return toolError(result.error || 'Unknown error');
        }
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  ),
  tool(
    'send_file_to_feishu',
    'Send a file to a Feishu chat. Supports images, audio, video, and documents.',
    {
      filePath: z.string().describe('Path to the file to send (relative to workspace or absolute)'),
      chatId: z.string().describe('Feishu chat ID (get this from the task context/metadata)'),
    },
    async ({ filePath, chatId }) => {
      try {
        const result = await send_file_to_feishu({ filePath, chatId });
        if (result.success) {
          return toolSuccess(result.message);
        } else {
          return toolError(result.error || 'Unknown error');
        }
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  ),
];

/**
 * SDK MCP Server for Feishu context tools.
 *
 * **Lifecycle:**
 * - This is a module-level singleton created once at process startup
 * - Persists for the lifetime of the application
 * - Shared across all Manager agent instances
 * - Does NOT need to be cleaned up between dialogues
 *
 * **Usage:**
 * Add this to the `mcpServers` SDK option when creating queries:
 * ```typescript
 * query({
 *   prompt: "...",
 *   options: {
 *     mcpServers: {
 *       'feishu-context': feishuSdkMcpServer,
 *     },
 *   },
 * })
 * ```
 *
 * **Memory Management:**
 * - The SDK creates per-query instances of this MCP server
 * - SDK automatically cleans up these instances when queries complete
 * - No manual cleanup required for the singleton itself
 * - Agent cleanup() methods clear session IDs, allowing SDK to release resources
 *
 * Creates an in-process MCP server that provides Feishu integration tools
 * to the Agent SDK.
 */
export const feishuSdkMcpServer = createSdkMcpServer({
  name: 'feishu-context',
  version: '1.0.0',
  tools: feishuSdkTools,
});
