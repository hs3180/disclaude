/** Typed Channel API helpers with consistent error classification. Each helper delegates to the HTTP client request method. */

import { createLogger } from '../utils/logger.js';
import type { FeishuCard } from '../types/platform.js';
import { ChannelApiRequestError, type ChannelApiFailureDetails } from './client.js';
import type {
  ChannelApiRequestType,
  ChannelApiRequestPayloads,
  ChannelApiResponsePayloads,
} from './protocol.js';

const logger = createLogger('ChannelApiClient');

/** Consistent error type returned by all facade methods. */
export type ChannelApiMethodErrorType = 'channel_api_unavailable' | 'channel_api_timeout' | 'channel_api_request_failed';

/** Base return type for facade methods. */
export type ChannelApiMethodResult = {
  success: boolean;
  error?: string;
  errorType?: ChannelApiMethodErrorType;
  /** Safe structured fields from the REST failure body (#5616); present when the server sent them. */
  failure?: ChannelApiFailureDetails;
};

/**
 * Classify an error into an REST API error type based on its message prefix.
 */
function classifyError(error: unknown): { err: Error; errorType: ChannelApiMethodErrorType; failure?: ChannelApiFailureDetails } {
  const err = error instanceof Error ? error : new Error(String(error));
  let errorType: ChannelApiMethodErrorType = 'channel_api_request_failed';
  if (err.message.startsWith('CHANNEL_API_NOT_AVAILABLE')) {
    errorType = 'channel_api_unavailable';
  } else if (err.message.startsWith('CHANNEL_API_TIMEOUT')) {
    errorType = 'channel_api_timeout';
  }
  // #5616: keep structured diagnostics from the failure body instead of flattening to a string.
  const failure = error instanceof ChannelApiRequestError ? error.failure : undefined;
  return { err, errorType, ...(failure ? { failure } : {}) };
}

/**
 * Client interface required by facade methods.
 * Implemented by ChannelApiClient; kept minimal to avoid circular dependencies.
 */
export interface ChannelApiClientLike {
  request<T extends ChannelApiRequestType>(
    type: T,
    payload: ChannelApiRequestPayloads[T],
    options?: { timeoutMs?: number }
  ): Promise<ChannelApiResponsePayloads[T]>;
}

/**
 * Send a text message via REST API.
 * Issue #1088: Return detailed error information for better troubleshooting.
 */
export async function sendMessage(
  client: ChannelApiClientLike,
  chatId: string,
  text: string,
  threadId?: string,
  mentions?: Array<{ openId: string; name?: string }>
): Promise<ChannelApiMethodResult & { messageId?: string }> {
  try {
    return await client.request('sendMessage', { chatId, text, threadId, mentions });
  } catch (error) {
    const { err, errorType, failure } = classifyError(error);
    logger.error({ err: error, chatId }, 'sendMessage failed');
    return { success: false, error: err.message, errorType, ...(failure ? { failure } : {}) };
  }
}

/**
 * Send a card message via REST API.
 * Issue #1088: Return detailed error information for better troubleshooting.
 */
export async function sendCard(
  client: ChannelApiClientLike,
  chatId: string,
  card: FeishuCard,
  threadId?: string,
  description?: string
): Promise<ChannelApiMethodResult & { messageId?: string }> {
  try {
    return await client.request('sendCard', { chatId, card, threadId, description });
  } catch (error) {
    const { err, errorType } = classifyError(error);
    logger.error({ err: error, chatId }, 'sendCard failed');
    return { success: false, error: err.message, errorType };
  }
}

/** Options for uploadFile (Issue #5630). */
export interface UploadFileOptions {
  /**
   * Deadline for the full upload + message-create chain. Defaults to the
   * chain-aware upload deadline (see `DEFAULT_UPLOAD_TIMEOUT_MS` in client.ts),
   * not the generic 30s REST default.
   */
  timeoutMs?: number;
  /**
   * Retry-dedup key: the service joins an in-flight same-key request and
   * replays a recent same-key success instead of re-sending. On an ambiguous
   * timeout, retry with the key this call reported.
   */
  idempotencyKey?: string;
}

/**
 * Upload a file via REST API.
 * Issue #2300: Return detailed error information consistent with other REST API methods.
 * Issue #5630: chain-aware deadline option, idempotency key pass-through, and
 * timeout results flagged `outcomeUnknown` — a timed-out upload is not a
 * confirmed failure (the service may still deliver), so retries must reuse the
 * idempotency key instead of blindly re-sending.
 */
