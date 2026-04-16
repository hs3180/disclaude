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
  RegisterTempChatResult,
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

// Temp chat lifecycle management (Issue #1703)
export { register_temp_chat } from './register-temp-chat.js';

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

// Survey/Poll tools (Issue #2191: Phase 1)
export {
  create_poll,
  record_poll_vote,
  get_poll_results,
  close_poll,
  list_polls,
} from './survey.js';
export type {
  PollEntry,
  PollOption,
  PollSummary,
  CreatePollResult,
  RecordVoteResult,
  GetPollResultsResult,
} from './survey.js';
