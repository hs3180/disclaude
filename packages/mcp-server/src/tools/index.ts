/**
 * MCP tool implementations.
 *
 * @module mcp-server/tools
 */

// Types
export type {
  SendMessageResult,
  SendFileResult,
  MessageSentCallback,
  ActionPromptMap,
  SendInteractiveResult,
  CreateChatResult,
  DissolveChatResult,
  // Issue #1317: Temporary session types
  SessionStatus,
  SessionOption,
  TemporarySession,
  StartDiscussionResult,
  CheckDiscussionResult,
  ListDiscussionsResult,
} from './types.js';

// Shared utilities
export { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
export { getFeishuCredentials, getWorkspaceDir } from './credentials.js';
export {
  setMessageSentCallback,
  getMessageSentCallback,
  invokeMessageSentCallback,
} from './callback-manager.js';

// Send Text (focused tool)
export { send_text } from './send-message.js';

// Send Card (focused tool)
export { send_card } from './send-card.js';

// Send File
export { send_file } from './send-file.js';

// Group management (Issue #1546)
export { create_chat } from './create-chat.js';
export { dissolve_chat } from './dissolve-chat.js';

// Interactive Message
export {
  send_interactive_message,
  send_interactive,
  startIpcServer,
  stopIpcServer,
  isIpcServerRunning,
  getIpcServerSocketPath,
  registerFeishuHandlers,
  unregisterFeishuHandlers,
} from './interactive-message.js';

// Temporary session management (Issue #1317)
export {
  readSession,
  writeSession,
  updateSession,
  listSessions,
  deleteSession,
  generateSessionId,
  expireOverdueSessions,
} from './temporary-session.js';
export { start_discussion } from './start-discussion.js';
export { check_discussion } from './check-discussion.js';
export { list_discussions } from './list-discussions.js';
