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

// macOS Screen Control (Issue #2216 Phase 1)
export {
  isMacOS,
  mac_screenshot,
  mac_click,
  mac_type_text,
  mac_press_key,
  mac_move_mouse,
  mac_get_window,
  mac_activate_app,
  mac_calibrate,
} from './mac-screen-control.js';
export type {
  ScreenshotResult,
  ClickResult,
  TypeTextResult,
  PressKeyResult,
  MoveMouseResult,
  WindowInfo,
  CalibrateResult,
  ActivateAppResult,
} from './mac-screen-control.js';
