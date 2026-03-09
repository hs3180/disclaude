/**
 * Discussion conclusion collector for group chat discussions.
 *
 * Implements Issue #1152: Summarize group discussion conclusions to decide PR actions.
 *
 * This tool collects messages from a group discussion and helps the agent
 * summarize the conclusion, rather than relying on button clicks.
 *
 * @module mcp/tools/discussion-conclusion
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { createFeishuClient } from '../../platforms/feishu/create-feishu-client.js';
import { getThreads } from '../utils/feishu-api.js';

const logger = createLogger('DiscussionConclusion');

/**
 * Supported action types from discussion conclusion.
 */
export type DiscussionAction = 'merge' | 'request_changes' | 'close' | 'later';

/**
 * Result type for collect_discussion_conclusion tool.
 */
export interface CollectDiscussionConclusionResult {
  success: boolean;
  message: string;
  /** Chat messages collected */
  messages?: Array<{
    senderId?: string;
    senderType?: string;
    content: string;
    createTime: string;
    contentType: string;
  }>;
  /** Total message count */
  messageCount?: number;
  /** Discussion time range */
  timeRange?: {
    start: string;
    end: string;
  };
  /** Suggested action based on keyword detection (optional hint) */
  suggestedAction?: DiscussionAction;
  /** Error message if failed */
  error?: string;
}

/**
 * Keywords that indicate specific actions in Chinese and English.
 */
const ACTION_KEYWORDS: Record<DiscussionAction, string[]> = {
  merge: ['合并', 'merge', '通过', 'approve', '批准', '可以合并', 'ready to merge', '看起来不错', '没问题'],
  request_changes: ['修改', 'request changes', '需要改', '建议修改', '有问题', 'fix', 'change', '改一下', '再看看'],
  close: ['关闭', 'close', '不要了', '放弃', 'reject', '拒绝', '不需要', 'wontfix'],
  later: ['稍后', 'later', '待定', 'pending', '等一下', '下次', '先放', 'hold'],
};

/**
 * Detect suggested action from message content.
 *
 * @param messages - Array of message contents
 * @returns Suggested action or undefined
 */
function detectSuggestedAction(messages: string[]): DiscussionAction | undefined {
  const allText = messages.join(' ').toLowerCase();

  // Count matches for each action
  const scores: Record<DiscussionAction, number> = {
    merge: 0,
    request_changes: 0,
    close: 0,
    later: 0,
  };

  for (const [action, keywords] of Object.entries(ACTION_KEYWORDS)) {
    for (const keyword of keywords) {
      const regex = new RegExp(keyword, 'gi');
      const matches = allText.match(regex);
      if (matches) {
        scores[action as DiscussionAction] += matches.length;
      }
    }
  }

  // Find the action with highest score
  let maxScore = 0;
  let suggestedAction: DiscussionAction | undefined;

  for (const [action, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      suggestedAction = action as DiscussionAction;
    }
  }

  // Only return if there's a clear indication (score >= 2)
  return maxScore >= 2 ? suggestedAction : undefined;
}

/**
 * Parse message content from Feishu API response.
 *
 * @param content - Raw content string from API
 * @param contentType - Message content type
 * @returns Parsed text content
 */
function parseMessageContent(content: string, contentType: string): string {
  if (!content) {
    return '';
  }

  try {
    if (contentType === 'text') {
      const parsed = JSON.parse(content);
      return parsed.text || content;
    }

    if (contentType === 'post') {
      const parsed = JSON.parse(content);
      // Extract text from post content
      const textParts: string[] = [];
      if (parsed.title) {
        textParts.push(parsed.title);
      }
      if (Array.isArray(parsed.content)) {
        for (const block of parsed.content) {
          if (Array.isArray(block)) {
            for (const item of block) {
              if (item.text) {
                textParts.push(item.text);
              }
            }
          }
        }
      }
      return textParts.join(' ');
    }

    // For other types, try to parse as JSON and extract text
    const parsed = JSON.parse(content);
    if (parsed.text) {
      return parsed.text;
    }

    return content;
  } catch {
    // If not JSON, return as-is
    return content;
  }
}

/**
 * Collect discussion conclusion from a group chat.
 *
 * This tool retrieves all messages from a group discussion and provides
 * them to the agent for analysis. The agent should then summarize the
 * discussion and decide on the appropriate action.
 *
 * @param params - Tool parameters
 * @returns Result with collected messages and hints
 */
export async function collect_discussion_conclusion(params: {
  /** Chat ID of the discussion group */
  chatId: string;
  /** Maximum number of messages to collect (default: 50) */
  maxMessages?: number;
  /** Only collect messages after this timestamp (ISO format) */
  afterTime?: string;
}): Promise<CollectDiscussionConclusionResult> {
  const { chatId, maxMessages = 50, afterTime } = params;

  logger.info({
    chatId,
    maxMessages,
    afterTime,
  }, 'collect_discussion_conclusion called');

  try {
    // Validate required parameters
    if (!chatId) {
      return {
        success: false,
        message: 'chatId is required',
        error: 'chatId is required',
      };
    }

    // Get Feishu credentials
    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET in disclaude.config.yaml';
      logger.error({ chatId }, errorMsg);
      return { success: false, message: errorMsg, error: errorMsg };
    }

    // Create client
    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });

    // Get all messages from the chat
    // Note: In topic-mode chats, getThreads returns root messages
    // For regular chats, we need to get all messages
    const result = await getThreads(client, chatId, maxMessages);

    if (!result.success) {
      return {
        success: false,
        message: `Failed to get messages: ${result.error}`,
        error: result.error,
      };
    }

    // Process messages
    const messages: CollectDiscussionConclusionResult['messages'] = [];
    let startTime = '';
    let endTime = '';

    for (const thread of result.threads) {
      // Filter by time if specified
      if (afterTime && thread.createTime < afterTime) {
        continue;
      }

      // Track time range
      if (!startTime || thread.createTime < startTime) {
        startTime = thread.createTime;
      }
      if (!endTime || thread.createTime > endTime) {
        endTime = thread.createTime;
      }

      // Parse message content
      const textContent = parseMessageContent(thread.content, thread.contentType);

      messages.push({
        senderId: thread.senderId,
        senderType: thread.senderType,
        content: textContent,
        createTime: thread.createTime,
        contentType: thread.contentType,
      });
    }

    // If no messages found
    if (messages.length === 0) {
      return {
        success: true,
        message: 'No messages found in the discussion',
        messages: [],
        messageCount: 0,
      };
    }

    // Detect suggested action from messages
    const messageTexts = messages.map((m) => m.content);
    const suggestedAction = detectSuggestedAction(messageTexts);

    // Build result message
    let resultMessage = `Collected ${messages.length} messages from discussion`;

    if (suggestedAction) {
      const actionLabels: Record<DiscussionAction, string> = {
        merge: 'Merge',
        request_changes: 'Request Changes',
        close: 'Close',
        later: 'Later',
      };
      resultMessage += `. Suggested action: ${actionLabels[suggestedAction]}`;
    }

    resultMessage += '. Please analyze the messages and summarize the discussion conclusion.';

    logger.info({
      chatId,
      messageCount: messages.length,
      suggestedAction,
    }, 'Discussion messages collected');

    return {
      success: true,
      message: resultMessage,
      messages,
      messageCount: messages.length,
      timeRange: startTime && endTime ? { start: startTime, end: endTime } : undefined,
      suggestedAction,
    };
  } catch (error) {
    logger.error({ err: error, chatId }, 'collect_discussion_conclusion FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      message: `Failed to collect discussion conclusion: ${errorMessage}`,
      error: errorMessage,
    };
  }
}
