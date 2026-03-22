/**
 * PilotCallbacks Factory - Creates callback objects for ChatAgent instances.
 *
 * This module provides a factory function to create PilotCallbacks objects,
 * reducing code duplication across WorkerNode message handling.
 *
 * @see Issue #1396 - Extract duplicate PilotCallbacks implementations
 */

import WebSocket from 'ws';
import type { Logger } from 'pino';
import type { PilotCallbacks, FeedbackMessage } from '../../types.js';
import type { FileClient } from '../../file-client/index.js';

/**
 * Feedback context for execution.
 */
export interface FeedbackContext {
  sendFeedback: (feedback: FeedbackMessage) => void;
  threadId?: string;
}

/**
 * Options for creating PilotCallbacks.
 */
export interface CreatePilotCallbacksOptions {
  /** Map of active feedback channels (chatId -> FeedbackContext) */
  feedbackChannels: Map<string, FeedbackContext>;
  /** WebSocket connection to Primary Node (for fallback) */
  ws: WebSocket | undefined;
  /** File client for uploading files */
  fileClient: FileClient;
  /** Logger instance */
  logger: Logger;
  /** Whether to include verbose logging (default: true for scheduler callbacks) */
  verboseLogging?: boolean;
}

/**
 * Create a PilotCallbacks object with unified implementation.
 *
 * This factory function creates a callbacks object that:
 * 1. First tries to send via active feedback channel (if exists for chatId)
 * 2. Falls back to direct WebSocket send if no feedback channel
 *
 * @param options - Configuration options
 * @returns PilotCallbacks object
 */
export function createPilotCallbacks(options: CreatePilotCallbacksOptions): PilotCallbacks {
  const { feedbackChannels, ws, fileClient, logger, verboseLogging = false } = options;

  const getContext = (chatId: string): FeedbackContext | undefined => {
    return feedbackChannels.get(chatId);
  };

  const sendMessage: PilotCallbacks['sendMessage'] = async (
    chatId: string,
    text: string,
    threadMessageId?: string
  ): Promise<void> => {
    const ctx = getContext(chatId);
    if (ctx) {
      ctx.sendFeedback({
        type: 'text',
        chatId,
        text,
        threadId: threadMessageId || ctx.threadId,
      });
    } else {
      // Issue #935: Fallback to direct WebSocket send when no active feedback channel
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'text', chatId, text, threadId: threadMessageId }));
        if (verboseLogging) {
          logger.debug({ chatId }, 'Message sent via WebSocket fallback');
        }
      } else {
        if (verboseLogging) {
          logger.warn({ chatId }, 'No active feedback channel and WebSocket not connected for sendMessage');
        }
      }
    }
  };

  const sendCard: PilotCallbacks['sendCard'] = async (
    chatId: string,
    card: Record<string, unknown>,
    description?: string,
    threadMessageId?: string
  ): Promise<void> => {
    const ctx = getContext(chatId);
    if (ctx) {
      ctx.sendFeedback({
        type: 'card',
        chatId,
        card,
        text: description,
        threadId: threadMessageId || ctx.threadId,
      });
    } else {
      // Issue #935: Fallback to direct WebSocket send when no active feedback channel
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'card', chatId, card, text: description, threadId: threadMessageId }));
        if (verboseLogging) {
          logger.debug({ chatId }, 'Card sent via WebSocket fallback');
        }
      } else {
        if (verboseLogging) {
          logger.warn({ chatId }, 'No active feedback channel and WebSocket not connected for sendCard');
        }
      }
    }
  };

  const sendFile: PilotCallbacks['sendFile'] = async (chatId: string, filePath: string): Promise<void> => {
    const ctx = getContext(chatId);

    try {
      // Upload file to Primary Node
      const fileRef = await fileClient.uploadFile(filePath, chatId);

      if (ctx) {
        // Send fileRef to Primary Node via active feedback channel
        ctx.sendFeedback({
          type: 'file',
          chatId,
          fileRef,
          fileName: fileRef.fileName,
          fileSize: fileRef.size,
          mimeType: fileRef.mimeType,
          threadId: ctx.threadId,
        });
      } else {
        // Issue #935: Fallback to direct WebSocket send when no active feedback channel
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'file',
              chatId,
              fileRef,
              fileName: fileRef.fileName,
              fileSize: fileRef.size,
              mimeType: fileRef.mimeType,
            })
          );
          if (verboseLogging) {
            logger.debug({ chatId }, 'File sent via WebSocket fallback');
          }
        } else {
          if (verboseLogging) {
            logger.warn({ chatId }, 'No active feedback channel and WebSocket not connected for sendFile');
          }
        }
      }
    } catch (error) {
      logger.error({ err: error, chatId, filePath }, 'Failed to upload file');
      if (ctx) {
        ctx.sendFeedback({
          type: 'error',
          chatId,
          error: `Failed to send file: ${(error as Error).message}`,
          threadId: ctx.threadId,
        });
      } else if (ws?.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'error',
            chatId,
            error: `Failed to send file: ${(error as Error).message}`,
          })
        );
      }
    }
  };

  const onDone: PilotCallbacks['onDone'] = async (chatId: string, threadMessageId?: string): Promise<void> => {
    const ctx = getContext(chatId);
    if (ctx) {
      ctx.sendFeedback({
        type: 'done',
        chatId,
        threadId: threadMessageId || ctx.threadId,
      });
      if (verboseLogging) {
        logger.info({ chatId }, 'Task completed, sent done signal');
      }
    } else {
      // Issue #935: Fallback to direct WebSocket send when no active feedback channel
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'done', chatId, threadId: threadMessageId }));
        if (verboseLogging) {
          logger.debug({ chatId }, 'Done signal sent via WebSocket fallback');
        }
      } else {
        if (verboseLogging) {
          logger.warn({ chatId }, 'No active feedback channel and WebSocket not connected for onDone');
        }
      }
    }
  };

  return {
    sendMessage,
    sendCard,
    sendFile,
    onDone,
  };
}
