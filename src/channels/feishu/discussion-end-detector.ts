/**
 * Discussion End Detector.
 *
 * Detects discussion end trigger phrases in bot messages and triggers
 * group dissolution.
 *
 * @see Issue #1229 - 智能会话结束 - 判断讨论何时可以关闭
 */

import type * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../utils/logger.js';
import { dissolveChat } from '../../platforms/feishu/chat-ops.js';
import { getGroupService } from '../../platforms/feishu/group-service.js';

const logger = createLogger('DiscussionEndDetector');

/**
 * Trigger phrase patterns.
 *
 * Format: [DISCUSSION_END] or [DISCUSSION_END:summary=xxx]
 *
 * Note: We use non-global patterns here because we need to extract capture groups.
 * For removal purposes, we create fresh global patterns in removeTriggerPhrase.
 */
const TRIGGER_PATTERNS = {
  // Standard end: [DISCUSSION_END]
  STANDARD: /\[DISCUSSION_END\]/,
  // End with summary: [DISCUSSION_END:summary=xxx]
  WITH_SUMMARY: /\[DISCUSSION_END:summary=([^\]]+)\]/,
  // Timeout end: [DISCUSSION_END:timeout]
  TIMEOUT: /\[DISCUSSION_END:timeout\]/,
  // Abandoned end: [DISCUSSION_END:abandoned]
  ABANDONED: /\[DISCUSSION_END:abandoned\]/,
} as const;

// Global patterns for removal (no capture groups needed)
const REMOVAL_PATTERNS = [
  /\[DISCUSSION_END:summary=[^\]]+\]/g,
  /\[DISCUSSION_END:timeout\]/g,
  /\[DISCUSSION_END:abandoned\]/g,
  /\[DISCUSSION_END\]/g,
];

/**
 * Discussion end type.
 */
export type DiscussionEndType = 'standard' | 'timeout' | 'abandoned';

/**
 * Parsed trigger phrase result.
 */
export interface DiscussionEndResult {
  /** Whether a trigger phrase was detected */
  detected: boolean;
  /** Type of discussion end */
  type: DiscussionEndType;
  /** Optional summary extracted from the trigger */
  summary?: string;
  /** The original trigger phrase matched */
  triggerPhrase?: string;
}

/**
 * Detect discussion end trigger phrase in message content.
 *
 * @param content - Message content to check
 * @returns Detection result
 */
export function detectDiscussionEnd(content: string): DiscussionEndResult {
  if (!content || typeof content !== 'string') {
    return { detected: false, type: 'standard' };
  }

  // Check for summary variant first (most specific)
  const summaryMatch = content.match(TRIGGER_PATTERNS.WITH_SUMMARY);
  if (summaryMatch) {
    return {
      detected: true,
      type: 'standard',
      summary: summaryMatch[1],
      triggerPhrase: summaryMatch[0],
    };
  }

  // Check for timeout variant
  if (TRIGGER_PATTERNS.TIMEOUT.test(content)) {
    return {
      detected: true,
      type: 'timeout',
      triggerPhrase: '[DISCUSSION_END:timeout]',
    };
  }

  // Check for abandoned variant
  if (TRIGGER_PATTERNS.ABANDONED.test(content)) {
    return {
      detected: true,
      type: 'abandoned',
      triggerPhrase: '[DISCUSSION_END:abandoned]',
    };
  }

  // Check for standard variant
  if (TRIGGER_PATTERNS.STANDARD.test(content)) {
    return {
      detected: true,
      type: 'standard',
      triggerPhrase: '[DISCUSSION_END]',
    };
  }

  return { detected: false, type: 'standard' };
}

/**
 * Remove trigger phrase from message content.
 *
 * This cleans up the message before sending to users, so they don't see
 * the raw trigger phrase.
 *
 * @param content - Original message content
 * @param result - Detection result
 * @returns Cleaned content
 */
export function removeTriggerPhrase(
  content: string,
  result: DiscussionEndResult
): string {
  if (!result.detected) {
    return content;
  }

  // Remove all trigger phrases from content using global patterns
  let cleaned = content;
  for (const pattern of REMOVAL_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }

  return cleaned.trim();
}

/**
 * Discussion end handler configuration.
 */
export interface DiscussionEndHandlerConfig {
  /** Feishu API client */
  client: lark.Client;
  /** Delay in ms before dissolving group (default: 2000ms) */
  dissolutionDelay?: number;
}

/**
 * Handle discussion end by dissolving the group.
 *
 * This function:
 * 1. Logs the discussion end with summary
 * 2. Waits a short delay to ensure the message is delivered
 * 3. Dissolves the group chat
 * 4. Unregisters the group from the registry
 *
 * @param chatId - Chat ID to dissolve
 * @param result - Detection result
 * @param config - Handler configuration
 */
export async function handleDiscussionEnd(
  chatId: string,
  result: DiscussionEndResult,
  config: DiscussionEndHandlerConfig
): Promise<void> {
  const { client, dissolutionDelay = 2000 } = config;

  logger.info(
    {
      chatId,
      type: result.type,
      summary: result.summary,
    },
    'Discussion end detected, scheduling group dissolution'
  );

  // Wait for message to be delivered before dissolving
  if (dissolutionDelay > 0) {
    await new Promise((resolve) => setTimeout(resolve, dissolutionDelay));
  }

  try {
    // Check if this is a managed group
    const groupService = getGroupService();
    const group = groupService.getGroup(chatId);

    // Dissolve the chat
    await dissolveChat(client, chatId);

    // Unregister from group service if it was managed
    if (group) {
      groupService.unregisterGroup(chatId);
      logger.info(
        {
          chatId,
          groupName: group.name,
          type: result.type,
          summary: result.summary,
        },
        'Discussion group dissolved and unregistered'
      );
    } else {
      logger.info(
        {
          chatId,
          type: result.type,
          summary: result.summary,
        },
        'Chat dissolved (was not a managed group)'
      );
    }
  } catch (error) {
    logger.error(
      { err: error, chatId, type: result.type },
      'Failed to dissolve discussion group'
    );
  }
}

/**
 * Process a message for discussion end trigger.
 *
 * This is the main entry point that combines detection and handling.
 * It detects if the message contains a trigger phrase and if so,
 * triggers the dissolution process.
 *
 * @param chatId - Chat ID where the message is being sent
 * @param content - Message content to check
 * @param client - Feishu API client
 * @returns The detection result (for potential content cleanup)
 */
export async function processDiscussionEnd(
  chatId: string,
  content: string,
  client: lark.Client
): Promise<DiscussionEndResult> {
  const result = detectDiscussionEnd(content);

  if (result.detected) {
    // Fire and forget - don't block message sending
    handleDiscussionEnd(chatId, result, { client }).catch((error) => {
      logger.error({ err: error, chatId }, 'Discussion end handler failed');
    });
  }

  return result;
}
