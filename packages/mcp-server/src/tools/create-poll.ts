/**
 * create_poll MCP tool implementation.
 *
 * Creates a lightweight poll and sends it as an interactive card.
 * Uses the existing send_interactive mechanism for card delivery.
 *
 * Issue #2191: 方案 C — 内置轻量调查 (卡片+回调)
 *
 * @module mcp-server/tools/create-poll
 */

import { createLogger, PollManager } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import { getMessageSentCallback } from './callback-manager.js';

const logger = createLogger('CreatePoll');

/** Singleton PollManager instance */
let pollManager: PollManager | undefined;

/**
 * Get or create the PollManager singleton.
 */
function getPollManager(): PollManager {
  if (!pollManager) {
    pollManager = new PollManager();
  }
  return pollManager;
}

/**
 * Result type for create_poll tool.
 */
export interface CreatePollResult {
  success: boolean;
  message: string;
  pollId?: string;
  error?: string;
}

/**
 * Result type for record_poll_vote tool.
 */
export interface RecordPollVoteResult {
  success: boolean;
  message: string;
  error?: string;
}

/**
 * Result type for poll_results tool.
 */
export interface PollResultsResult {
  success: boolean;
  message: string;
  results?: string;
  error?: string;
}

/**
 * Create a new poll and send it as an interactive card.
 *
 * @example
 * ```typescript
 * await create_poll({
 *   question: "What's your favorite programming language?",
 *   options: [
 *     { text: "TypeScript" },
 *     { text: "Python" },
 *     { text: "Go" },
 *   ],
 *   chatId: "oc_xxx",
 *   anonymous: true,
 * });
 * ```
 */
export async function create_poll(params: {
  /** The poll question */
  question: string;
  /** Poll options (at least 2 required) */
  options: Array<{ text: string }>;
  /** Target chat ID */
  chatId: string;
  /** Whether votes are anonymous (default: true) */
  anonymous?: boolean;
  /** Optional ISO timestamp for poll expiry */
  expiresAt?: string;
  /** Optional poll description */
  description?: string;
}): Promise<CreatePollResult> {
  const { question, options, chatId } = params;

  logger.info({ chatId, optionCount: options?.length ?? 0 }, 'create_poll called');

  try {
    // Validate required parameters
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return {
        success: false,
        error: 'question is required and must be a non-empty string',
        message: '❌ question 参数不能为空',
      };
    }
    if (!Array.isArray(options) || options.length < 2) {
      return {
        success: false,
        error: 'options must be an array with at least 2 items',
        message: '❌ options 至少需要 2 个选项',
      };
    }
    if (!chatId || typeof chatId !== 'string') {
      return {
        success: false,
        error: 'chatId is required',
        message: '❌ chatId 参数不能为空',
      };
    }

    // Check IPC availability
    if (!(await isIpcAvailable())) {
      const errorMsg = 'IPC service unavailable. Please ensure Primary Node is running.';
      logger.error({ chatId }, errorMsg);
      return {
        success: false,
        error: errorMsg,
        message: '❌ IPC 服务不可用。请检查 Primary Node 服务是否正在运行。',
      };
    }

    // Create the poll
    const pm = getPollManager();
    const poll = await pm.createPoll({
      question,
      options,
      chatId,
      anonymous: params.anonymous,
      expiresAt: params.expiresAt,
    });

    // Generate action prompts for vote recording
    const actionPrompts = pm.generateActionPrompts(poll);

    // Build interactive card options (include a "View Results" button)
    const interactiveOptions = [
      ...poll.options.map(opt => ({
        text: opt.text,
        value: opt.id,
        type: 'default' as const,
      })),
      { text: '📊 查看结果', value: 'poll_view_results', type: 'primary' as const },
    ];

    // Send interactive card via IPC
    const { getIpcClient } = await import('@disclaude/core');
    const ipcClient = getIpcClient();
    const result = await ipcClient.sendInteractive(chatId, {
      question: params.description
        ? `${params.description}\n\n${poll.question}`
        : `📊 **投票**: ${poll.question}`,
      options: interactiveOptions,
      title: '投票',
      actionPrompts,
    });

    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ chatId, errorType: result.errorType, error: result.error }, 'sendInteractive IPC failed');
      return {
        success: false,
        error: result.error ?? 'Failed to send poll card via IPC',
        message: `❌ 投票卡片发送失败: ${errorMsg}`,
      };
    }

    // Invoke message sent callback
    const callback = getMessageSentCallback();
    if (callback) {
      try {
        callback(chatId);
      } catch (error) {
        logger.error({ err: error }, 'Failed to invoke message sent callback');
      }
    }

    const expiryInfo = poll.expiresAt
      ? `\n⏰ 截止时间: ${new Date(poll.expiresAt).toLocaleString('zh-CN')}`
      : '';
    const anonInfo = poll.anonymous ? '\n🔒 匿名投票' : '';

    return {
      success: true,
      pollId: poll.id,
      message: [
        `✅ 投票已创建并发送 (ID: ${poll.id})`,
        `📋 问题: ${poll.question}`,
        `🔢 选项数: ${poll.options.length}`,
        `👥 投票: ${poll.anonymous ? '匿名' : '公开'}`,
        expiryInfo || '',
        anonInfo || '',
        '\n用户投票后，系统会自动记录。使用 poll_results 工具可查看实时结果。',
      ].filter(Boolean).join('\n'),
    };
  } catch (error) {
    logger.error({ err: error, chatId }, 'create_poll FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ 创建投票失败: ${errorMessage}` };
  }
}

