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
