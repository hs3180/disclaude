/**
 * PilotCallbacks - Factory for creating pilot agent callbacks.
 *
 * This module provides a factory function to create PilotCallbacks instances
 * used by ChatAgent to send messages back to the communication channel.
 *
 * Issue #1396: Extract duplicate PilotCallbacks implementations.
 *
 * @module agents/pilot-callbacks
 */

import type { Logger } from 'pino';
import type { FeedbackMessage, FileRef } from '../types/index.js';

/**
 * FeedbackContext - Context for sending feedback to the communication channel.
 */
export interface FeedbackContext {
  /** Send feedback message */
  sendFeedback: (feedback: FeedbackMessage) => void;
  /** Thread ID for thread replies */
  threadId?: string;
}

/**
 * FileClientInterface - Interface for file upload client.
 */
export interface FileClientInterface {
  /** Upload a file and return the file reference */
  uploadFile(filePath: string, chatId: string): Promise<FileRef>;
}

/**
 * WebSocketLike - Minimal WebSocket interface for PilotCallbacks.
 */
export interface WebSocketLike {
  /** WebSocket ready state */
  readyState: number;
  /** OPEN state constant */
  OPEN: number;
  /** Send data */
  send(data: string): void;
}

/**
 * PilotCallbacks - Callbacks for ChatAgent to send messages.
 *
 * Used when creating ChatAgent instances.
 */
export interface PilotCallbacks {
  /** Send a text message */
  sendMessage: (chatId: string, text: string, parentMessageId?: string) => Promise<void>;
  /** Send an interactive card */
  sendCard: (chatId: string, card: Record<string, unknown>, description?: string, parentMessageId?: string) => Promise<void>;
  /** Send a file */
  sendFile: (chatId: string, filePath: string) => Promise<void>;
  /** Called when query completes */
  onDone?: (chatId: string, parentMessageId?: string) => Promise<void>;
}

/**
 * Options for creating PilotCallbacks.
 */
export interface CreatePilotCallbacksOptions {
  /** Logger instance */
  logger: Logger;
  /** Active feedback channels map */
  feedbackChannels: Map<string, FeedbackContext>;
  /** WebSocket connection (optional, for fallback) */
  ws?: WebSocketLike;
  /** File client for uploading files */
  fileClient: FileClientInterface;
}

/**
 * Create a PilotCallbacks instance.
 *
 * This factory function creates a callbacks object that can be used
 * by ChatAgent instances to send messages back to the communication channel.
 *
 * @param options - Options for creating callbacks
 * @returns PilotCallbacks instance
 *
 * @example
 * ```typescript
 * const callbacks = createPilotCallbacks({
 *   logger,
 *   feedbackChannels: this.activeFeedbackChannels,
 *   ws: this.ws,
 *   fileClient: this.fileClient,
 * });
 *
 * const agent = createChatAgent(chatId, callbacks);
 * ```
 */
export function createPilotCallbacks(options: CreatePilotCallbacksOptions): PilotCallbacks {
  const { logger, feedbackChannels, ws, fileClient } = options;

  /**
   * Get feedback context for a chatId.
   */
  const getCtx = (chatId: string): FeedbackContext | undefined => feedbackChannels.get(chatId);

  /**
   * Check if WebSocket is connected.
   */
  const isWsConnected = (): boolean => ws?.readyState === ws?.OPEN;

  /**
   * Send via WebSocket fallback.
   */
  const sendViaWs = (data: object): void => {
    if (isWsConnected()) {
      ws!.send(JSON.stringify(data));
    }
  };

  return {
    sendMessage: async (chatId: string, text: string, threadMessageId?: string): Promise<void> => {
      const ctx = getCtx(chatId);
      if (ctx) {
        ctx.sendFeedback({ type: 'text', chatId, text, threadId: threadMessageId || ctx.threadId });
      } else {
        // Issue #935: Fallback to direct WebSocket send when no active feedback channel
        if (isWsConnected()) {
          sendViaWs({ type: 'text', chatId, text, threadId: threadMessageId });
          logger.debug({ chatId }, 'Message sent via WebSocket fallback');
        } else {
          logger.warn({ chatId }, 'No active feedback channel and WebSocket not connected for sendMessage');
        }
      }
    },

    sendCard: async (chatId: string, card: Record<string, unknown>, description?: string, threadMessageId?: string): Promise<void> => {
      const ctx = getCtx(chatId);
      if (ctx) {
        ctx.sendFeedback({ type: 'card', chatId, card, text: description, threadId: threadMessageId || ctx.threadId });
      } else {
        // Issue #935: Fallback to direct WebSocket send when no active feedback channel
        if (isWsConnected()) {
          sendViaWs({ type: 'card', chatId, card, text: description, threadId: threadMessageId });
          logger.debug({ chatId }, 'Card sent via WebSocket fallback');
        } else {
          logger.warn({ chatId }, 'No active feedback channel and WebSocket not connected for sendCard');
        }
      }
    },

    sendFile: async (chatId: string, filePath: string): Promise<void> => {
      const ctx = getCtx(chatId);

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
          if (isWsConnected()) {
            sendViaWs({
              type: 'file',
              chatId,
              fileRef,
              fileName: fileRef.fileName,
              fileSize: fileRef.size,
              mimeType: fileRef.mimeType,
            });
            logger.debug({ chatId }, 'File sent via WebSocket fallback');
          } else {
            logger.warn({ chatId }, 'No active feedback channel and WebSocket not connected for sendFile');
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
        } else if (isWsConnected()) {
          sendViaWs({
            type: 'error',
            chatId,
            error: `Failed to send file: ${(error as Error).message}`,
          });
        }
      }
    },

    onDone: async (chatId: string, threadMessageId?: string): Promise<void> => {
      const ctx = getCtx(chatId);
      if (ctx) {
        ctx.sendFeedback({ type: 'done', chatId, threadId: threadMessageId || ctx.threadId });
        logger.info({ chatId }, 'Task completed, sent done signal');
      } else {
        // Issue #935: Fallback to direct WebSocket send when no active feedback channel
        if (isWsConnected()) {
          sendViaWs({ type: 'done', chatId, threadId: threadMessageId });
          logger.debug({ chatId }, 'Done signal sent via WebSocket fallback');
        } else {
          logger.warn({ chatId }, 'No active feedback channel and WebSocket not connected for onDone');
        }
      }
    },
  };
}
