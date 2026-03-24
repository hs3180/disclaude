/**
 * @disclaude/mcp-server
 *
 * MCP Server process for disclaude.
 *
 * This package contains:
 * - MCP tools (send_text, send_card, send_file, interactive messages, etc.)
 * - MCP tool types
 * - MCP utilities
 * - IPC client (for cross-process communication with Primary Node)
 * - MCP servers
 */

// Tool Types
export type {
  SendMessageResult,
  SendFileResult,
  MessageSentCallback,
  ActionPromptMap,
  InteractiveMessageContext,
  SendInteractiveResult,
} from './tools/types.js';

// Shared utilities
export {
  isIpcAvailable,
  getIpcErrorMessage,
  getFeishuCredentials,
  getWorkspaceDir,
  setMessageSentCallback,
  getMessageSentCallback,
  invokeMessageSentCallback,
} from './tools/index.js';

// Tools - Send Text
export { send_text } from './tools/send-message.js';

// Tools - Send Card
export { send_card } from './tools/send-card.js';

// Tools - Send File
export { send_file } from './tools/send-file.js';

// Tools - Interactive Message
export {
  send_interactive_message,
  send_interactive,
  registerActionPrompts,
  getActionPrompts,
  unregisterActionPrompts,
  generateInteractionPrompt,
  cleanupExpiredContexts,
  startIpcServer,
  stopIpcServer,
  isIpcServerRunning,
  getIpcServerSocketPath,
  registerFeishuHandlers,
  unregisterFeishuHandlers,
} from './tools/interactive-message.js';
export type { InteractiveOption } from './tools/interactive-message.js';

// Utils - Card Validator
export { isValidFeishuCard, getCardValidationError } from './utils/card-validator.js';

// IPC Client (re-exported from @disclaude/core for convenience)
export {
  UnixSocketIpcClient,
  getIpcClient,
  resetIpcClient,
  type IpcAvailabilityStatus,
  type IpcUnavailableReason,
} from '@disclaude/core';

// Channel MCP Server (platform-agnostic messaging tools via IPC)
export {
  channelTools,
  channelToolDefinitions,
  channelSdkTools,
  createChannelMcpServer,
} from './channel-mcp.js';

// Deprecated aliases (backward compatibility)
/** @deprecated Use channelTools instead */
export { feishuContextTools } from './channel-mcp.js';
/** @deprecated Use channelToolDefinitions instead */
export { feishuToolDefinitions } from './channel-mcp.js';
/** @deprecated Use channelSdkTools instead */
export { feishuSdkTools } from './channel-mcp.js';
/** @deprecated Use createChannelMcpServer instead */
export { createFeishuSdkMcpServer } from './channel-mcp.js';

// Version
export const MCP_SERVER_VERSION = '0.0.1';
