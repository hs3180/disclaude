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
  RegisterTempChatResult,
  AddChatMembersResult,
  RemoveChatMembersResult,
  GetChatMembersResult,
  ListChatsResult,
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

// Temp chat lifecycle management (Issue #1703)
export { register_temp_chat } from './register-temp-chat.js';

// Group member management (Issue #1678)
export { add_chat_members } from './add-chat-members.js';
export { remove_chat_members } from './remove-chat-members.js';
export { get_chat_members } from './get-chat-members.js';
export { list_chats } from './list-chats.js';

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
