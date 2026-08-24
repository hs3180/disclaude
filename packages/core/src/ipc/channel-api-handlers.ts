/**
 * Channel API handler contracts.
 *
 * Issue #4168 (Phase 3 residual): these interfaces originally lived in
 * `unix-socket-server.ts`, where they described the handlers the IPC server
 * dispatched to. The Unix-socket transport is gone (REST is the only channel
 * between the MCP server / push-cli and PrimaryNode), but the contracts
 * survive: the REST-facing methods (`resolveApiHandlers` on PrimaryNode) and
 * the channel registration surface (`registerChannelHandlers`) route through
 * exactly these shapes. Extracted here so the dead transport files could be
 * deleted without touching the live handler surface.
 *
 * @module ipc/channel-api-handlers
 */

import type { FeishuCard } from '../types/platform.js';

/**
 * Platform-agnostic Channel API handlers interface (Issue #1546).
 *
 * Defines the common operations that all channel implementations must support.
 * Platform-specific implementations (Feishu, Slack, etc.) extend this interface.
 */
export interface ChannelApiHandlers {
  sendMessage: (chatId: string, text: string, threadId?: string, mentions?: Array<{ openId: string; name?: string }>) => Promise<void>;
  sendCard: (
    chatId: string,
    card: FeishuCard,
    threadId?: string,
    description?: string
  ) => Promise<void>;
  uploadFile: (
    chatId: string,
    filePath: string,
    threadId?: string
  ) => Promise<{ fileKey: string; fileType: string; fileName: string; fileSize: number }>;
  /** Issue #2951: Upload image and return Feishu image_key for card embedding */
  uploadImage?: (
    filePath: string
  ) => Promise<{ imageKey: string }>;
  sendInteractive: (
    chatId: string,
    params: {
      question: string;
      options: Array<{ text: string; value: string; type?: 'primary' | 'default' | 'danger' }>;
      title?: string;
      context?: string;
      threadId?: string;
      actionPrompts?: Record<string, string>;
    }
  ) => Promise<{ messageId?: string }>;
  /** List all tracked temp chats (Issue #1703) */
  listTempChats?: () => Promise<Array<{ chatId: string; createdAt: string; expiresAt: string; creatorChatId?: string; responded: boolean }>>;
  /** Mark a temp chat as responded (Issue #1703) */
  markChatResponded?: (chatId: string, response: { selectedValue: string; responder: string; repliedAt: string }) => Promise<{ success: boolean }>;
  /** Push instruction to a chat agent (Issue #631) */
  pushToAgent?: (chatId: string, message: string, options?: { waitForCompletion?: boolean }) => Promise<{ success: boolean }>;
}

/**
 * Handler functions for Feishu API operations (Issue #1035).
 * Extends ChannelApiHandlers with Feishu-specific methods.
 *
 * @deprecated Use ChannelApiHandlers directly for new code.
 * FeishuApiHandlers is kept for backward compatibility but currently
 * adds no Feishu-specific methods. It will be removed in a future version.
 */
export interface FeishuApiHandlers extends ChannelApiHandlers {
  // Feishu-specific methods can be added here in the future.
  // getBotInfo is intentionally NOT included — it's dead code
  // (handled by platform SDK layer independently).
}

/**
 * Mutable container for channel API handlers.
 * Issue #1120: Allows dynamic registration of handlers after the channel starts.
 * Issue #1546: Renamed from FeishuHandlersContainer to use platform-agnostic naming.
 */
export interface ChannelHandlersContainer {
  handlers: ChannelApiHandlers | undefined;
}

/**
 * @deprecated Use ChannelHandlersContainer instead.
 */
export type FeishuHandlersContainer = ChannelHandlersContainer;
