/**
 * Request Review tool implementation.
 *
 * This tool provides a streamlined "御书房批奏折" (Imperial Study Review) experience
 * for AI to request user review with minimal cognitive load.
 *
 * @module mcp/tools/request-review
 */

import { createLogger } from '../../utils/logger.js';
import {
  buildReviewCard,
  buildQuickReviewCard,
  buildReviewCardWithDiff,
  buildBatchReviewCard,
  buildReviewActionPrompts,
  type ReviewCardConfig,
  type ChangeItem,
} from '../../platforms/feishu/card-builders/review-card-builder.js';
import { send_interactive_message } from './interactive-message.js';

const logger = createLogger('RequestReview');

/**
 * Request review parameters.
 */
export interface RequestReviewParams {
  /** Review title/subject */
  title: string;
  /** Review summary/description */
  summary: string;
  /** Target chat ID */
  chatId: string;
  /** Theme to use: 'imperial' (御书房), 'modern' (审批中心), 'minimal' (简洁) */
  theme?: 'imperial' | 'modern' | 'minimal';
  /** Optional parent message ID for thread reply */
  parentMessageId?: string;
  /** List of changes to display */
  changes?: Array<{
    path: string;
    type: 'added' | 'modified' | 'deleted' | 'renamed';
    description?: string;
    additions?: number;
    deletions?: number;
  }>;
  /** Diff content to display (for code reviews) */
  diffContent?: string;
  /** Maximum diff lines to show (default: 20) */
  maxDiffLines?: number;
  /** Additional context or details */
  details?: string;
  /** Context for action prompts (e.g., "PR #123", "task name") */
  context?: string;
  /** Footer note */
  footerNote?: string;
}

/**
 * Request review result.
 */
export interface RequestReviewResult {
  success: boolean;
  message: string;
  messageId?: string;
  error?: string;
}

/**
 * Request user review with a streamlined "御书房批奏折" experience.
 *
 * This tool sends an interactive review card with pre-configured action prompts,
 * making it easy for users to quickly approve, reject, or request changes.
 *
 * @example
 * ```typescript
 * // Simple review request
 * await request_review({
 *   title: '代码变更请求',
 *   summary: '修复了用户认证的 bug',
 *   chatId: 'oc_xxx',
 *   theme: 'imperial',
 * });
 *
 * // With changes and diff
 * await request_review({
 *   title: 'PR #123',
 *   summary: '添加了新功能',
 *   chatId: 'oc_xxx',
 *   changes: [
 *     { path: 'src/auth.ts', type: 'modified', additions: 10, deletions: 5 },
 *   ],
 *   diffContent: 'diff content...',
 *   context: 'PR #123',
 * });
 * ```
 */
