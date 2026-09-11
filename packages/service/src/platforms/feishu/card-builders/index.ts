/**
 * Feishu Card Builders.
 *
 * Platform-specific card builders for Feishu interactive messages.
 */

// Issue #4396 (#4208 P1-b): JSON-2.0 streaming placeholder card builder.
export {
  buildStreamingPlaceholderCard,
  STREAMING_THINKING_ELEMENT_ID,
  STREAMING_REPLY_ELEMENT_ID,
  STREAMING_THINKING_PLACEHOLDER,
  type StreamingCard,
  type StreamingCardElement,
  type BuildStreamingCardOptions,
} from './streaming-card-builder.js';

export {
  buildTextContent,
  normalizeMarkdownLineBreaks,
  normalizeCardMarkdown,
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

export { extractCardTextContent, extractFullCardContent } from './card-text-extractor.js';

export {
  buildInteractiveCard,
  buildActionPrompts,
  validateInteractiveParams,
  type InteractiveOption,
  type InteractiveMessageParams,
  type InteractiveCard,
  type ActionPromptMap,
} from './interactive-message-builder.js';
