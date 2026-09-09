/** Channel API request and response payloads shared by the HTTP client and method helpers. */

import type { FeishuCard } from '../types/platform.js';

/**
 * REST API request types.
 */
export type ChannelApiRequestType =
  | 'ping'
  // Platform-agnostic messaging operations (Issue #1574: Phase 5 of REST API refactor)
  | 'sendMessage'
  | 'sendCard'
  | 'uploadFile'
  | 'uploadImage'
  // Raw-param interactive card (Issue #1570: Phase 1 of REST API refactor)
  | 'sendInteractive'
  // Temporary chat lifecycle management (Issue #1703)
  | 'listTempChats'
  | 'markChatResponded'
  // Push instruction to a chat agent (Issue #631)
  | 'pushToAgent';

/**
 * REST API request payloads.
 */
export interface ChannelApiRequestPayloads {
  ping: Record<string, never>;
  sendMessage: {
    chatId: string;
    text: string;
    threadId?: string;
    mentions?: Array<{ openId: string; name?: string }>;
  };
  sendCard: {
    chatId: string;
    card: FeishuCard;
    threadId?: string;
    description?: string;
  };
  uploadFile: {
    chatId: string;
    filePath: string;
    threadId?: string;
  };
  uploadImage: {
    filePath: string;
  };
  sendInteractive: {
    chatId: string;
    question: string;
    options: Array<{ text: string; value: string; type?: 'primary' | 'default' | 'danger' }>;
    title?: string;
    context?: string;
    threadId?: string;
    actionPrompts?: Record<string, string>;
  };
  listTempChats: Record<string, never>;
  markChatResponded: {
    chatId: string;
    response: { selectedValue: string; responder: string; repliedAt: string };
  };
  pushToAgent: {
    chatId: string;
    message: string;
    /** If true, the response waits for the agent turn to complete before returning. */
    waitForCompletion?: boolean;
  };
}

/**
 * REST API response payloads.
 */
export interface ChannelApiResponsePayloads {
  ping: { pong: boolean };
  sendMessage: { success: boolean };
  sendCard: { success: boolean };
  uploadFile: { success: boolean; fileKey: string; fileType: string; fileName: string; fileSize: number };
  uploadImage: { success: boolean; imageKey: string };
  sendInteractive: { success: boolean; messageId?: string };
  listTempChats: { success: boolean; chats: Array<{ chatId: string; createdAt: string; expiresAt: string; creatorChatId?: string; responded: boolean }> };
  markChatResponded: { success: boolean };
  pushToAgent: { success: boolean };
}
