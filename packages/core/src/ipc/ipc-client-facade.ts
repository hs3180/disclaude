/**
 * IPC Client Facade — high-level protocol convenience methods.
 *
 * Issue #4129: Extracted from UnixSocketIpcClient to separate
 * connection management from protocol-level convenience methods.
 *
 * Each method takes a client instance and delegates to the low-level
 * `request()` method, adding consistent error classification.
 *
 * @module ipc/ipc-client-facade
 */

import { createLogger } from '../utils/logger.js';
import type { FeishuCard } from '../types/platform.js';
import type {
  IpcRequestType,
  IpcRequestPayloads,
  IpcResponsePayloads,
} from './protocol.js';

const logger = createLogger('IpcClientFacade');

/** Consistent error type returned by all facade methods. */
export type IpcMethodErrorType = 'ipc_unavailable' | 'ipc_timeout' | 'ipc_request_failed';

/** Base return type for facade methods. */
export type IpcMethodResult = {
  success: boolean;
  error?: string;
  errorType?: IpcMethodErrorType;
};

/**
 * Classify an error into an IPC error type based on its message prefix.
 */
function classifyError(error: unknown): { err: Error; errorType: IpcMethodErrorType } {
  const err = error instanceof Error ? error : new Error(String(error));
  let errorType: IpcMethodErrorType = 'ipc_request_failed';
  if (err.message.startsWith('IPC_NOT_AVAILABLE')) {
    errorType = 'ipc_unavailable';
  } else if (err.message.startsWith('IPC_TIMEOUT')) {
    errorType = 'ipc_timeout';
  }
  return { err, errorType };
}

/**
 * Client interface required by facade methods.
 * Implemented by UnixSocketIpcClient — kept minimal to avoid circular deps.
 */
export interface IpcClientLike {
  request<T extends IpcRequestType>(
    type: T,
    payload: IpcRequestPayloads[T],
    options?: { timeoutMs?: number }
  ): Promise<IpcResponsePayloads[T]>;
}

/**
 * Send a text message via IPC.
 * Issue #1088: Return detailed error information for better troubleshooting.
 */
export async function sendMessage(
  client: IpcClientLike,
  chatId: string,
  text: string,
  threadId?: string,
  mentions?: Array<{ openId: string; name?: string }>
): Promise<IpcMethodResult & { messageId?: string }> {
  try {
    return await client.request('sendMessage', { chatId, text, threadId, mentions });
  } catch (error) {
    const { err, errorType } = classifyError(error);
    logger.error({ err: error, chatId }, 'sendMessage failed');
    return { success: false, error: err.message, errorType };
  }
}

/**
 * Send a card message via IPC.
 * Issue #1088: Return detailed error information for better troubleshooting.
 */
export async function sendCard(
  client: IpcClientLike,
  chatId: string,
  card: FeishuCard,
  threadId?: string,
  description?: string
): Promise<IpcMethodResult & { messageId?: string }> {
  try {
    return await client.request('sendCard', { chatId, card, threadId, description });
  } catch (error) {
    const { err, errorType } = classifyError(error);
    logger.error({ err: error, chatId }, 'sendCard failed');
    return { success: false, error: err.message, errorType };
  }
}

/**
 * Upload a file via IPC.
 * Issue #2300: Return detailed error information consistent with other IPC methods.
 */
export async function uploadFile(
  client: IpcClientLike,
  chatId: string,
  filePath: string,
  threadId?: string
): Promise<IpcMethodResult & { fileKey?: string; fileType?: string; fileName?: string; fileSize?: number }> {
  try {
    return await client.request('uploadFile', { chatId, filePath, threadId });
  } catch (error) {
    const { err, errorType } = classifyError(error);
    logger.error({ err: error, chatId, filePath }, 'uploadFile failed');
    return { success: false, error: err.message, errorType };
  }
}

/**
 * Upload an image for card embedding via IPC.
 * Issue #2951: Returns Feishu image_key for use in card img elements.
 */
export async function uploadImage(
  client: IpcClientLike,
  filePath: string
): Promise<IpcMethodResult & { imageKey?: string }> {
  try {
    return await client.request('uploadImage', { filePath });
  } catch (error) {
    const { err, errorType } = classifyError(error);
    logger.error({ err: error, filePath }, 'uploadImage failed');
    return { success: false, error: err.message, errorType };
  }
}

/**
 * Send an interactive card with raw parameters via IPC.
 * Issue #1570: Phase 1 of IPC refactor — Primary Node owns card building.
 */
export async function sendInteractive(
  client: IpcClientLike,
  chatId: string,
  params: {
    question: string;
    options: Array<{ text: string; value: string; type?: 'primary' | 'default' | 'danger' }>;
    title?: string;
    context?: string;
    threadId?: string;
    actionPrompts?: Record<string, string>;
  }
): Promise<IpcMethodResult & { messageId?: string }> {
  try {
    return await client.request('sendInteractive', { chatId, ...params });
  } catch (error) {
    const { err, errorType } = classifyError(error);
    logger.error({ err: error, chatId }, 'sendInteractive failed');
    return { success: false, error: err.message, errorType };
  }
}

/**
 * List all tracked temporary chats via IPC.
 * Issue #1703: Temp chat lifecycle management.
 */
export async function listTempChats(
  client: IpcClientLike
): Promise<IpcMethodResult & { chats?: Array<{ chatId: string; createdAt: string; expiresAt: string; creatorChatId?: string; responded: boolean }> }> {
  try {
    return await client.request('listTempChats', {});
  } catch (error) {
    const { err, errorType } = classifyError(error);
    logger.error({ err: error }, 'listTempChats failed');
    return { success: false, error: err.message, errorType };
  }
}

/**
 * Mark a temporary chat as responded by a user via IPC.
 * Issue #1703: Temp chat lifecycle management.
 */
export async function markChatResponded(
  client: IpcClientLike,
  chatId: string,
  response: { selectedValue: string; responder: string; repliedAt: string }
): Promise<IpcMethodResult> {
  try {
    return await client.request('markChatResponded', { chatId, response });
  } catch (error) {
    const { err, errorType } = classifyError(error);
    logger.error({ err: error, chatId }, 'markChatResponded failed');
    return { success: false, error: err.message, errorType };
  }
}

/**
 * Push an instruction to a chat agent via IPC.
 * Issue #631: Allows skills to push instructions to agents.
 */
export async function pushToAgent(
  client: IpcClientLike,
  chatId: string,
  message: string,
  options?: { waitForCompletion?: boolean; timeoutMs?: number }
): Promise<IpcMethodResult> {
  try {
    return await client.request('pushToAgent', { chatId, message, waitForCompletion: options?.waitForCompletion }, { timeoutMs: options?.timeoutMs });
  } catch (error) {
    const { err, errorType } = classifyError(error);
    logger.error({ err: error, chatId }, 'pushToAgent failed');
    return { success: false, error: err.message, errorType };
  }
}
