/** Shared channel messaging implementations used by the channel CLI. */

// Types
export type {
  SendMessageResult,
  SendFileResult,
  MessageSentCallback,
  ActionPromptMap,
  SendInteractiveResult,
} from './types.js';

// Shared utilities
export { isIpcAvailable, getIpcErrorMessage, buildIpcFallbackHint } from './ipc-utils.js';
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

// Push to Agent (Issue #631)
export { push_to_agent } from './push-to-agent.js';

// Interactive Message
// Issue #4280 (part 4): the former UnixSocketIpcServer lifecycle
// exports (startIpcServer/stopIpcServer/isIpcServerRunning/
// getIpcServerSocketPath/registerFeishuHandlers/unregisterFeishuHandlers)
// are removed — dead code since part 3 made every tool a REST client.
export {
  send_interactive_message,
  send_interactive,
} from './interactive-message.js';
