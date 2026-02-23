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
 * Get detailed validation error for an invalid card.
 * Used to provide helpful error messages to LLM for self-correction.
 *
 * @param content - Object to validate
 * @returns Human-readable error message describing what's wrong
 */
function getCardValidationError(content: unknown): string {
  if (content === null) {
    return 'content is null';
  }
  if (typeof content !== 'object') {
    return `content is ${typeof content}, expected object`;
  }
  if (Array.isArray(content)) {
    return 'content is array, expected object with config/header/elements';
  }

  const obj = content as Record<string, unknown>;
  const missing: string[] = [];

  if (!('config' in obj)) missing.push('config');
  if (!('header' in obj)) missing.push('header');
  if (!('elements' in obj)) missing.push('elements');

  if (missing.length > 0) {
    return `missing required fields: ${missing.join(', ')}`;
  }

  // Check header structure
  if (typeof obj.header !== 'object' || obj.header === null) {
    return 'header must be an object';
  }
  if (!('title' in (obj.header as Record<string, unknown>))) {
    return 'header.title is missing';
  }

  // Check elements structure
  if (!Array.isArray(obj.elements)) {
    return 'elements must be an array';
  }

  return 'unknown validation error';
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
      // Card format: strict validation, no fallback
      if (typeof content === 'object' && isValidFeishuCard(content)) {
        // Valid card object - send as-is
        await sendMessageToFeishu(client, chatId, 'interactive', JSON.stringify(content));
        logger.debug({ chatId, hasValidStructure: true }, 'User card sent (interactive)');
      } else if (typeof content === 'string') {
        // String content - must be valid JSON card
        try {
          const parsed = JSON.parse(content);
          if (isValidFeishuCard(parsed)) {
            // Valid JSON card string - send directly
            await sendMessageToFeishu(client, chatId, 'interactive', content);
            logger.debug({ chatId, wasJsonString: true }, 'User card sent (from JSON string)');
          } else {
            // Valid JSON but not a valid card - return error for LLM to fix
            const validationError = getCardValidationError(parsed);
            logger.error({
              chatId,
              contentType: 'string',
              parsedType: Array.isArray(parsed) ? 'array' : typeof parsed,
              parsedKeys: typeof parsed === 'object' && parsed !== null ? Object.keys(parsed) : [],
              validationError,
              contentPreview: content.substring(0, 500),
            }, 'Card validation failed: invalid card structure');

            return {
              success: false,
              error: `Invalid Feishu card structure: ${validationError}`,
              message: `❌ Card validation failed. ${validationError}. Required: { config, header: { title }, elements: [] }`,
            };
          }
        } catch (parseError) {
          // Invalid JSON - return error for LLM to fix
          logger.error({
            chatId,
            contentType: 'string',
            parseError: parseError instanceof Error ? parseError.message : String(parseError),
            contentPreview: content.substring(0, 500),
          }, 'Card validation failed: invalid JSON');

          return {
            success: false,
            error: `Invalid JSON: ${parseError instanceof Error ? parseError.message : 'Parse failed'}`,
            message: `❌ Content is not valid JSON. Expected a Feishu card object with: { config, header: { title }, elements: [] }`,
          };
        }
      } else {
        // Invalid type (not object or string) - return error
        const actualType = content === null ? 'null' : typeof content;
        logger.error({
          chatId,
          contentType: actualType,
          contentPreview: JSON.stringify(content).substring(0, 500),
        }, 'Card validation failed: invalid content type');

        return {
          success: false,
          error: `Invalid content type: expected object or string, got ${actualType}`,
          message: `❌ Invalid content type. Expected Feishu card object or JSON string.`,
        };
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
  feishuCode?: string | number;
  feishuMsg?: string;
  feishuLogId?: string;
  troubleshooterUrl?: string;
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
    // Extract detailed Feishu API error information
    let feishuCode: number | undefined;
    let feishuMsg: string | undefined;
    let feishuLogId: string | undefined;
    let troubleshooterUrl: string | undefined;

    // Parse error object for Feishu-specific details
    if (error && typeof error === 'object') {
      const err = error as Error & {
        code?: number | string;
        msg?: string;
        response?: {
          data?: Array<{
            code?: number;
            msg?: string;
            log_id?: string;
            troubleshooter?: string;
          }> | unknown;
        };
      };

      // Try to extract from response data (Feishu API error format)
      if (err.response?.data) {
        const {data} = err.response;
        if (Array.isArray(data) && data[0]) {
          feishuCode = data[0].code;
          feishuMsg = data[0].msg;
          feishuLogId = data[0].log_id;
          troubleshooterUrl = data[0].troubleshooter;
        }
      }

      // Fallback to error properties
      if (!feishuCode && typeof err.code === 'number') {
        feishuCode = err.code;
      }
      if (!feishuMsg) {
        feishuMsg = err.msg || err.message;
      }
    }

    logger.error({
      err: error,
      filePath,
      chatId,
      // Detailed Feishu API error info
      feishuCode,
      feishuMsg,
      feishuLogId,
      troubleshooterUrl,
    }, 'Tool: send_file_to_feishu failed');

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Build detailed error message for user
    let errorDetails = `❌ Failed to send file: ${errorMessage}`;

    if (feishuCode) {
      errorDetails += '\n\n**Feishu API Error Details:**';
      errorDetails += `\n- **Code:** ${feishuCode}`;
      if (feishuMsg) {
        errorDetails += `\n- **Message:** ${feishuMsg}`;
      }
      if (feishuLogId) {
        errorDetails += `\n- **Log ID:** ${feishuLogId}`;
      }
      if (troubleshooterUrl) {
        errorDetails += `\n- **Troubleshoot:** ${troubleshooterUrl}`;
      }
    }

    return {
      success: false,
      error: errorMessage,
      message: errorDetails,
      feishuCode,
      feishuMsg,
      feishuLogId,
      troubleshooterUrl,
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
    description: 'Send a message to a Feishu chat. Requires explicit format: "text" or "card". Use this to report progress, provide updates, or send rich content to users.\n\n**Format Guidelines:**\n- For "text" format: Send plain text as a string\n- For "card" format: Send a Feishu interactive card object following the structure below\n\n**Valid Card Structure:**\nA valid card must include:\n- config: Object with optional "wide_screen_mode"\n- header: Object with "title" (containing {"tag": "plain_text", "content": "..."}) and "template" color\n- elements: Array of element objects\n\n**Supported Element Types:**\n- Markdown content: {"tag": "markdown", "content": "**Your markdown text**"}\n- Divider: {"tag": "hr"}\n- Plain text in div: {"tag": "div", "text": {"tag": "plain_text", "content": "Your text"}}\n\n**Example Card:**\n{\n  "config": {"wide_screen_mode": true},\n  "header": {"title": {"tag": "plain_text", "content": "Summary Report"}, "template": "blue"},\n  "elements": [\n    {"tag": "markdown", "content": "## Task Status\\n\\n✅ Completed successfully"},\n    {"tag": "hr"},\n    {"tag": "markdown", "content": "**Details:**\\n\\n- Processed 150 files\\n- Generated 25 reports"},\n    {"tag": "hr"},\n    {"tag": "div", "text": {"tag": "plain_text", "content": "Next steps: Review and deploy"}}\n  ]\n}\n\n**Reference:** https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/using-markdown-tags',
    parameters: {
      type: 'object',
      properties: {
        content: {
          oneOf: [
            { type: 'string' },
            { type: 'object' }
          ],
          description: 'The content to send. For text format: use a string. For card format: use a valid Feishu card object (see description).',
        },
        format: {
          type: 'string',
          enum: ['text', 'card'],
          description: 'Format specifier (required): "text" for plain text messages, "card" for interactive cards.',
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

// SDK-compatible tools array
export const feishuSdkTools = [
  tool(
    'send_user_feedback',
    'Send a message to a Feishu chat. Requires explicit format: "text" or "card". Use this to report progress, provide updates, or send rich content.\n\n**Card Format Requirements:**\nWhen format="card", content must be a valid Feishu card object with the following structure:\n\n{\n  "config": {"wide_screen_mode": true},\n  "header": {"title": {"tag": "plain_text", "content": "Title"}, "template": "blue"},\n  "elements": [\n    {"tag": "markdown", "content": "**Bold** and *italic* text"},\n    {"tag": "hr"},\n    {"tag": "div", "text": {"tag": "plain_text", "content": "Plain text content"}}\n  ]\n}\n\n**Key Elements to Use:**\n- {"tag": "markdown", "content": "..."} - For markdown formatted text\n- {"tag": "hr"} - For horizontal dividers\n- {"tag": "div", "text": {"tag": "plain_text", "content": "..."}} - For plain text in containers\n\n**Reference:** https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/using-markdown-tags',
    {
      content: z.union([z.string(), z.object({}).passthrough()]).describe('The content to send. String for text messages, object for cards (must follow Feishu card structure - see tool description).'),
      format: z.enum(['text', 'card']).describe('Format specifier (required): "text" for plain text, "card" for interactive cards with VALID structure.'),
      chatId: z.string().describe('Feishu chat ID (get this from the task context/metadata)'),
    },
    async ({ content, format, chatId }) => {
      try {
        const result = await send_user_feedback({ content, format, chatId });
        if (result.success) {
          return toolSuccess(result.message);
        } else {
          // Return as soft error (not isError) to avoid SDK subprocess crash
          // The agent can retry or continue with other operations
          return toolSuccess(`⚠️ ${result.message}`);
        }
      } catch (error) {
        // Return as soft error to avoid SDK subprocess crash
        return toolSuccess(`⚠️ Feedback failed: ${error instanceof Error ? error.message : String(error)}`);
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
          // Return as soft error (not isError) to avoid SDK subprocess crash
          // The agent can continue with other operations
          return toolSuccess(`⚠️ ${result.message}`);
        }
      } catch (error) {
        // Return as soft error to avoid SDK subprocess crash
        return toolSuccess(`⚠️ File send failed: ${error instanceof Error ? error.message : String(error)}`);
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
