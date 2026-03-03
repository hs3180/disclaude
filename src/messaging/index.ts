/**
 * Message routing module for level-based and channel-based message routing.
 *
 * This module implements:
 * - Issue #266: Message Level Routing System
 * - Issue #513: Multi-channel Message Routing Layer (Phase 1)
 *
 * Features:
 * - Routes execution progress to admin chats
 * - Routes only key interactions to user chats
 * - Configurable message levels
 * - Throttling for progress messages
 * - Channel-type detection (Feishu, CLI, REST)
 * - Multi-channel message routing
 *
 * @example
 * ```typescript
 * import {
 *   MessageRouter,
 *   ChannelMessageRouter,
 *   RoutedOutputAdapter,
 *   MessageLevel,
 *   createDefaultRouteConfig,
 * } from './messaging/index.js';
 *
 * // Create level-based router
 * const config = createDefaultRouteConfig('user_chat_id');
 * config.adminChatId = 'admin_chat_id';
 *
 * const router = new MessageRouter({
 *   config,
 *   sender: feishuMessageSender,
 * });
 *
 * // Create channel router for MCP tools
 * const channelRouter = new ChannelMessageRouter({
 *   sendToFeishu: async (chatId, msg) => { ... },
 * });
 *
 * // Detect channel type
 * const type = channelRouter.detectChannel('oc_abc123'); // 'feishu'
 *
 * // Route message
 * await channelRouter.route('oc_abc123', { type: 'text', text: 'Hello' });
 * ```
 *
 * @see Issue #266
 * @see Issue #513
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

// Channel Message Router (Issue #513)
export {
  ChannelMessageRouter,
  ChannelType,
  initChannelMessageRouter,
  getChannelMessageRouter,
  resetChannelMessageRouter,
  type ChannelMessageRouterOptions,
  type RoutingResult,
} from './channel-message-router.js';
