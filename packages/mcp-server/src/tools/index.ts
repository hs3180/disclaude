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
  AddMembersResult,
  RemoveMembersResult,
  GetMembersResult,
  GetBotChatsResult,
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

// Group member management (Issue #1678)
export { add_members } from './add-members.js';
export { remove_members } from './remove-members.js';
export { get_members } from './get-members.js';
export { get_bot_chats } from './get-bot-chats.js';

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
