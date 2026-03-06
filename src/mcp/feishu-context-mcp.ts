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
import { createFeishuClient } from '../platforms/feishu/create-feishu-client.js';

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
 * Supports thread replies via parent_id parameter.
 *
 * @param client - Lark client instance
 * @param chatId - Feishu chat ID
 * @param msgType - Message type ('text' or 'interactive')
 * @param content - Message content (JSON stringified)
 * @param parentId - Optional parent message ID for thread replies
 * @throws Error if sending fails
 */
async function sendMessageToFeishu(
  client: lark.Client,
  chatId: string,
  msgType: 'text' | 'interactive',
  content: string,
  parentId?: string
): Promise<void> {
  const messageData: {
    receive_id_type?: string;
    msg_type: string;
    content: string;
  } = {
    msg_type: msgType,
    content,
  };

  // When replying to a message, use reply method to properly quote the user's message
  if (parentId) {
    await client.im.message.reply({
      path: {
        message_id: parentId,
      },
      data: messageData,
    });
  } else {
    // New message: use create method with receive_id
    await client.im.message.create({
      params: {
        receive_id_type: 'chat_id',
      },
      data: {
        receive_id: chatId,
        ...messageData,
      },
    });
  }
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

  if (!('config' in obj)) {missing.push('config');}
  if (!('header' in obj)) {missing.push('header');}
  if (!('elements' in obj)) {missing.push('elements');}

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
 * Thread Support: When parentMessageId is provided, the message is sent
 * as a reply to that message, creating a thread in Feishu.
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
  parentMessageId?: string;
}): Promise<{
  success: boolean;
  message: string;
  error?: string;
}> {
  const { content, format, chatId, parentMessageId } = params;

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

    // Graceful degradation: When Feishu credentials are not configured,
    // log the message instead of failing. This allows REST channel and
    // test environments to work without Feishu credentials.
    if (!appId || !appSecret) {
      const displayContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
      logger.info({
        chatId,
        format,
        contentPreview: displayContent.substring(0, 200),
        reason: 'Feishu credentials not configured'
      }, 'Feedback logged (graceful degradation mode)');

      // Use console.log for visibility in non-Feishu environments
      console.log(`\n[Feedback] ${displayContent}\n`);

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
        message: `✅ Feedback logged (Feishu not configured, format: ${format})`,
      };
    }

    // Create Lark client and send message
    const client = createFeishuClient(appId, appSecret, {
      domain: lark.Domain.Feishu,
    });

    if (format === 'text') {
      // Send as text message
      const textContent = typeof content === 'string' ? content : JSON.stringify(content);
      await sendMessageToFeishu(client, chatId, 'text', JSON.stringify({ text: textContent }), parentMessageId);

      logger.debug({
        chatId,
        messageLength: textContent.length,
        message: textContent,
        parentMessageId,
      }, 'User feedback sent (text)');
    } else {
      // Card format: strict validation, no fallback
      if (typeof content === 'object' && isValidFeishuCard(content)) {
        // Valid card object - send as-is
        await sendMessageToFeishu(client, chatId, 'interactive', JSON.stringify(content), parentMessageId);
        logger.debug({ chatId, hasValidStructure: true, parentMessageId }, 'User card sent (interactive)');
      } else if (typeof content === 'string') {
        // String content - must be valid JSON card
        try {
          const parsed = JSON.parse(content);
          if (isValidFeishuCard(parsed)) {
            // Valid JSON card string - send directly
            await sendMessageToFeishu(client, chatId, 'interactive', content, parentMessageId);
            logger.debug({ chatId, wasJsonString: true, parentMessageId }, 'User card sent (from JSON string)');
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
            message: '❌ Content is not valid JSON. Expected a Feishu card object with: { config, header: { title }, elements: [] }',
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
          message: '❌ Invalid content type. Expected Feishu card object or JSON string.',
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

    // Graceful degradation: When Feishu credentials are not configured,
    // return a soft error instead of throwing. This allows the agent to
    // continue execution in REST channel and test environments.
    if (!appId || !appSecret) {
      logger.warn({
        filePath,
        chatId,
        reason: 'Feishu credentials not configured'
      }, 'File send skipped (Feishu not configured)');

      return {
        success: false,
        error: 'Feishu credentials not configured',
        message: '⚠️ File cannot be sent: Feishu is not configured. File will be available locally.',
      };
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
    const { uploadAndSendFile } = await import('../file-transfer/outbound/feishu-uploader.js');

    // Create client with credentials from Config
    const client = createFeishuClient(appId, appSecret, {
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

// ============================================================================
// Card Interaction Tools (Issue #275 Phase 4)
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
 * Handle incoming card action for wait_for_interaction.
 * Called by FeishuChannel when a card action is received.
 *
 * @param messageId - The card message ID
 * @param actionValue - The action value from the button click
 * @param actionType - The action type (button, menu, etc.)
 * @param userId - The user who triggered the action
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

/**
 * Tool: Update an existing interactive card message.
 *
 * Updates the content of a previously sent interactive card.
 * Requires the message_id of the card to update.
 *
 * @param params - Tool parameters
 * @returns Result object with success status
 */
export async function update_card(params: {
  messageId: string;
  card: Record<string, unknown>;
  chatId: string;
}): Promise<{
  success: boolean;
  message: string;
  error?: string;
}> {
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

    // Validate card structure
    if (!isValidFeishuCard(card)) {
      const validationError = getCardValidationError(card);
      return {
        success: false,
        error: `Invalid card structure: ${validationError}`,
        message: `❌ Card validation failed. ${validationError}`,
      };
    }

    // CLI mode: Log the update instead of calling API
    if (chatId.startsWith('cli-')) {
      logger.info({ messageId, chatId }, 'CLI mode: Card update simulated');
      return {
        success: true,
        message: '✅ Card updated (CLI mode)',
      };
    }

    // Read credentials from Config
    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    // Graceful degradation: When Feishu credentials are not configured,
    // return a soft error instead of throwing. This allows the agent to
    // continue execution in REST channel and test environments.
    if (!appId || !appSecret) {
      logger.warn({
        messageId,
        chatId,
        reason: 'Feishu credentials not configured'
      }, 'Card update skipped (Feishu not configured)');

      return {
        success: false,
        error: 'Feishu credentials not configured',
        message: '⚠️ Card cannot be updated: Feishu is not configured.',
      };
    }

    // Create Lark client
    const client = createFeishuClient(appId, appSecret, {
      domain: lark.Domain.Feishu,
    });

    // Update the card using patch API
    await client.im.message.patch({
      path: {
        message_id: messageId,
      },
      data: {
        content: JSON.stringify(card),
      },
    });

    logger.debug({ messageId, chatId }, 'Card updated successfully');

    return {
      success: true,
      message: '✅ Card updated successfully',
    };

  } catch (error) {
    logger.error({
      err: error,
      messageId,
      chatId,
    }, 'update_card failed');

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return {
      success: false,
      error: errorMessage,
      message: `❌ Failed to update card: ${errorMessage}`,
    };
  }
}

/**
 * Tool: Wait for user to interact with a card.
 *
 * Registers a wait handler for the specified card and returns when
 * the user clicks a button or interacts with the card.
 *
 * Note: This tool will block until the user interacts or timeout is reached.
 * The interaction is resolved via resolvePendingInteraction() called by FeishuChannel.
 *
 * @param params - Tool parameters
 * @returns Result object with the action taken by the user
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

    logger.error({
      err: error,
      messageId,
      chatId,
    }, 'wait_for_interaction failed');

    return {
      success: false,
      error: errorMessage,
      message: `❌ Wait failed: ${errorMessage}`,
    };
  }
}

// ============================================================================
// Offline Message Tools (Issue #631)
// ============================================================================

/**
 * Build an offline message card with optional reply button.
 *
 * @param message - The message content to leave
 * @param context - Additional context for the message
 * @returns Feishu interactive card
 */
function buildOfflineMessageCard(
  message: string,
  context?: string
): Record<string, unknown> {
  const elements: CardElement[] = [
    {
      tag: 'markdown',
      content: message,
    },
  ];

  // Add context section if provided
  if (context) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'note',
      elements: [
        {
          tag: 'plain_text',
          content: `上下文: ${context.substring(0, 200)}${context.length > 200 ? '...' : ''}`,
        },
      ],
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '📝 Agent 留言' },
      template: 'turquoise',
    },
    elements,
  };
}

// Type imports for card building (reused from ask_user)
type CardElement = {
  tag: 'div' | 'markdown' | 'action' | 'hr' | 'note' | 'img' | 'column_set';
  text?: { tag: 'plain_text' | 'lark_md'; content: string };
  content?: string;
  actions?: ButtonAction[];
  elements?: { tag: 'plain_text'; content: string }[];
};

type ButtonAction = {
  tag: 'button';
  text: { tag: 'plain_text'; content: string };
  type: 'primary' | 'default' | 'danger';
  value: Record<string, string>;
};

/**
 * Tool: Leave an offline message for the user (non-blocking).
 *
 * Sends a message to the user without waiting for a response.
 * When the user replies, a callback can be triggered to handle the response.
 *
 * This is useful for:
 * - Asking questions that don't need immediate answers
 * - Leaving reminders or status updates
 * - Starting async discussions
 *
 * Issue #631: 离线提问 - Agent 不阻塞工作的留言机制
 *
 * @param params - Tool parameters
 * @returns Result object with messageId for tracking
 */
export async function leave_message(params: {
  message: string;
  chatId: string;
  context?: string;
  callbackAction?: 'create_task' | 'trigger_skill' | 'record_knowledge';
  callbackParams?: Record<string, unknown>;
}): Promise<{
  success: boolean;
  message: string;
  messageId?: string;
  error?: string;
}> {
  const {
    message,
    chatId,
    context,
    callbackAction = 'create_task',
    callbackParams,
  } = params;

  logger.info({
    message: message.substring(0, 100),
    chatId,
    callbackAction,
    hasContext: !!context,
  }, 'leave_message called');

  try {
    if (!message) {
      throw new Error('message is required');
    }
    if (!chatId) {
      throw new Error('chatId is required');
    }

    // CLI mode: Just log the message
    if (chatId.startsWith('cli-')) {
      logger.info({ chatId, message }, 'CLI mode: Offline message logged');
      return {
        success: true,
        message: `✅ Offline message logged (CLI mode)`,
        messageId: `cli-${Date.now()}`,
      };
    }

    // Build and send the message card
    const card = buildOfflineMessageCard(message, context);

    const sendResult = await send_user_feedback({
      content: card,
      format: 'card',
      chatId,
    });

    if (!sendResult.success) {
      return {
        success: false,
        error: sendResult.error,
        message: `❌ Failed to send offline message: ${sendResult.message}`,
      };
    }

    const messageId = sendResult.messageId;
    if (!messageId) {
      return {
        success: false,
        error: 'No message ID returned from send',
        message: '❌ Failed to get message ID for tracking',
      };
    }

    // Store the offline message context for callback handling
    const { getOfflineMessageStore } = await import('../messaging/offline-message-store.js');
    const store = getOfflineMessageStore();

    await store.save({
      id: messageId,
      chatId,
      question: message,
      agentContext: context,
      callbackAction,
      callbackParams,
    });

    logger.info({
      messageId,
      chatId,
      callbackAction,
    }, 'Offline message sent and stored');

    return {
      success: true,
      message: `✅ Offline message sent. User can reply at any time.`,
      messageId,
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    logger.error({
      err: error,
      chatId,
      message: message.substring(0, 100),
    }, 'leave_message failed');

    return {
      success: false,
      error: errorMessage,
      message: `❌ Leave message failed: ${errorMessage}`,
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
    description: `Send a message to a Feishu chat. Requires explicit format: "text" or "card".

**IMPORTANT: "format" parameter is REQUIRED for every call.**

---

## Correct Usage Examples

### Text Message
\`\`\`json
{"content": "Hello world", "format": "text", "chatId": "oc_xxx"}
\`\`\`

### Card Message
\`\`\`json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {"title": {"tag": "plain_text", "content": "Title"}, "template": "blue"},
    "elements": [{"tag": "markdown", "content": "**Bold** text"}]
  },
  "format": "card",
  "chatId": "oc_xxx"
}
\`\`\`

---

## Parameter Validation Rules

| format | content Type | Description |
|--------|-------------|-------------|
| \`"text"\` | \`string\` | Plain text or Markdown |
| \`"card"\` | \`object\` | Feishu card with {config, header, elements} |

---

## Common Mistakes to Avoid

❌ Missing format parameter
❌ format: "card" with string content (must be object)
❌ format: "text" with object content (must be string)
❌ Card missing header.title or elements

---

**Thread Support:** Use parentMessageId to reply to a specific message.

⚠️ **Markdown Tables NOT Supported** - Use column_set instead.

**Reference:** https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/using-markdown-tags`,
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
        parentMessageId: {
          type: 'string',
          description: 'Optional parent message ID for thread replies. When provided, the message is sent as a reply to this message.',
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
  update_card: {
    description: 'Update an existing interactive card message. Use this to change the content of a card that was already sent, such as updating a progress indicator or changing button states.',
    parameters: {
      type: 'object',
      properties: {
        messageId: {
          type: 'string',
          description: 'The message ID of the card to update',
        },
        card: {
          type: 'object',
          description: 'The new card content (must be a valid Feishu card structure)',
        },
        chatId: {
          type: 'string',
          description: 'Feishu chat ID where the card was sent',
        },
      },
      required: ['messageId', 'card', 'chatId'],
    },
    handler: update_card,
  },
  wait_for_interaction: {
    description: 'Wait for the user to interact with a card (click a button, select from menu, etc.). This tool blocks until the user interacts or a timeout is reached. Returns the action value from the button or menu that was clicked.',
    parameters: {
      type: 'object',
      properties: {
        messageId: {
          type: 'string',
          description: 'The message ID of the card to wait for',
        },
        chatId: {
          type: 'string',
          description: 'Feishu chat ID where the card was sent',
        },
        timeoutSeconds: {
          type: 'number',
          description: 'Maximum time to wait in seconds (default: 300)',
        },
      },
      required: ['messageId', 'chatId'],
    },
    handler: wait_for_interaction,
  },
};

/**
 * SDK-compatible tool definitions.
 *
 * Uses InlineToolDefinition format for SDK abstraction.
 */
import { z } from 'zod';
import { getProvider, type InlineToolDefinition } from '../sdk/index.js';

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
 * Feishu MCP tool definitions for Agent SDK.
 *
 * Uses InlineToolDefinition format for SDK abstraction.
 */
export const feishuToolDefinitions: InlineToolDefinition[] = [
  {
    name: 'send_user_feedback',
    description: `Send a message to a Feishu chat. Requires explicit format: "text" or "card".

**IMPORTANT: "format" parameter is REQUIRED for every call.**

---

## Correct Usage Examples

### Text Message
\`\`\`json
{
  "content": "Hello, this is a plain text message",
  "format": "text",
  "chatId": "oc_xxx"
}
\`\`\`

### Card Message
\`\`\`json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {
      "title": {"tag": "plain_text", "content": "Card Title"},
      "template": "blue"
    },
    "elements": [
      {"tag": "markdown", "content": "**Bold** and *italic* text"},
      {"tag": "hr"},
      {"tag": "div", "text": {"tag": "plain_text", "content": "Plain text content"}}
    ]
  },
  "format": "card",
  "chatId": "oc_xxx"
}
\`\`\`

---

## Parameter Validation Rules

| format | content Type | Description |
|--------|-------------|-------------|
| \`"text"\` | \`string\` | Plain text or Markdown |
| \`"card"\` | \`object\` | Feishu card JSON with required structure |

---

## Card Format Requirements

When \`format: "card"\`, content MUST include:
- \`config\`: Object (e.g., \`{"wide_screen_mode": true}\`)
- \`header\`: Object with \`title\` (e.g., \`{"title": {"tag": "plain_text", "content": "..."}, "template": "blue"}\`)
- \`elements\`: Array of card elements

---

## Common Mistakes to Avoid

❌ **Missing format parameter** - Always specify format: "text" or "card"
❌ **format: "card" with string content** - Must be an object with config/header/elements
❌ **format: "text" with object content** - Must be a string
❌ **Card missing header.title** - Title is required inside header
❌ **Card missing elements array** - Elements array is required (can be empty [])

---

## Thread Support

When parentMessageId is provided, the message is sent as a reply to that message, creating a thread in Feishu.

---

## Key Card Elements

- \`{"tag": "markdown", "content": "..."}\` - Markdown formatted text
- \`{"tag": "hr"}\` - Horizontal divider
- \`{"tag": "div", "text": {"tag": "plain_text", "content": "..."}}\` - Plain text in containers
- \`{"tag": "column_set", ...}\` - For tables (see below)

⚠️ **Markdown Tables NOT Supported** - Use column_set instead.

**Reference:** https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/using-markdown-tags`,
    parameters: z.object({
      content: z.union([z.string(), z.object({}).passthrough()]).describe('The content to send. MUST match format type: string for "text", object for "card" with {config, header, elements}.'),
      format: z.enum(['text', 'card'], {
        message: 'format is REQUIRED. Use "text" for plain text messages or "card" for interactive cards.',
      }).describe('REQUIRED: "text" for plain text, "card" for interactive cards. This parameter is mandatory.'),
      chatId: z.string().describe('Feishu chat ID (get this from the task context/metadata)'),
      parentMessageId: z.string().optional().describe('Optional parent message ID for thread replies.'),
    }),
    handler: async ({ content, format, chatId, parentMessageId }) => {
      // Pre-validation with helpful error messages for common mistakes
      if (format === 'card' && typeof content === 'string') {
        return toolSuccess('❌ Error: When format="card", content must be an OBJECT with {config, header, elements}, not a string.\n\nCorrect example:\n{"content": {"config": {...}, "header": {...}, "elements": [...]}, "format": "card", "chatId": "..."}');
      }
      if (format === 'text' && typeof content !== 'string') {
        return toolSuccess('❌ Error: When format="text", content must be a STRING, not an object.\n\nCorrect example:\n{"content": "Your text here", "format": "text", "chatId": "..."}');
      }
      // Additional card structure validation
      if (format === 'card' && typeof content === 'object' && content !== null) {
        const obj = content as Record<string, unknown>;
        const missing: string[] = [];
        if (!('config' in obj)) { missing.push('config'); }
        if (!('header' in obj)) { missing.push('header'); }
        if (!('elements' in obj)) { missing.push('elements'); }
        if (missing.length > 0) {
          return toolSuccess(`❌ Card validation failed: missing required fields: ${missing.join(', ')}.\n\nRequired structure:\n{"config": {...}, "header": {"title": {...}, ...}, "elements": [...]}`);
        }
        // Check header.title
        if (typeof obj.header === 'object' && obj.header !== null && !('title' in (obj.header as Record<string, unknown>))) {
          return toolSuccess('❌ Card validation failed: header.title is missing.\n\nHeader must include title:\n{"header": {"title": {"tag": "plain_text", "content": "..."}, "template": "blue"}, ...}');
        }
      }

      try {
        const result = await send_user_feedback({ content, format, chatId, parentMessageId });
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
    },
  },
  {
    name: 'send_file_to_feishu',
    description: 'Send a file to a Feishu chat. Supports images, audio, video, and documents.',
    parameters: z.object({
      filePath: z.string().describe('Path to the file to send (relative to workspace or absolute)'),
      chatId: z.string().describe('Feishu chat ID (get this from the task context/metadata)'),
    }),
    handler: async ({ filePath, chatId }) => {
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
    },
  },
  {
    name: 'update_card',
    description: 'Update an existing interactive card message. Use this to change the content of a card that was already sent.\n\n**Use Cases:**\n- Update progress indicators\n- Change button states (enable/disable)\n- Show results after user action\n- Display dynamic content\n\n**Note:** The card must have been sent previously using send_user_feedback with format="card".',
    parameters: z.object({
      messageId: z.string().describe('The message ID of the card to update (from the original send_user_feedback response)'),
      card: z.object({}).passthrough().describe('The new card content (must be a valid Feishu card structure with config, header, elements)'),
      chatId: z.string().describe('Feishu chat ID where the card was sent'),
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
    description: 'Wait for the user to interact with a card (click a button, select from menu, etc.).\n\n**This tool blocks** until the user interacts or a timeout is reached.\n\n**Returns:**\n- actionValue: The value of the button or menu option that was clicked\n- actionType: The type of interaction (button, menu, etc.)\n- userId: The ID of the user who interacted\n\n**Use Cases:**\n- Wait for user confirmation before proceeding\n- Get user selection from a menu\n- Handle multi-step card workflows\n\n**Note:** This tool will timeout after the specified duration (default: 5 minutes).',
    parameters: z.object({
      messageId: z.string().describe('The message ID of the card to wait for'),
      chatId: z.string().describe('Feishu chat ID where the card was sent'),
      timeoutSeconds: z.number().optional().describe('Maximum time to wait in seconds (default: 300 = 5 minutes)'),
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
  {
    name: 'leave_message',
    description: `Leave a non-blocking message for the user.

Unlike ask_user, this tool does NOT wait for a response. The message is sent and the tool returns immediately.

**Key Features:**
- Non-blocking: Returns immediately after sending
- Callback support: Can trigger actions when user replies
- Context tracking: Stores context for later reference

**Use Cases:**
- Leaving reminders or status updates
- Asking questions that don't need immediate answers
- Starting async discussions (like daily review feedback)
- Notifying about completed background tasks

**Callback Actions:**
- "create_task": Create a Task.md when user replies
- "trigger_skill": Run a skill when user replies
- "record_knowledge": Save the response to knowledge base

**Example:**
\`\`\`json
{
  "message": "今日分析发现一个问题需要讨论...",
  "chatId": "oc_xxx",
  "context": "分析 #123 时发现...",
  "callbackAction": "create_task"
}
\`\`\`

The user can reply at any time, and the callback will be triggered.}`,
    parameters: z.object({
      message: z.string().describe('The message content to leave for the user'),
      chatId: z.string().describe('Feishu chat ID to send the message to'),
      context: z.string().optional().describe('Optional context information for the message'),
      callbackAction: z.enum(['create_task', 'trigger_skill', 'record_knowledge']).optional().describe('Action to trigger when user replies (default: create_task)'),
      callbackParams: z.object({}).passthrough().optional().describe('Optional parameters for the callback action'),
    }),
    handler: async ({ message, chatId, context, callbackAction, callbackParams }) => {
      try {
        const result = await leave_message({ message, chatId, context, callbackAction, callbackParams });
        if (result.success) {
          return toolSuccess(`${result.message}\nMessage ID: ${result.messageId}`);
        } else {
          return toolSuccess(`⚠️ ${result.message}`);
        }
      } catch (error) {
        return toolSuccess(`⚠️ Leave message failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
];

/**
 * SDK-compatible tools array.
 *
 * @deprecated Use feishuToolDefinitions with getProvider().createMcpServer() instead.
 */
export const feishuSdkTools = feishuToolDefinitions.map(def => getProvider().createInlineTool(def));

/**
 * SDK MCP Server factory for Feishu context tools.
 *
 * **Lifecycle:**
 * - Each call creates a new MCP server instance with its own Protocol
 * - This prevents transport conflicts when multiple Agent instances are active
 * - SDK automatically cleans up these instances when queries complete
 *
 * **Usage:**
 * Call this factory when creating queries:
 * ```typescript
 * query({
 *   prompt: "...",
 *   options: {
 *     mcpServers: {
 *       'feishu-context': createFeishuSdkMcpServer(),
 *     },
 *   },
 * })
 * ```
 *
 * Creates an in-process MCP server that provides Feishu integration tools
 * to the Agent SDK.
 */
export function createFeishuSdkMcpServer() {
  return getProvider().createMcpServer({
    type: 'inline',
    name: 'feishu-context',
    version: '1.0.0',
    tools: feishuToolDefinitions,
  });
}
