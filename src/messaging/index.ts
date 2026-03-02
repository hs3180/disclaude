/**
 * Message routing module for level-based message routing.
 *
 * This module implements Issue #266: Message Level Routing System
 *
 * Features:
 * - Routes execution progress to admin chats
 * - Routes only key interactions to user chats
 * - Configurable message levels
 * - Throttling for progress messages
 *
 * @example
 * ```typescript
 * import {
 *   MessageRouter,
 *   RoutedOutputAdapter,
 *   MessageLevel,
 *   createDefaultRouteConfig,
 * } from './messaging/index.js';
 *
 * // Create router
 * const config = createDefaultRouteConfig('user_chat_id');
 * config.adminChatId = 'admin_chat_id';
 *
 * const router = new MessageRouter({
 *   config,
 *   sender: feishuMessageSender,
 * });
 *
 * // Create output adapter
 * const adapter = new RoutedOutputAdapter({ router });
 *
 * // Use adapter
 * await adapter.write('Task completed', 'result');
 * ```
 *
 * @see Issue #266
 */

// Types
export {
  MessageLevel,
  DEFAULT_USER_LEVELS,
  ALL_LEVELS,
  type RoutedMessage,
  type RoutedMessageMetadata,
  type MessageRouteConfig,
  type IMessageRouter,
  type IMessageSender,
  mapAgentMessageTypeToLevel,
} from './types.js';

// Router
export {
  MessageRouter,
  type MessageRouterOptions,
  createDefaultRouteConfig,
} from './message-router.js';

// Output Adapter
export {
  RoutedOutputAdapter,
  SimpleUserOutputAdapter,
  type RoutedOutputAdapterOptions,
} from './routed-output-adapter.js';

// Chat Channel Registry (Issue #445)
export {
  ChatChannelRegistry,
  chatChannelRegistry,
  type ChannelType,
  type ChatMetadata,
} from './chat-channel-registry.js';

// Message Adapter Service (Issue #445)
export {
  MessageAdapterService,
  getMessageAdapterService,
  resetMessageAdapterService,
  CliChannelAdapter,
  RestChannelAdapter,
  FeishuChannelAdapter,
  type MessageSendResult,
  type MessageFormat,
  type IChannelMessageAdapter,
} from './message-adapter-service.js';

// Message MCP Tools (Issue #445)
export {
  send_user_feedback,
  send_file_to_chat,
  send_file_to_feishu,
  update_card,
  wait_for_interaction,
  setMessageSentCallback,
  resolvePendingInteraction,
  resetAllState,
  messageToolDefinitions,
  messageSdkTools,
  createMessageSdkMcpServer,
  // Backward compatibility
  feishuToolDefinitions,
  createFeishuSdkMcpServer,
  type MessageSentCallback,
} from './message-mcp-tools.js';
