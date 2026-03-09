/**
 * Request Review MCP Tool.
 *
 * Provides "御书房批奏折" (Imperial Study Review) experience for AI to request
 * user reviews with beautifully formatted Feishu cards.
 *
 * @module mcp/tools/request-review
 */

import { createLogger } from '../../utils/logger.js';
import { send_interactive_message } from './interactive-message.js';
import {
  buildReviewCard,
  buildQuickReviewCard,
  buildBatchReviewCard,
  buildReviewActionPrompts,
  type ReviewCardConfig,
  type ChangeItem,
} from '../../platforms/feishu/card-builders/review-card-builder.js';
import type { SendInteractiveResult } from './types.js';

const logger = createLogger('RequestReview');

/**
 * Review theme options.
 */
export type ReviewTheme = 'imperial' | 'modern' | 'minimal';

/**
 * Change type for review.
 */
export interface ReviewChange {
  /** File path or item name */
  path: string;
  /** Change type */
  type: 'added' | 'modified' | 'deleted' | 'renamed';
  /** Optional description */
  description?: string;
  /** Lines added */
  additions?: number;
  /** Lines deleted */
  deletions?: number;
}

/**
 * Parameters for request_review tool.
 */
export interface RequestReviewParams {
  /** Review title */
  title: string;
  /** Summary/description of the review request */
  summary: string;
  /** Target chat ID */
  chatId: string;
  /** Theme: 'imperial' (御书房), 'modern' (审批中心), 'minimal' (简洁) */
  theme?: ReviewTheme;
  /** List of changes to display */
  changes?: ReviewChange[];
  /** Additional context or details */
  details?: string;
  /** Context for action prompts (e.g., "PR #123") */
  context?: string;
  /** Parent message ID for thread reply */
  parentMessageId?: string;
}

/**
 * Parameters for quick_review tool.
 */
export interface QuickReviewParams {
  /** Review title */
  title: string;
  /** Review message/question */
  message: string;
  /** Target chat ID */
  chatId: string;
  /** Theme */
  theme?: ReviewTheme;
  /** Parent message ID for thread reply */
  parentMessageId?: string;
}

/**
 * Parameters for batch_review tool.
 */
export interface BatchReviewParams {
  /** Review title */
  title: string;
  /** Items to review */
  items: Array<{ name: string; description?: string }>;
  /** Target chat ID */
  chatId: string;
  /** Theme */
  theme?: ReviewTheme;
  /** Parent message ID for thread reply */
  parentMessageId?: string;
}

/**
 * Result of review request.
 */
export interface RequestReviewResult {
  success: boolean;
  message: string;
  messageId?: string;
}

/**
 * Request a full review with the "御书房批奏折" experience.
 *
 * @param params - Review parameters
 * @returns Result of the review request
 */
