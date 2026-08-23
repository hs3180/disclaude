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

import pkg from '../package.json' with { type: 'json' };

// Tool Types
export type {
  SendMessageResult,
  SendFileResult,
  MessageSentCallback,
  ActionPromptMap,
  InteractiveOption,
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

// Tools - Push to Agent (Issue #3808)
export { push_to_agent } from './tools/push-to-agent.js';

// Tools - Interactive Message
// Issue #4280 (part 4): the mcp-server's UnixSocketIpcServer lifecycle
// exports are removed — dead code since part 3 made every tool a REST client.
export {
  send_interactive_message,
  send_interactive,
} from './tools/interactive-message.js';

// Utils - Card Validator
export { isValidFeishuCard, getCardValidationError } from './utils/card-validator.js';

// Utils - Card send preprocessing helpers.
// These transforms live in the channel-mcp ENTRY handler (not inside the
// first-party `send_card` fn — see tools/send-card.ts), so a CLI that reuses
// `send_card` directly would silently drop them. Exporting them lets the
// channel CLI Skill (skills/channel/cli.mjs, Issue #4459) replicate the exact
// MCP handler pipeline and reach feature parity: GFM-table → column_set
// auto-conversion (#2340), local-image auto-upload (#2951), chatId-format and
// card-structure validation. No behavior change for existing callers.
export { transformCardTables } from './utils/table-converter.js';
export { resolveCardImages } from './utils/card-image-resolver.js';
export { getChatIdValidationError } from './utils/chat-id-validator.js';
export { detectMarkdownTableWarnings } from './utils/card-validator.js';

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

// Version — read from package.json to avoid drift
export const MCP_SERVER_VERSION = pkg.version;
