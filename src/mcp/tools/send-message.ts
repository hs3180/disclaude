/**
 * send_user_feedback tool implementation.
 *
 * This tool allows agents to send messages directly to Feishu chats.
 * Requires explicit format specification: 'text' or 'card'.
 */

import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { sendMessageToFeishu, createClient, notifyMessageSent } from '../utils/feishu-api.js';
import { isValidFeishuCard, getCardValidationError } from '../utils/card-validator.js';
import type { MessageSentCallback, SendUserFeedbackResult } from './types.js';

const logger = createLogger('SendMessage');

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
 * Get the current message sent callback.
 * Used by other modules that need to access the callback.
 */
export function getMessageSentCallback(): MessageSentCallback | null {
  return messageSentCallback;
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
}): Promise<SendUserFeedbackResult> {
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
      notifyMessageSent(messageSentCallback, chatId);

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
      notifyMessageSent(messageSentCallback, chatId);

      return {
        success: true,
        message: `✅ Feedback logged (Feishu not configured, format: ${format})`,
      };
    }

    // Create Lark client and send message
    const client = createClient(appId, appSecret);

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
    notifyMessageSent(messageSentCallback, chatId);

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
