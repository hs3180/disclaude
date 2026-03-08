/**
 * Interactive message tool implementation.
 *
 * This tool sends interactive cards with pre-defined prompt templates
 * that are automatically converted to user messages when interactions occur.
 *
 * @module mcp/tools/interactive-message
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { existsSync } from 'fs';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { createFeishuClient } from '../../platforms/feishu/create-feishu-client.js';
import { sendMessageToFeishu } from '../utils/feishu-api.js';
import { isValidFeishuCard, getCardValidationError } from '../utils/card-validator.js';
import { getMessageSentCallback } from './send-message.js';
import {
  UnixSocketIpcServer,
  createInteractiveMessageHandler,
  type FeishuApiHandlers,
  type FeishuHandlersContainer,
} from '../../ipc/unix-socket-server.js';
import { getIpcClient } from '../../ipc/unix-socket-client.js';
import { DEFAULT_IPC_CONFIG } from '../../ipc/protocol.js';
import type { SendInteractiveResult, ActionPromptMap, InteractiveMessageContext } from './types.js';
import {
  getOfflineContext,
  generateFollowUpPrompt,
  unregisterOfflineContext,
} from './leave-message.js';

const logger = createLogger('InteractiveMessage');

/**
 * Check if IPC is available for Feishu API calls.
 * Issue #1035: Prefer IPC when available for unified client management.
 */
function isIpcAvailable(): boolean {
  return existsSync(DEFAULT_IPC_CONFIG.socketPath);
}

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
 * Generate user-friendly error message based on IPC error type.
 * Issue #1088: Provide actionable error messages.
 */
function getIpcErrorMessage(errorType?: string, originalError?: string): string {
  switch (errorType) {
    case 'ipc_unavailable':
      return '❌ IPC 服务不可用。请检查 Primary Node 服务是否正在运行。';
    case 'ipc_timeout':
      return '❌ IPC 请求超时。服务可能过载，请稍后重试。';
    case 'ipc_request_failed':
      return `❌ IPC 请求失败: ${originalError ?? '未知错误'}`;
    default:
      return `❌ 交互消息发送失败: ${originalError ?? '未知错误'}`;
  }
}

/**
 * Store for interactive message contexts.
 * Maps message ID to its action prompts.
 */
const interactiveContexts = new Map<string, InteractiveMessageContext>();

/**
 * Register action prompts for a message.
 * Called after successfully sending an interactive message.
 */
export function registerActionPrompts(
  messageId: string,
  chatId: string,
  actionPrompts: ActionPromptMap
): void {
  interactiveContexts.set(messageId, {
    messageId,
    chatId,
    actionPrompts,
    createdAt: Date.now(),
  });
  logger.debug({ messageId, chatId, actions: Object.keys(actionPrompts) }, 'Action prompts registered');
}

/**
 * Get action prompts for a message.
 * Returns undefined if no prompts are registered.
 */
export function getActionPrompts(messageId: string): ActionPromptMap | undefined {
  const context = interactiveContexts.get(messageId);
  return context?.actionPrompts;
}

/**
 * Remove action prompts for a message.
 */
export function unregisterActionPrompts(messageId: string): boolean {
  const removed = interactiveContexts.delete(messageId);
  if (removed) {
    logger.debug({ messageId }, 'Action prompts unregistered');
  }
  return removed;
}

/**
 * Generate a prompt from an interaction using the registered template.
 *
 * @param messageId - The card message ID
 * @param actionValue - The action value from the button/menu
 * @param actionText - The display text of the action (optional)
 * @param actionType - The type of action (button, select_static, etc.)
 * @param formData - Form data if the action includes form inputs
 * @returns The generated prompt or undefined if no template found
 */
export function generateInteractionPrompt(
  messageId: string,
  actionValue: string,
  actionText?: string,
  actionType?: string,
  formData?: Record<string, unknown>
): string | undefined {
  const prompts = getActionPrompts(messageId);
  if (!prompts) {
    return undefined;
  }

  const template = prompts[actionValue];
  if (!template) {
    logger.debug(
      { messageId, actionValue, availableActions: Object.keys(prompts) },
      'No prompt template found for action'
    );
    return undefined;
  }

  // Replace placeholders in the template
  let prompt = template;

  // Replace {{actionText}} placeholder
  if (actionText) {
    prompt = prompt.replace(/\{\{actionText\}\}/g, actionText);
  }

  // Replace {{actionValue}} placeholder
  prompt = prompt.replace(/\{\{actionValue\}\}/g, actionValue);

  // Replace {{actionType}} placeholder
  if (actionType) {
    prompt = prompt.replace(/\{\{actionType\}\}/g, actionType);
  }

  // Replace form data placeholders
  if (formData) {
    for (const [key, value] of Object.entries(formData)) {
      const placeholder = new RegExp(`\\{\\{form\\.${key}\\}\\}`, 'g');
      prompt = prompt.replace(placeholder, String(value));
    }
  }

  return prompt;
}

/**
 * Cleanup expired interactive contexts (older than 24 hours).
 */
export function cleanupExpiredContexts(): number {
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  const now = Date.now();
  let cleaned = 0;

  for (const [messageId, context] of interactiveContexts) {
    if (now - context.createdAt > maxAge) {
      interactiveContexts.delete(messageId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    logger.debug({ count: cleaned }, 'Cleaned up expired interactive contexts');
  }

  return cleaned;
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
    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET in disclaude.config.yaml';
      logger.error({ chatId }, errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
    }

    // Issue #1035: Try IPC first if available
    const useIpc = isIpcAvailable();
    let messageId: string | undefined;

    if (useIpc) {
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
      ({ messageId } = result);
    } else {
      // Fallback: Create client directly
      const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });
      const result = await sendMessageToFeishu(client, chatId, 'interactive', JSON.stringify(card), parentMessageId);
      ({ messageId } = result);
    }

    // Register action prompts if message was sent successfully
    if (messageId) {
      registerActionPrompts(messageId, chatId, actionPrompts);
      logger.info(
        { messageId, chatId, actions: Object.keys(actionPrompts) },
        'Interactive message sent and prompts registered'
      );
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
 * This allows other processes (e.g., the main bot process) to query
 * the interactive contexts stored in this process.
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

  const handler = createInteractiveMessageHandler({
    getActionPrompts,
    registerActionPrompts,
    unregisterActionPrompts,
    generateInteractionPrompt,
    cleanupExpiredContexts,
    // Issue #631: 离线消息相关
    getOfflineContext: (messageId: string) => {
      const context = getOfflineContext(messageId);
      if (!context) return undefined;
      return {
        id: context.id,
        messageId: context.messageId,
        chatId: context.chatId,
        taskContext: context.taskContext,
        followUpPrompt: context.followUpPrompt,
      };
    },
    generateFollowUpPrompt: (
      messageId: string,
      actionValue: string,
      actionText?: string,
      formData?: Record<string, unknown>
    ) => {
      const context = getOfflineContext(messageId);
      if (!context) return undefined;
      return generateFollowUpPrompt(context, actionValue, actionText, formData);
    },
    unregisterOfflineContext,
  }, feishuHandlersContainer);

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
