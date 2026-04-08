/**
 * Feishu platform module for @disclaude/primary-node.
 *
 * This module contains Feishu-specific platform adapters and services.
 *
 * @see Issue #1040 - Separate Primary Node code to @disclaude/primary-node
 */

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

// Interaction Manager
export {
  InteractionManager,
  type InteractionManagerConfig,
} from './interaction-manager.js';

// Card Builders
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
} from './card-builders/content-builder.js';

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
} from './card-builders/interactive-card-builder.js';

export { extractCardTextContent } from './card-builders/card-text-extractor.js';
