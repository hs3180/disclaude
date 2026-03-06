/**
 * Tool implementations for messaging MCP.
 *
 * @module mcp/tools
 */

export type {
  SendMessageResult,
  SendFileResult,
  UpdateMessageResult,
  WaitForInteractionResult,
  MessageSentCallback,
  PendingInteraction,
  ActionPromptMap,
  InteractiveMessageContext,
  SendInteractiveResult,
  // Deprecated aliases
  SendFeedbackResult,
  UpdateCardResult,
} from './types.js';

// New platform-agnostic tool names
export { send_message, setMessageSentCallback, getMessageSentCallback } from './send-message.js';
export { send_file } from './send-file.js';
export { update_message, wait_for_interaction, resolvePendingInteraction } from './card-interaction.js';
export {
  send_interactive_message,
  registerActionPrompts,
  getActionPrompts,
  unregisterActionPrompts,
  generateInteractionPrompt,
  cleanupExpiredContexts,
} from './interactive-message.js';

// Deprecated aliases for backward compatibility
export { send_user_feedback } from './send-message.js';
export { send_file_to_feishu } from './send-file.js';
export { update_card } from './card-interaction.js';
