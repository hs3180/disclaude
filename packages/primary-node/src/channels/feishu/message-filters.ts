/**
 * Pre-processing message filters for the Feishu channel (Issue #4126).
 *
 * Extracted from MessageHandler.handleMessageReceive(). These are pure
 * verdict functions for the three early guard clauses — deduplication,
 * bot-message filtering (with bot-to-bot @mention carve-out, #1742), and
 * message-age checking. Side effects (logging, forwardFilteredMessage)
 * stay in the handler; this module only decides pass/filter + the reason.
 *
 * @module primary-node/channels/feishu/message-filters
 */

/** Why an incoming message was filtered out. */
export type MessageFilterReason = 'duplicate' | 'bot' | 'old';

/** Dependencies injected from MessageHandler. */
export interface MessageFilterDeps {
  /** Returns true if the message id has already been processed (dedup). */
  isProcessed(messageId: string): boolean;
  /** Max age (ms) before a message is considered stale and dropped. */
  maxMessageAge: number;
}

/** Inputs needed to evaluate the filters. */
export interface MessageFilterInput {
  messageId: string;
  /** Feishu create_time (epoch ms), if present. */
  createTime?: number;
  /** sender.sender_type ('app' for bots), if present. */
  senderType?: string;
  /**
   * Whether a bot sender @mentions our bot. Pre-computed by the caller
   * (via MentionDetector) so this module stays free of Feishu types.
   * Bot-to-bot @mention messages are allowed through (#1742).
   */
  botMentionsUs: boolean;
}

/** Result of running the filters. */
export interface FilterVerdict {
  passed: boolean;
  /** Present (and passed=false) when a filter rejected the message. */
  reason?: MessageFilterReason;
  /** Message age in ms; present when reason === 'old'. */
  age?: number;
}

/**
 * Evaluate dedup → bot → age filters in order.
 *
 * Returns the first rejection, or `{ passed: true }` if all filters pass.
 * Pure: performs no I/O and mutates nothing.
 */
export function evaluateMessageFilters(
  input: MessageFilterInput,
  deps: MessageFilterDeps,
): FilterVerdict {
  // 1. Deduplication
  if (deps.isProcessed(input.messageId)) {
    return { passed: false, reason: 'duplicate' };
  }

  // 2. Bot messages are ignored unless the sender bot @mentions our bot (#1742).
  if (input.senderType === 'app' && !input.botMentionsUs) {
    return { passed: false, reason: 'bot' };
  }

  // 3. Message age
  if (input.createTime !== undefined) {
    const age = Date.now() - input.createTime;
    if (age > deps.maxMessageAge) {
      return { passed: false, reason: 'old', age };
    }
  }

  return { passed: true };
}
