/**
 * Tool implementations for Feishu MCP.
 *
 * @module mcp/tools
 */

export type {
  SendFeedbackResult,
  SendFileResult,
  UpdateCardResult,
  WaitForInteractionResult,
  MessageSentCallback,
  PendingInteraction,
  ActionPromptMap,
  InteractiveMessageContext,
  SendInteractiveResult,
} from './types.js';

export { send_user_feedback, setMessageSentCallback, getMessageSentCallback } from './send-message.js';
export { send_file_to_feishu } from './send-file.js';
export { update_card, wait_for_interaction, resolvePendingInteraction } from './card-interaction.js';
export {
  send_interactive_message,
  registerActionPrompts,
  getActionPrompts,
  unregisterActionPrompts,
  generateInteractionPrompt,
  cleanupExpiredContexts,
} from './interactive-message.js';

export type { PostResult, PostInfo, ListPostsOptions, ListPostsResult } from './topic-post.js';
export { create_post, reply_post, get_posts, get_post } from './topic-post.js';
