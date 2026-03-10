/**
 * Feishu platform module for @disclaude/primary-node.
 *
 * This module contains Feishu-specific platform adapters and services.
 *
 * @see Issue #1040 - Separate Primary Node code to @disclaude/primary-node
 */

// Chat operations
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
} from './chat-ops.js';

// Group service
export {
  GroupService,
  getGroupService,
  type GroupInfo,
  type CreateGroupOptions,
  type GroupServiceConfig,
} from './group-service.js';

// Welcome service
export {
  WelcomeService,
  initWelcomeService,
  getWelcomeService,
  resetWelcomeService,
  type WelcomeServiceConfig,
} from './welcome-service.js';

// Feishu client factory
export {
  createFeishuClient,
  type CreateFeishuClientOptions,
} from './create-feishu-client.js';

// Interaction manager
export {
  InteractionManager,
  type InteractionManagerConfig,
} from './interaction-manager.js';

// Card builders
export {
  // Content builders
  buildTextContent,
  buildPostContent,
  buildSimplePostContent,
  type PostElement,
  type PostTextElement,
  type PostAtElement,
  type PostLinkElement,
  type PostImageElement,
  type PostContent,
  // Card builders
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
  // Text extractor
  extractCardTextContent,
} from './card-builders/index.js';