export async function request_review(params: RequestReviewParams): Promise<RequestReviewResult> {
  const { title, summary, chatId, theme = 'modern', changes, details, context, parentMessageId } = params;

  logger.debug({ title, chatId, theme }, 'Requesting review');

  try {
    // Build the review card
    const changeItems: ChangeItem[] = (changes || []).map((c) => ({
      path: c.path,
      type: c.type,
      description: c.description,
      additions: c.additions,
      deletions: c.deletions,
    }));

    const cardConfig: ReviewCardConfig = {
      title,
      summary,
      theme,
      changes: changeItems,
      details,
      approveAction: 'approve',
      rejectAction: 'reject',
      requestChangesAction: 'request_changes',
      showViewDetails: !!details,
      viewDetailsAction: details ? 'view_details' : undefined,
    };

    const card = buildReviewCard(cardConfig);

    // Generate action prompts
    const actionPrompts = buildReviewActionPrompts(context || title, theme);

    // Send the interactive card
    const result: SendInteractiveResult = await send_interactive_message({
      card: card as unknown as Record<string, unknown>,
      actionPrompts,
      chatId,
      parentMessageId,
    });

    if (result.success) {
      logger.info({ title, chatId, messageId: result.messageId }, 'Review request sent successfully');
      return {
        success: true,
        message: `✅ 审批请求已发送\n标题: ${title}\n主题: ${getThemeName(theme)}`,
        messageId: result.messageId,
      };
    }

    logger.warn({ title, chatId, error: result.message }, 'Failed to send review request');
    return {
      success: false,
      message: `⚠️ 发送审批请求失败: ${result.message}`,
    };
  } catch (error) {
    logger.error({ error, title, chatId }, 'Error sending review request');
    return {
      success: false,
      message: `❌ 发送审批请求出错: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Request a quick review (approve/reject only).
 *
 * @param params - Quick review parameters
 * @returns Result of the review request
 */
export async function quick_review(params: QuickReviewParams): Promise<RequestReviewResult> {
  const { title, message, chatId, theme = 'modern', parentMessageId } = params;

  logger.debug({ title, chatId, theme }, 'Requesting quick review');

  try {
    // Build the quick review card
    const card = buildQuickReviewCard(title, message, 'approve', 'reject', theme);

    // Generate action prompts
    const actionPrompts = buildReviewActionPrompts(title, theme);
    // Quick review only needs approve and reject
    const quickPrompts = {
      approve: actionPrompts.approve,
      reject: actionPrompts.reject,
    };

    // Send the interactive card
    const result: SendInteractiveResult = await send_interactive_message({
      card: card as unknown as Record<string, unknown>,
      actionPrompts: quickPrompts,
      chatId,
      parentMessageId,
    });

    if (result.success) {
      logger.info({ title, chatId, messageId: result.messageId }, 'Quick review request sent successfully');
      return {
        success: true,
        message: `✅ 快速审批请求已发送\n标题: ${title}`,
        messageId: result.messageId,
      };
    }

    logger.warn({ title, chatId, error: result.message }, 'Failed to send quick review request');
    return {
      success: false,
      message: `⚠️ 发送快速审批请求失败: ${result.message}`,
    };
  } catch (error) {
    logger.error({ error, title, chatId }, 'Error sending quick review request');
    return {
      success: false,
      message: `❌ 发送快速审批请求出错: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Request a batch review for multiple items.
 *
 * @param params - Batch review parameters
 * @returns Result of the review request
 */
export async function batch_review(params: BatchReviewParams): Promise<RequestReviewResult> {
  const { title, items, chatId, theme = 'modern', parentMessageId } = params;

  logger.debug({ title, chatId, theme, itemCount: items.length }, 'Requesting batch review');

  try {
    // Build the batch review card
    const card = buildBatchReviewCard(title, items, 'approve_all', 'reject_all', theme);

    // Generate action prompts
    const actionPrompts = buildReviewActionPrompts(title, theme);
    // Batch review only needs approve_all and reject_all
    const batchPrompts = {
      approve_all: actionPrompts.approve_all,
      reject_all: actionPrompts.reject_all,
    };

    // Send the interactive card
    const result: SendInteractiveResult = await send_interactive_message({
      card: card as unknown as Record<string, unknown>,
      actionPrompts: batchPrompts,
      chatId,
      parentMessageId,
    });

    if (result.success) {
      logger.info({ title, chatId, messageId: result.messageId, itemCount: items.length }, 'Batch review request sent successfully');
      return {
        success: true,
        message: `✅ 批量审批请求已发送\n标题: ${title}\n项目数: ${items.length}`,
        messageId: result.messageId,
      };
    }

    logger.warn({ title, chatId, error: result.message }, 'Failed to send batch review request');
    return {
      success: false,
      message: `⚠️ 发送批量审批请求失败: ${result.message}`,
    };
  } catch (error) {
    logger.error({ error, title, chatId }, 'Error sending batch review request');
    return {
      success: false,
      message: `❌ 发送批量审批请求出错: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Get theme display name.
 */
function getThemeName(theme: ReviewTheme): string {
  switch (theme) {
    case 'imperial':
      return '🏛️ 御书房';
    case 'modern':
      return '📋 审批中心';
    case 'minimal':
      return '简洁';
    default:
      return theme;
  }
}
