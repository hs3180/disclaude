/**
 * Request Review tool implementation.
 *
 * This tool provides the "御书房批奏折" (Imperial Study Review) experience
 * for AI task reviews. It sends beautifully formatted review cards with
 * quick action buttons for approve, reject, request changes, etc.
 *
 * Issue #946: AI 请求 review 时应提供御书房批奏折般的丝滑体验
 *
 * @module mcp/tools/request-review
 */

import { createLogger } from '../../utils/logger.js';
import { send_interactive_message } from './interactive-message.js';
import {
  buildReviewCard,
  buildQuickReviewCard,
  buildReviewCardWithDiff,
  buildBatchReviewCard,
  buildReviewActionPrompts,
  type ReviewCardConfig,
  type ChangeItem,
} from '../../platforms/feishu/card-builders/review-card-builder.js';
import type { RequestReviewResult, ReviewChangeItem } from './types.js';

const logger = createLogger('RequestReview');

/**
 * Convert API change item to internal change item format.
 */
function toChangeItem(item: ReviewChangeItem): ChangeItem {
  return {
    path: item.path,
    type: item.type,
    description: item.description,
    additions: item.additions,
    deletions: item.deletions,
  };
}

/**
 * Request user review with a structured review card.
 *
 * This tool provides the "御书房批奏折" experience for task reviews.
 * It sends a beautifully formatted card with quick action buttons.
 *
 * @example
 * ```typescript
 * // Basic review request
 * await request_review({
 *   title: '代码变更请求',
 *   summary: '修复了用户认证的 bug，增加了单元测试',
 *   chatId: 'oc_xxx',
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Review with changes (Imperial theme)
 * await request_review({
 *   title: '功能开发完成',
 *   summary: '实现了用户登录功能',
 *   theme: 'imperial',
 *   changes: [
 *     { path: 'src/auth.ts', type: 'modified', additions: 50, deletions: 10 },
 *     { path: 'tests/auth.test.ts', type: 'added', additions: 100 },
 *   ],
 *   context: 'PR #123',
 *   chatId: 'oc_xxx',
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Review with diff preview
 * await request_review({
 *   title: '代码审查',
 *   summary: '重构了数据库连接模块',
 *   diff: '--- a/db.ts\n+++ b/db.ts\n@@ -1,5 +1,10 @@',
 *   chatId: 'oc_xxx',
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Batch review
 * await request_review({
 *   title: '批量审批',
 *   items: [
 *     { name: 'PR #101', description: 'Fix login bug' },
 *     { name: 'PR #102', description: 'Add dark mode' },
 *   ],
 *   chatId: 'oc_xxx',
 * });
 * ```
 */
