/**
 * IPC Protocol definitions for cross-process communication.
 *
 * Defines the channel-method request/response payload types shared by the
 * REST IPC client (`rest-ipc-client.ts`) and the protocol facade
 * (`ipc-client-facade.ts`). The Unix-socket wire format that also lived here
 * is gone with the transport (#4168 Phase 3); what remains is the
 * method/payload surface the REST routes mirror.
 *
 * @module core/ipc/protocol
 */

import type { FeishuCard } from '../types/platform.js';

/**
 * IPC request types.
 */
export type IpcRequestType =
  | 'ping'
  // Platform-agnostic messaging operations (Issue #1574: Phase 5 of IPC refactor)
  | 'sendMessage'
  | 'sendCard'
  | 'uploadFile'
  | 'uploadImage'
  // Raw-param interactive card (Issue #1570: Phase 1 of IPC refactor)
  | 'sendInteractive'
  // Temporary chat lifecycle management (Issue #1703)
  | 'listTempChats'
  | 'markChatResponded'
  // Push instruction to a chat agent (Issue #631)
  | 'pushToAgent';

/**
 * IPC request payloads.
 */
export interface IpcRequestPayloads {
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
 * IPC response payloads.
 */
export interface IpcResponsePayloads {
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