export async function uploadFile(
  client: ChannelApiClientLike,
  chatId: string,
  filePath: string,
  threadId?: string,
  options?: UploadFileOptions
): Promise<ChannelApiMethodResult & {
  fileKey?: string;
  fileType?: string;
  fileName?: string;
  fileSize?: number;
  /** Platform message_id of the delivered file message (Issue #5630). */
  messageId?: string;
  /** Actual delivery position: 'thread-reply' (under the requested parent) or 'chat-root' (Issue #5722). */
  deliveryPosition?: 'thread-reply' | 'chat-root';
  /** Parent message id the file was replied under; present iff deliveryPosition === 'thread-reply' (Issue #5722). */
  threadId?: string;
  /** Thread root when known: for a chat-root send the delivered message itself is the root (Issue #5722). */
  rootId?: string;
  /** Present (true) when the attempt timed out with an unknown delivery outcome. */
  outcomeUnknown?: boolean;
  /** Echoed back on an ambiguous timeout so the caller can retry safely. */
  idempotencyKey?: string;
}> {
  try {
    return await client.request(
      'uploadFile',
      { chatId, filePath, threadId, idempotencyKey: options?.idempotencyKey },
      { timeoutMs: options?.timeoutMs },
    );
  } catch (error) {
    const { err, errorType } = classifyError(error);
    logger.error({ err: error, chatId, filePath }, 'uploadFile failed');
    if (errorType === 'channel_api_timeout') {
      // Issue #5630: the client deadline expired mid-chain — the service may
      // still complete the upload and deliver the file. Report the ambiguous
      // outcome (plus the dedup key) instead of a plain failure the caller
      // might blindly retry, which could double-deliver.
      return {
        success: false,
        error: err.message,
        errorType,
        outcomeUnknown: true,
        ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      };
    }
    return { success: false, error: err.message, errorType };
  }
}

/**
 * Upload an image for card embedding via REST API.
 * Issue #2951: Returns Feishu image_key for use in card img elements.
 */
export async function uploadImage(
  client: ChannelApiClientLike,
  filePath: string
): Promise<ChannelApiMethodResult & { imageKey?: string }> {
  try {
    return await client.request('uploadImage', { filePath });
  } catch (error) {
    const { err, errorType } = classifyError(error);
    logger.error({ err: error, filePath }, 'uploadImage failed');
    return { success: false, error: err.message, errorType };
  }
}

/**
 * Send an interactive card with raw parameters via REST API.
 * Issue #1570: Phase 1 of REST API refactor — disclaude service owns card building.
 */
export async function sendInteractive(
  client: ChannelApiClientLike,
  chatId: string,
  params: {
    question: string;
    options: Array<{ text: string; value: string; type?: 'primary' | 'default' | 'danger' }>;
    title?: string;
    context?: string;
    threadId?: string;
    threadRootId?: string;
    idempotencyKey?: string;
    actionPrompts?: Record<string, string>;
  }
): Promise<ChannelApiMethodResult & { messageId?: string }> {
  try {
    return await client.request('sendInteractive', { chatId, ...params });
  } catch (error) {
    const { err, errorType } = classifyError(error);
    logger.error({ err: error, chatId }, 'sendInteractive failed');
    return { success: false, error: err.message, errorType };
  }
}

/**
 * List all tracked temporary chats via REST API.
 * Issue #1703: Temp chat lifecycle management.
 */
export async function listTempChats(
  client: ChannelApiClientLike
): Promise<ChannelApiMethodResult & { chats?: Array<{ chatId: string; createdAt: string; expiresAt: string; creatorChatId?: string; responded: boolean }> }> {
  try {
    return await client.request('listTempChats', {});
  } catch (error) {
    const { err, errorType } = classifyError(error);
    logger.error({ err: error }, 'listTempChats failed');
    return { success: false, error: err.message, errorType };
  }
}

/**
 * Mark a temporary chat as responded by a user via REST API.
 * Issue #1703: Temp chat lifecycle management.
 */
export async function markChatResponded(
  client: ChannelApiClientLike,
  chatId: string,
  response: { selectedValue: string; responder: string; repliedAt: string }
): Promise<ChannelApiMethodResult> {
  try {
    return await client.request('markChatResponded', { chatId, response });
  } catch (error) {
    const { err, errorType } = classifyError(error);
    logger.error({ err: error, chatId }, 'markChatResponded failed');
    return { success: false, error: err.message, errorType };
  }
}

/**
 * Push an instruction to a chat agent via REST API.
 * Issue #631: Allows skills to push instructions to agents.
 */
export async function pushToAgent(
  client: ChannelApiClientLike,
  chatId: string,
  message: string,
  options?: { waitForCompletion?: boolean; timeoutMs?: number }
): Promise<ChannelApiMethodResult> {
  try {
    return await client.request('pushToAgent', { chatId, message, waitForCompletion: options?.waitForCompletion }, { timeoutMs: options?.timeoutMs });
  } catch (error) {
    const { err, errorType } = classifyError(error);
    logger.error({ err: error, chatId }, 'pushToAgent failed');
    return { success: false, error: err.message, errorType };
  }
}
