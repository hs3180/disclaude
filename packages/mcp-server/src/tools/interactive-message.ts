/**
 * Interactive message tool implementation.
 *
 * This tool sends interactive cards with pre-defined prompt templates
 * that are automatically converted to user messages when interactions occur.
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
import { isValidFeishuCard, getCardValidationError } from '../utils/card-validator.js';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import { getFeishuCredentials } from './credentials.js';
import { getMessageSentCallback } from './callback-manager.js';
import type { SendInteractiveResult, ActionPromptMap } from './types.js';

const logger = createLogger('InteractiveMessage');

/**
 * Send card message via IPC to PrimaryNode's LarkClientService.
 * Issue #1035: Routes Feishu API calls through unified client.
 * Issue #1088: Improved error handling with detailed error information.
 */
async function sendCardViaIpc(
  chatId: string,
  card: Record<string, unknown>,
  threadId?: string,
  description?: string
): Promise<{ success: boolean; messageId?: string; error?: string; errorType?: string }> {
  const ipcClient = getIpcClient();
  return await ipcClient.feishuSendCard(chatId, card, threadId, description);
}

/**
 * Send an interactive message with pre-defined action prompts.
 *
 * When the user interacts with the card (clicks a button, selects from menu, etc.),
 * the corresponding prompt template will be used to generate a message that the
 * agent receives as if the user had typed it.
 *
 * @example
 * ```typescript
 * await send_interactive_message({
 *   card: {
 *     config: { wide_screen_mode: true },
 *     header: { title: { tag: "plain_text", content: "Confirm Action" } },
 *     elements: [
 *       {
 *         tag: "action",
 *         actions: [
 *           { tag: "button", text: { tag: "plain_text", content: "Confirm" }, value: "confirm" },
 *           { tag: "button", text: { tag: "plain_text", content: "Cancel" }, value: "cancel" }
 *         ]
 *       }
 *     ]
 *   },
 *   actionPrompts: {
 *     confirm: "[用户操作] 用户点击了「确认」按钮。请继续执行任务。",
 *     cancel: "[用户操作] 用户点击了「取消」按钮。任务已取消。"
 *   },
 *   chatId: "oc_xxx"
 * });
 * ```
 */
export async function send_interactive_message(params: {
  /** The interactive card JSON structure */
  card: Record<string, unknown>;
  /** Map of action values to prompt templates */
  actionPrompts: ActionPromptMap;
  /** Target chat ID */
  chatId: string;
  /** Optional parent message ID for thread reply */
  parentMessageId?: string;
}): Promise<SendInteractiveResult> {
  const { card, actionPrompts, chatId, parentMessageId } = params;

  logger.info({
    chatId,
    actionCount: Object.keys(actionPrompts).length,
    hasParent: !!parentMessageId,
  }, 'send_interactive_message called');

  try {
    // Validate required parameters
    if (!card) {
      throw new Error('card is required');
    }
    if (!actionPrompts || Object.keys(actionPrompts).length === 0) {
      throw new Error('actionPrompts is required and must have at least one action');
    }
    if (!chatId) {
      throw new Error('chatId is required');
    }

    // Validate card structure
    if (!isValidFeishuCard(card)) {
      return {
        success: false,
        error: `Invalid card structure: ${getCardValidationError(card)}`,
        message: `❌ Card validation failed. ${getCardValidationError(card)}`,
      };
    }

    // Get Feishu credentials
    const { appId, appSecret } = getFeishuCredentials();

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET in disclaude.config.yaml';
      logger.error({ chatId }, errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
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

    logger.debug({ chatId, parentMessageId }, 'Using IPC for interactive message');
    const result = await sendCardViaIpc(chatId, card, parentMessageId);
    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ chatId, errorType: result.errorType, error: result.error }, 'IPC interactive message failed');
      return {
        success: false,
        error: result.error ?? 'Failed to send interactive message via IPC',
        message: errorMsg,
      };
    }
    const { messageId } = result;

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
      message: `✅ Interactive message sent with ${Object.keys(actionPrompts).length} action(s)`,
      messageId,
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
 * This allows other processes (e.g., MCP Server child processes) to query
 * the interactive contexts stored in the Primary/Worker Node process.
 *
 * Issue #1116: Accept feishuHandlers to enable IPC-based Feishu API calls
 * in Primary Node standalone mode.
 * Issue #1120: Use FeishuHandlersContainer for dynamic handler registration.
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

  // No-op stubs for InteractiveMessageHandlers since standalone dispatch cases
  // have been removed (Issue #1573). The sendInteractive case still uses
  // registerActionPrompts internally, but only Primary Node's InteractiveContextStore
  // handles real registration. These stubs are never called in MCP Server.
  const noopHandlers: InteractiveMessageHandlers = {
    getActionPrompts: () => undefined,
    registerActionPrompts: () => {},
    unregisterActionPrompts: () => false,
    generateInteractionPrompt: () => undefined,
    cleanupExpiredContexts: () => 0,
  };

  const handler = createInteractiveMessageHandler(noopHandlers, feishuHandlersContainer);

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
