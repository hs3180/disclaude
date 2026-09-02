/**
 * Interactive message tool implementation.
 *
 * This tool sends interactive cards with pre-defined prompt templates
 * that are automatically converted to user messages when interactions occur.
 *
 * Issue #1571 (Phase 2): the channel client passes raw parameters (question, options)
 * via sendInteractive IPC. Primary Node owns the full card building lifecycle.
 * Issue #1572: Interactive context management has been moved to Primary Node's
 * InteractiveContextStore. The channel client is now a pure forwarding client.
 *
 * @module channel-cli/tools/interactive-message
 */

import {
  createLogger,
  sendInteractive,
} from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage, getRestIpcClient, buildIpcFallbackHint } from './ipc-utils.js';
import { getMessageSentCallback } from './callback-manager.js';
import type { SendInteractiveResult, ActionPromptMap, InteractiveOption } from './types.js';

const logger = createLogger('InteractiveMessage');

/**
 * Send an interactive message by forwarding raw parameters to Primary Node.
 *
 * Issue #1571: MCP Server no longer builds cards. It passes raw parameters
 * (question, options) via sendInteractive IPC. Primary Node builds the card,
 * sends it, and registers action prompts.
 *
 * Issue #1572: Action prompt management is handled by Primary Node's
 * InteractiveContextStore. MCP Server is a pure forwarding client.
 *
 * @example
 * ```typescript
 * await send_interactive_message({
 *   question: "Which option do you prefer?",
 *   options: [
 *     { text: "✅ Approve", value: "approve", type: "primary" },
 *     { text: "❌ Reject", value: "reject", type: "danger" },
 *   ],
 *   title: "Code Review",
 *   chatId: "oc_xxx"
 * });
 * ```
 */
export async function send_interactive_message(params: {
  /** The question or main content to display */
  question: string;
  /** Button options for user interaction */
  options: InteractiveOption[];
  /** Card title (optional) */
  title?: string;
  /** Optional context shown above the question */
  context?: string;
  /** Target chat ID */
  chatId: string;
  /** Optional parent message ID for thread reply */
  parentMessageId?: string;
  /** Optional custom action prompts (overrides auto-generated defaults) */
  actionPrompts?: ActionPromptMap;
}): Promise<SendInteractiveResult> {
  const { question, options, chatId, parentMessageId } = params;

  logger.info({
    chatId,
    optionCount: options?.length ?? 0,
    hasParent: !!parentMessageId,
  }, 'send_interactive_message called');

  try {
    // Validate required parameters
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return {
        success: false,
        error: 'question is required and must be a non-empty string',
        message: '❌ question 参数不能为空',
      };
    }
    if (!Array.isArray(options) || options.length === 0) {
      return {
        success: false,
        error: 'options is required and must be a non-empty array',
        message: '❌ options 参数必须为非空数组',
      };
    }
    if (!chatId || typeof chatId !== 'string') {
      return {
        success: false,
        error: 'chatId is required',
        message: '❌ chatId 参数不能为空',
      };
    }

    // Validate options structure
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      if (typeof opt.text !== 'string' || opt.text.trim().length === 0) {
        return {
          success: false,
          error: `options[${i}].text must be a non-empty string`,
          message: `❌ options[${i}].text 不能为空`,
        };
      }
      if (typeof opt.value !== 'string' || opt.value.trim().length === 0) {
        return {
          success: false,
          error: `options[${i}].value must be a non-empty string`,
          message: `❌ options[${i}].value 不能为空`,
        };
      }
      if (opt.type !== undefined && !['primary', 'default', 'danger'].includes(opt.type)) {
        return {
          success: false,
          error: `options[${i}].type must be one of: primary, default, danger`,
          message: `❌ options[${i}].type 必须为 primary, default, danger 之一`,
        };
      }
    }

    // Check IPC availability - IPC is required for sending messages (Issue #1355: async connection probe)
    if (!(await isIpcAvailable())) {
      const errorMsg = 'IPC service unavailable. Please ensure Primary Node is running.';
      logger.error({ chatId }, errorMsg);
      return {
        success: false,
        error: errorMsg,
        // Issue #4576: actionable fallback — +messages-send loses thread
        // attribution in topic groups; +messages-reply preserves it.
        message: `❌ IPC 服务不可用。请检查 Primary Node 服务是否正在运行。${buildIpcFallbackHint(parentMessageId)}`,
      };
    }

    // Issue #1571: Forward raw params via sendInteractive IPC.
    // Primary Node builds the card, sends it, and registers action prompts.
    logger.debug({ chatId, parentMessageId }, 'Forwarding raw params via sendInteractive IPC');
    // Issue #4280 (Phase 3, part 3): REST-only — direct RestIpcClient.
    const ipcClient = getRestIpcClient();
    const result = await sendInteractive(ipcClient, chatId, {
      question,
      options,
      title: params.title,
      context: params.context,
      threadId: parentMessageId,
      actionPrompts: params.actionPrompts,
    });

    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ chatId, errorType: result.errorType, error: result.error }, 'sendInteractive IPC failed');
      return {
        success: false,
        error: result.error ?? 'Failed to send interactive message via IPC',
        message: errorMsg,
      };
    }

    // Invoke message sent callback
    const callback = getMessageSentCallback();
    if (callback) {
      try {
        callback(chatId);
      } catch (error) {
        logger.error({ err: error }, 'Failed to invoke message sent callback');
      }
    }

    return {
      success: true,
      message: `✅ Interactive message sent with ${options.length} action(s)`,
    };

  } catch (error) {
    logger.error({ err: error, chatId }, 'send_interactive_message FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to send interactive message: ${errorMessage}` };
  }
}

// ============================================================================
// IPC Server for Cross-Process Communication — REMOVED (Issue #4280 part 4)
// ============================================================================
// The former package no longer hosted a UnixSocketIpcServer. It was the
// pre-#4280 sibling of PrimaryNode's own IPC server and had zero production
// callers once part 3 (#4547) moved every MCP tool to the REST client:
// PrimaryNode serves `/api/*` via HttpApiServer and registers channel
// handlers on its own instance (primary-node.ts startIpcServer), while MCP
// The channel CLI connects as a REST client
// via getRestIpcClient(). The startIpcServer/stopIpcServer/
// isIpcServerRunning/getIpcServerSocketPath/registerFeishuHandlers/
// unregisterFeishuHandlers exports were dead code and are gone.

/**
 * Alias for send_interactive_message for consistency with other tool names.
 * Sends an interactive card with clickable buttons to a Feishu chat.
 */
export const send_interactive = send_interactive_message;
