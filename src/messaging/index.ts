/**
 * Message routing module for level-based and channel-based message routing.
 *
 * This module implements:
 * - Issue #266: Message Level Routing System
 * - Issue #513: Multi-channel Message Routing Layer (Phase 1)
 * - Issue #515: Universal Message Format + Channel Adapters (Phase 2)
 *
 * Features:
 * - Routes execution progress to admin chats
 * - Routes only key interactions to user chats
 * - Configurable message levels
 * - Throttling for progress messages
 * - Channel-type detection (Feishu, CLI, REST)
 * - Multi-channel message routing
 * - Universal Message Format (UMF) for platform-agnostic messages
 * - Channel Adapters for format conversion
 *
 * @example
 * ```typescript
 * import {
 *   MessageRouter,
 *   ChannelMessageRouter,
 *   RoutedOutputAdapter,
 *   MessageLevel,
 *   createDefaultRouteConfig,
 *   // UMF and Adapters (Phase 2)
 *   MessageService,
 *   UniversalMessage,
 *   createTextMessage,
 *   createCardMessage,
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
 *
 * // Using UMF and MessageService (Phase 2)
 * const messageService = new MessageService({
 *   adapters: [new FeishuAdapter(), new CliAdapter(), new RestAdapter()],
 * });
 *
 * // Send platform-agnostic message
 * await messageService.send(createTextMessage('oc_xxx', 'Hello!'));
 *
 * // Send card message (auto-converts for each platform)
 * await messageService.send(createCardMessage('oc_xxx', 'Task Complete', [
 *   { type: 'text', content: 'All done!' }
 * ]));
 * ```
 *
 * @see Issue #266
 * @see Issue #513
 * @see Issue #515
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

// Universal Message Format (Issue #515 Phase 2)
export {
  // Types
  type TextContent,
  type MarkdownContent,
  type CardContent,
  type FileContent,
  type DoneContent,
  type CardSection,
  type CardAction,
  type CardSectionType,
  type CardActionType,
  type MessageContent,
  type UniversalMessage,
  type UniversalMessageMetadata,
  type SendResult,
  // Type Guards
  isTextContent,
  isMarkdownContent,
  isCardContent,
  isFileContent,
  isDoneContent,
  // Helpers
  createTextMessage,
  createMarkdownMessage,
  createCardMessage,
  createDoneMessage,
} from './universal-message.js';

// Channel Adapters (Issue #515 Phase 2)
export {
  // Types
  type ChannelCapabilities,
  type IChannelAdapter,
  // Capabilities
  DEFAULT_CAPABILITIES,
  FEISHU_CAPABILITIES,
  CLI_CAPABILITIES,
  REST_CAPABILITIES,
  // Utilities
  cardToText,
  truncateText,
  isContentTypeSupported,
  getFallbackContentType,
  negotiateContentType,
} from './channel-adapter.js';

// Message Service (Issue #515 Phase 2)
export {
  MessageService,
  initMessageService,
  getMessageService,
  resetMessageService,
  type MessageServiceOptions,
} from './message-service.js';

// Adapters
export { FeishuAdapter, createFeishuAdapter } from './adapters/feishu-adapter.js';
export { CliAdapter, createCliAdapter } from './adapters/cli-adapter.js';
export {
  RestAdapter,
  createRestAdapter,
  getRestAdapter,
  resetRestAdapter,
  type RestMessage,
} from './adapters/rest-adapter.js';
