/**
 * Interactive message tool implementation.
 *
 * This tool sends interactive cards with pre-defined prompt templates
 * that are automatically converted to user messages when interactions occur.
 *
 * Issue #1571 (Phase 2): MCP Server passes raw parameters (question, options)
 * via sendInteractive IPC. Primary Node owns the full card building lifecycle.
 * Issue #1572: Interactive context management has been moved to Primary Node's
 * InteractiveContextStore. MCP Server is now a pure forwarding client.
 *
 * @module mcp-server/tools/interactive-message
 */

import {
  createLogger,
  getIpcClient,
  UnixSocketIpcServer,
  createInteractiveMessageHandler,
  type FeishuApiHandlers,
  type FeishuHandlersContainer,
  type InteractiveMessageHandlers,
} from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import { getMessageSentCallback } from './callback-manager.js';
import type { SendInteractiveResult, ActionPromptMap } from './types.js';

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
  options: Array<{
    text: string;
    value: string;
    type?: 'primary' | 'default' | 'danger';
  }>;
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
        message: '❌ IPC 服务不可用。请检查 Primary Node 服务是否正在运行。',
      };
    }

    // Issue #1571: Forward raw params via sendInteractive IPC.
    // Primary Node builds the card, sends it, and registers action prompts.
    logger.debug({ chatId, parentMessageId }, 'Forwarding raw params via sendInteractive IPC');
    const ipcClient = getIpcClient();
    const result = await ipcClient.sendInteractive(chatId, {
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
// IPC Server for Cross-Process Communication
// ============================================================================

let ipcServer: UnixSocketIpcServer | null = null;

/**
 * Issue #1120: Mutable container for Feishu API handlers.
 * Allows dynamic registration of handlers after IPC server starts.
 */
const feishuHandlersContainer: FeishuHandlersContainer = {
  handlers: undefined,
};

/**
 * Register Feishu API handlers for IPC-based operations.
 * Issue #1120: Allows FeishuChannel to register handlers after IPC server starts.
 *
 * @param handlers - The Feishu API handlers to register.
 */
export function registerFeishuHandlers(handlers: FeishuApiHandlers): void {
  feishuHandlersContainer.handlers = handlers;
  logger.info('Feishu API handlers registered for IPC server');
}

/**
 * Unregister Feishu API handlers.
 * Issue #1120: Cleanup function for when FeishuChannel stops.
 */
export function unregisterFeishuHandlers(): void {
  feishuHandlersContainer.handlers = undefined;
  logger.debug('Feishu API handlers unregistered from IPC server');
}

/**
 * Start the IPC server for cross-process communication.
 *
 * IMPORTANT: This function should only be called by Primary/Worker Node,
 * NOT by MCP Server child processes. MCP Server processes should connect
 * as clients using getIpcClient().
 *
 * Issue #1572: Interactive context handlers are now no-op stubs since
 * context management has moved to Primary Node's InteractiveContextStore.
 * The IPC server is only used for Feishu API operations (send, card, file).
 *
 * @param feishuHandlers - Optional handlers for Feishu API operations.
 *                         When provided, IPC clients can send messages/cards
 *                         through the Primary Node's LarkClientService.
 */
export async function startIpcServer(feishuHandlers?: FeishuApiHandlers): Promise<void> {
  if (ipcServer) {
    logger.debug('IPC server already running');
    // Issue #1120: Still try to register handlers if provided
    if (feishuHandlers) {
      registerFeishuHandlers(feishuHandlers);
    }
    return;
  }

  // Issue #1120: Register initial handlers if provided
  if (feishuHandlers) {
    feishuHandlersContainer.handlers = feishuHandlers;
  }

  // Issue #1572: Use no-op stubs for interactive context handlers.
  // Interactive context management has moved to Primary Node's InteractiveContextStore.
  // These stubs exist for backward compatibility but do nothing.
  const stubHandlers: InteractiveMessageHandlers = {
    getActionPrompts: () => undefined,
    registerActionPrompts: () => {},
    unregisterActionPrompts: () => false,
    generateInteractionPrompt: (_messageId: string, _chatId: string) => undefined,
    cleanupExpiredContexts: () => 0,
  };

  const handler = createInteractiveMessageHandler(
    stubHandlers,
    feishuHandlersContainer
  );

  ipcServer = new UnixSocketIpcServer(handler);

  try {
    await ipcServer.start();
    logger.info({ path: ipcServer.getSocketPath() }, 'IPC server started for cross-process communication');
  } catch (error) {
    logger.error({ err: error }, 'Failed to start IPC server');
    ipcServer = null;
    throw error;
  }
}

/**
 * Stop the IPC server.
 */
export async function stopIpcServer(): Promise<void> {
  if (ipcServer) {
    await ipcServer.stop();
    ipcServer = null;
    logger.info('IPC server stopped');
  }
}

/**
 * Check if the IPC server is running.
 */
export function isIpcServerRunning(): boolean {
  return ipcServer?.isRunning() ?? false;
}

/**
 * Get the IPC server socket path.
 */
export function getIpcServerSocketPath(): string | null {
  return ipcServer?.getSocketPath() ?? null;
}

/**
 * Alias for send_interactive_message for consistency with other tool names.
 * Sends an interactive card with clickable buttons to a Feishu chat.
 */
export const send_interactive = send_interactive_message;
