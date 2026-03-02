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

// ============================================================================
// Universal Message Format (UMF) - Issue #480
// ============================================================================

// Universal Message Types
export {
  // Types
  type TextContent,
  type MarkdownContent,
  type CardAction,
  type CardSection,
  type CardColumn,
  type CardContent,
  type FileContent,
  type DoneContent,
  type MessageContent,
  type UniversalMessage,
  type UniversalMessageMetadata,
  type ChannelCapabilities,

  // Capabilities
  DEFAULT_CAPABILITIES,
  FEISHU_CAPABILITIES,
  CLI_CAPABILITIES,
  REST_CAPABILITIES,

  // Type guards
  isTextContent,
  isMarkdownContent,
  isCardContent,
  isFileContent,
  isDoneContent,

  // Helpers
  createTextMessage,
  createMarkdownMessage,
  createCardMessage,
} from './universal-message.js';

// Channel Adapter Interface
export {
  type SendResult,
  type IChannelAdapter,
  BaseChannelAdapter,
  type ChannelAdapterFactory,
} from './channel-adapter.js';

// Message Service
export {
  MessageService,
  type MessageServiceConfig,
  type MessageServiceResult,
  getMessageService,
  setMessageService,
  createMessageService,
} from './message-service.js';

// Adapters
export {
  CLIAdapter,
  createCLIAdapter,
  FeishuAdapter,
  createFeishuAdapter,
  RESTAdapter,
  createRESTAdapter,
  getRESTAdapter,
  setRESTAdapter,
} from './adapters/index.js';
