/**
 * Feishu Card Builders.
 *
 * Platform-specific card builders for Feishu interactive messages.
 */

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
} from './content-builder.js';

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
} from './interactive-card-builder.js';

export {
  buildReviewCard,
  buildQuickReviewCard,
  buildReviewStatsCard,
  REVIEW_THEMES,
  type ReviewCardConfig,
  type ChangeItem,
  type ReviewTheme,
} from './review-card-builder.js';