export async function request_review(params: {
  /** Review title/subject */
  title: string;
  /** Review summary/description */
  summary?: string;
  /** Theme to use: 'imperial' (御书房), 'modern' (现代), 'minimal' (简约) */
  theme?: 'imperial' | 'modern' | 'minimal';
  /** List of changes to display */
  changes?: ReviewChangeItem[];
  /** Diff content to display (for code reviews) */
  diff?: string;
  /** Maximum diff lines to show (default: 20) */
  maxDiffLines?: number;
  /** Items for batch review */
  items?: Array<{ name: string; description?: string }>;
  /** Context information (e.g., PR number, task name) */
  context?: string;
  /** Additional details */
  details?: string;
  /** Footer note */
  footerNote?: string;
  /** Target chat ID */
  chatId: string;
  /** Optional parent message ID for thread reply */
  parentMessageId?: string;
}): Promise<RequestReviewResult> {
  const {
    title,
    summary,
    theme = 'modern',
    changes,
    diff,
    maxDiffLines = 20,
    items,
    context,
    details,
    footerNote,
    chatId,
    parentMessageId,
  } = params;

  logger.info({
    chatId,
    title,
    theme,
    hasChanges: !!changes,
    hasDiff: !!diff,
    hasItems: !!items,
    itemCount: items?.length ?? 0,
  }, 'request_review called');

  try {
    // Validate required parameters
    if (!title || typeof title !== 'string') {
      return {
        success: false,
        error: 'title is required and must be a string',
        message: '❌ 标题不能为空',
      };
    }

    if (!chatId) {
      return {
        success: false,
        error: 'chatId is required',
        message: '❌ chatId 不能为空',
      };
    }

    // Determine review type and build appropriate card
    let card: Record<string, unknown>;
    let actionPrompts: Record<string, string>;

    if (items && items.length > 0) {
      // Batch review
      card = buildBatchReviewCard(
        title,
        items,
        'approve_all',
        'reject_all',
        theme
      ) as unknown as Record<string, unknown>;
      actionPrompts = {
        approve_all: `[用户操作] 用户批量批准：${title}。共 ${items.length} 项。请继续执行后续操作。`,
        reject_all: `[用户操作] 用户批量拒绝：${title}。请停止所有操作。`,
      };
    } else if (diff) {
      // Review with diff preview
      const config: ReviewCardConfig = {
        title,
        summary: summary || '',
        theme,
        changes: changes?.map(toChangeItem),
        details,
        footerNote,
        viewDetailsAction: 'view_details',
      };
      card = buildReviewCardWithDiff(config, diff, maxDiffLines) as unknown as Record<string, unknown>;
      actionPrompts = buildReviewActionPrompts(context || title, theme);
    } else {
      // Standard review card
      const config: ReviewCardConfig = {
        title,
        summary: summary || '',
        theme,
        changes: changes?.map(toChangeItem),
        details,
        footerNote,
        viewDetailsAction: 'view_details',
      };
      card = buildReviewCard(config) as unknown as Record<string, unknown>;
      actionPrompts = buildReviewActionPrompts(context || title, theme);
    }

    logger.debug({
      chatId,
      theme,
      actionKeys: Object.keys(actionPrompts),
    }, 'Built review card and action prompts');

    // Send the interactive message
    const result = await send_interactive_message({
      card,
      actionPrompts,
      chatId,
      parentMessageId,
    });

    if (result.success) {
      const themeName = theme === 'imperial' ? '御书房' :
                       theme === 'modern' ? '现代' : '简约';
      logger.info({
        chatId,
        messageId: result.messageId,
        theme,
      }, 'Review request sent successfully');

      return {
        success: true,
        message: `✅ 审批请求已发送 (${themeName}主题)，等待用户审核`,
        messageId: result.messageId,
      };
    } else {
      return {
        success: false,
        error: result.error,
        message: result.message || '❌ 发送审批请求失败',
      };
    }

  } catch (error) {
    logger.error({ err: error, chatId }, 'request_review failed');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      error: errorMessage,
      message: `❌ 发送审批请求失败: ${errorMessage}`,
    };
  }
}

/**
 * Quick review request with minimal parameters.
 *
 * Simplified version for simple approve/reject scenarios.
 *
 * @example
 * ```typescript
 * await quick_review({
 *   title: '确认操作',
 *   message: '是否继续执行？',
 *   chatId: 'oc_xxx',
 * });
 * ```
 */
export async function quick_review(params: {
  /** Review title */
  title: string;
  /** Review message */
  message: string;
  /** Theme to use */
  theme?: 'imperial' | 'modern' | 'minimal';
  /** Target chat ID */
  chatId: string;
  /** Optional parent message ID for thread reply */
  parentMessageId?: string;
}): Promise<RequestReviewResult> {
  const { title, message, theme = 'modern', chatId, parentMessageId } = params;

  logger.info({
    chatId,
    title,
    theme,
  }, 'quick_review called');

  try {
    if (!title || !message) {
      return {
        success: false,
        error: 'title and message are required',
        message: '❌ 标题和消息不能为空',
      };
    }

    if (!chatId) {
      return {
        success: false,
        error: 'chatId is required',
        message: '❌ chatId 不能为空',
      };
    }

    const card = buildQuickReviewCard(title, message, 'approve', 'reject', theme) as unknown as Record<string, unknown>;
    const actionPrompts = buildReviewActionPrompts(title, theme);

    const result = await send_interactive_message({
      card,
      actionPrompts,
      chatId,
      parentMessageId,
    });

    if (result.success) {
      return {
        success: true,
        message: '✅ 快速审批请求已发送',
        messageId: result.messageId,
      };
    } else {
      return {
        success: false,
        error: result.error,
        message: result.message || '❌ 发送审批请求失败',
      };
    }

  } catch (error) {
    logger.error({ err: error, chatId }, 'quick_review failed');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      error: errorMessage,
      message: `❌ 发送审批请求失败: ${errorMessage}`,
    };
  }
}
