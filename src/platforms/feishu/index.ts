/**
 * Feishu Platform Module.
 *
 * Exports Feishu-specific implementations of platform adapters.
 *
 * Note: Some utilities have been migrated to @disclaude/primary-node.
 * Import them directly from '@disclaude/primary-node' instead.
 *
 * @see Issue #1040 - Separate Primary Node code to @disclaude/primary-node
 */

// Platform Adapter (application-level, kept in src/)
export { FeishuPlatformAdapter, type FeishuPlatformAdapterConfig } from './feishu-adapter.js';

// Sub-adapters (application-level, kept in src/)
export { FeishuMessageSender, type FeishuMessageSenderConfig } from './feishu-message-sender.js';
export { FeishuFileHandler, type FeishuFileHandlerConfig } from './feishu-file-handler.js';

// Card Builders - re-export from @disclaude/primary-node for convenience
export {
  buildTextContent,
  buildPostContent,
  buildSimplePostContent,
  type PostElement,
  type PostTextElement,
  type PostAtElement,
  type PostLinkElement,
  type PostImageElement,
  type PostContent,
} from '@disclaude/primary-node';

export {
  buildButton,
  buildMenu,
  buildDiv,
  buildMarkdown,
  buildDivider,
  buildActionGroup,
  buildNote,
  buildColumnSet,
  buildCard,
  buildConfirmCard,
  buildSelectionCard,
  type ButtonStyle,
  type ButtonConfig,
  type MenuOptionConfig,
  type MenuConfig,
  type DividerConfig,
  type MarkdownConfig,
  type ColumnConfig,
  type CardElement,
  type ActionElement,
  type ButtonAction,
  type MenuAction,
  type CardHeaderConfig,
  type CardConfig,
} from '@disclaude/primary-node';

export { extractCardTextContent } from '@disclaude/primary-node';

// Chat Operations - re-export from @disclaude/primary-node
export {
  createDiscussionChat,
  dissolveChat,
  addMembers,
  removeMembers,
  getMembers,
  getBotChats,
  type CreateDiscussionOptions,
  type ChatOpsConfig,
  type BotChatInfo,
} from '@disclaude/primary-node';

// Welcome Service - re-export from @disclaude/primary-node
export {
  WelcomeService,
  initWelcomeService,
  getWelcomeService,
  resetWelcomeService,
  type WelcomeServiceConfig,
} from '@disclaude/primary-node';

// Group Service - re-export from @disclaude/primary-node
export {
  GroupService,
  getGroupService,
  type GroupInfo,
  type CreateGroupOptions,
  type GroupServiceConfig,
} from '@disclaude/primary-node';

// Interaction Manager - re-export from @disclaude/primary-node
export {
  InteractionManager,
  type InteractionManagerConfig,
} from '@disclaude/primary-node';

// Feishu Client - re-export from @disclaude/primary-node
export {
  createFeishuClient,
  type CreateFeishuClientOptions,
} from '@disclaude/primary-node';