export async function request_review(params: RequestReviewParams): Promise<RequestReviewResult> {
  const {
    title,
    summary,
    chatId,
    theme = 'modern',
    parentMessageId,
    changes,
    diffContent,
    maxDiffLines = 20,
    details,
    context,
    footerNote,
  } = params;

  logger.info({ title, chatId, theme, hasChanges: !!changes, hasDiff: !!diffContent }, 'request_review called');

  try {
    // Validate required parameters
    if (!title) {
      return { success: false, error: 'title is required', message: '❌ title is required' };
    }
    if (!summary) {
      return { success: false, error: 'summary is required', message: '❌ summary is required' };
    }
    if (!chatId) {
      return { success: false, error: 'chatId is required', message: '❌ chatId is required' };
    }

    // Build review card config
    const config: ReviewCardConfig = {
      title,
      summary,
      theme,
      changes: changes as ChangeItem[] | undefined,
      details,
      footerNote,
      showViewDetails: !!details,
    };

    // Build the card
    let card;
    if (diffContent) {
      card = buildReviewCardWithDiff(config, diffContent, maxDiffLines);
    } else {
      card = buildReviewCard(config);
    }

    // Build action prompts
    const actionPrompts = buildReviewActionPrompts(context || title, theme);

    // Send the interactive message
    const result = await send_interactive_message({
      card: card as unknown as Record<string, unknown>,
      actionPrompts,
      chatId,
      parentMessageId,
    });

    if (!result.success) {
      return {
        success: false,
        error: result.error,
        message: result.message,
      };
    }

    logger.info({ messageId: result.messageId, chatId }, 'Review request sent successfully');

    return {
      success: true,
      message: `✅ Review request sent with ${theme} theme`,
      messageId: result.messageId,
    };

  } catch (error) {
    logger.error({ err: error, chatId }, 'request_review failed');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to request review: ${errorMessage}` };
  }
}

/**
 * Request a quick review with just title and message.
 *
 * @example
 * ```typescript
 * await request_quick_review({
 *   title: '确认操作',
 *   message: '是否继续执行？',
 *   chatId: 'oc_xxx',
 *   theme: 'imperial',
 * });
 * ```
 */
export async function request_quick_review(params: {
  title: string;
  message: string;
  chatId: string;
  theme?: 'imperial' | 'modern' | 'minimal';
  parentMessageId?: string;
  context?: string;
}): Promise<RequestReviewResult> {
  const { title, message, chatId, theme = 'modern', parentMessageId, context } = params;

  logger.info({ title, chatId, theme }, 'request_quick_review called');

  try {
    if (!title || !message || !chatId) {
      return { success: false, error: 'title, message, and chatId are required', message: '❌ Missing required parameters' };
    }

    const card = buildQuickReviewCard(title, message, 'approve', 'reject', theme);
    const actionPrompts = buildReviewActionPrompts(context || title, theme);

    const result = await send_interactive_message({
      card: card as unknown as Record<string, unknown>,
      actionPrompts,
      chatId,
      parentMessageId,
    });

    if (!result.success) {
      return { success: false, error: result.error, message: result.message };
    }

    return {
      success: true,
      message: `✅ Quick review request sent`,
      messageId: result.messageId,
    };

  } catch (error) {
    logger.error({ err: error, chatId }, 'request_quick_review failed');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed: ${errorMessage}` };
  }
}

/**
 * Request batch review for multiple items.
 *
 * @example
 * ```typescript
 * await request_batch_review({
 *   title: '批量审批',
 *   items: [
 *     { name: '文件1.ts', description: '新增功能' },
 *     { name: '文件2.ts', description: '修复bug' },
 *   ],
 *   chatId: 'oc_xxx',
 *   theme: 'imperial',
 * });
 * ```
 */
export async function request_batch_review(params: {
  title: string;
  items: Array<{ name: string; description?: string }>;
  chatId: string;
  theme?: 'imperial' | 'modern' | 'minimal';
  parentMessageId?: string;
  context?: string;
}): Promise<RequestReviewResult> {
  const { title, items, chatId, theme = 'modern', parentMessageId, context } = params;

  logger.info({ title, chatId, theme, itemCount: items.length }, 'request_batch_review called');

  try {
    if (!title || !items || items.length === 0 || !chatId) {
      return { success: false, error: 'title, items, and chatId are required', message: '❌ Missing required parameters' };
    }

    const card = buildBatchReviewCard(title, items, 'approve_all', 'reject_all', theme);
    const actionPrompts = buildReviewActionPrompts(context || title, theme);

    const result = await send_interactive_message({
      card: card as unknown as Record<string, unknown>,
      actionPrompts,
      chatId,
      parentMessageId,
    });

    if (!result.success) {
      return { success: false, error: result.error, message: result.message };
    }

    return {
      success: true,
      message: `✅ Batch review request sent for ${items.length} items`,
      messageId: result.messageId,
    };

  } catch (error) {
    logger.error({ err: error, chatId }, 'request_batch_review failed');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed: ${errorMessage}` };
  }
}