/**
 * Record a vote for a poll.
 *
 * Called by the agent when it receives a vote notification via actionPrompts.
 *
 * @example
 * ```typescript
 * await record_poll_vote({
 *   pollId: "poll_abc123",
 *   optionId: "option_0",
 *   voterId: "ou_xxx",
 * });
 * ```
 */
export async function record_poll_vote(params: {
  /** Poll ID */
  pollId: string;
  /** Option ID that was voted for */
  optionId: string;
  /** Voter identifier (open_id) */
  voterId: string;
}): Promise<RecordPollVoteResult> {
  const { pollId, optionId, voterId } = params;

  logger.info({ pollId, optionId }, 'record_poll_vote called');

  try {
    if (!pollId || !optionId || !voterId) {
      return {
        success: false,
        error: 'pollId, optionId, and voterId are required',
        message: '❌ 缺少必要参数',
      };
    }

    const pm = getPollManager();
    const updatedPoll = await pm.recordVote({ pollId, optionId, voterId });

    const votedOption = updatedPoll.options.find(o => o.id === optionId);
    const totalVotes = updatedPoll.votes.length;

    return {
      success: true,
      message: `✅ 投票已记录: 用户选择了「${votedOption?.text || optionId}」(当前共 ${totalVotes} 票)`,
    };
  } catch (error) {
    logger.error({ err: error, pollId }, 'record_poll_vote FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ 记录投票失败: ${errorMessage}` };
  }
}

/**
 * Get formatted results for a poll.
 *
 * @example
 * ```typescript
 * const result = await poll_results({ pollId: "poll_abc123" });
 * ```
 */
export async function poll_results(params: {
  /** Poll ID to get results for */
  pollId: string;
}): Promise<PollResultsResult> {
  const { pollId } = params;

  logger.info({ pollId }, 'poll_results called');

  try {
    if (!pollId) {
      return {
        success: false,
        error: 'pollId is required',
        message: '❌ pollId 参数不能为空',
      };
    }

    const pm = getPollManager();
    const results = await pm.getPollResults(pollId);

    if (!results) {
      return {
        success: false,
        error: `Poll not found: ${pollId}`,
        message: `❌ 投票不存在: ${pollId}`,
      };
    }

    const formattedText = pm.formatResultsText(results);

    return {
      success: true,
      results: formattedText,
      message: formattedText,
    };
  } catch (error) {
    logger.error({ err: error, pollId }, 'poll_results FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ 获取投票结果失败: ${errorMessage}` };
  }
}
