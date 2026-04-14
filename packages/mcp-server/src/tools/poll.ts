/**
 * Poll/Survey tool implementation.
 *
 * Provides lightweight polling functionality using interactive cards.
 * Users can create polls, record votes via button clicks, and retrieve results.
 *
 * Issue #2191: Phase 1 — lightweight single-choice polls via card + callback.
 *
 * Architecture:
 * - `create_poll`: Saves poll definition to workspace/polls/{pollId}.json,
 *   sends an interactive card via send_interactive, and returns the pollId.
 * - `record_poll_vote`: Records a vote for a poll option in the poll file.
 *   Called by the agent when a poll action prompt is received.
 * - `get_poll_results`: Reads the poll file and returns aggregated vote counts.
 *
 * @module mcp-server/tools/poll
 */

import { createLogger } from '@disclaude/core';
import { getWorkspaceDir } from './credentials.js';
import { send_interactive } from './interactive-message.js';
import type { InteractiveOption, ActionPromptMap } from './types.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const logger = createLogger('Poll');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single poll option.
 */
export interface PollOption {
  /** Display text for the option */
  text: string;
  /** Unique value identifying the option */
  value: string;
}

/**
 * Poll data stored on disk.
 */
export interface PollData {
  /** Unique poll identifier */
  id: string;
  /** The poll question */
  question: string;
  /** Available options */
  options: PollOption[];
  /** Target chat ID where the poll was sent */
  chatId: string;
  /** ISO timestamp when the poll was created */
  createdAt: string;
  /** Optional deadline (ISO timestamp) */
  deadline?: string;
  /** Whether the poll is anonymous (always true in Phase 1) */
  anonymous: boolean;
  /** Vote counts keyed by option value */
  votes: Record<string, number>;
  /** Total number of votes */
  totalVotes: number;
}

/**
 * Result type for create_poll.
 */
export interface CreatePollResult {
  success: boolean;
  message: string;
  pollId?: string;
  error?: string;
}

/**
 * Result type for record_poll_vote.
 */
export interface RecordPollVoteResult {
  success: boolean;
  message: string;
  error?: string;
}

/**
 * Result type for get_poll_results.
 */
export interface GetPollResultsResult {
  success: boolean;
  message: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a unique poll ID.
 */
function generatePollId(): string {
  return `poll_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Get the directory where poll files are stored.
 */
function getPollsDir(): string {
  return join(getWorkspaceDir(), 'polls');
}

/**
 * Get the file path for a specific poll.
 */
function getPollFilePath(pollId: string): string {
  return join(getPollsDir(), `${pollId}.json`);
}

/**
 * Ensure the polls directory exists.
 */
function ensurePollsDir(): void {
  const dir = getPollsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Read a poll file from disk.
 */
function readPollFile(pollId: string): PollData | null {
  const filePath = getPollFilePath(pollId);
  try {
    const data = readFileSync(filePath, 'utf-8');
    return JSON.parse(data) as PollData;
  } catch {
    return null;
  }
}

/**
 * Write a poll file to disk.
 */
function writePollFile(poll: PollData): void {
  ensurePollsDir();
  const filePath = getPollFilePath(poll.id);
  writeFileSync(filePath, JSON.stringify(poll, null, 2), 'utf-8');
}

/**
 * Format poll results as a readable summary.
 */
function formatPollResults(poll: PollData): string {
  const {totalVotes} = poll;
  const lines: string[] = [];

  lines.push(`📊 **${poll.question}**`);
  lines.push(`投票ID: ${poll.id}`);
  lines.push(`创建时间: ${poll.createdAt}`);
  if (poll.deadline) {
    lines.push(`截止时间: ${poll.deadline}`);
  }
  lines.push(`总票数: ${totalVotes}`);
  lines.push('');
  lines.push('---');

  for (const option of poll.options) {
    const count = poll.votes[option.value] ?? 0;
    const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
    const bar = '█'.repeat(Math.max(1, Math.round(pct / 5))) + '░'.repeat(Math.max(0, 20 - Math.round(pct / 5)));
    lines.push(`**${option.text}**: ${count} 票 (${pct}%) \`${bar}\``);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tool: create_poll
// ---------------------------------------------------------------------------

/**
 * Create a poll and send it as an interactive card to the specified chat.
 *
 * The poll is saved to `workspace/polls/{pollId}.json`. An interactive card
 * with clickable option buttons is sent via `send_interactive`. When users
 * click an option, the agent receives an action prompt instructing it to call
 * `record_poll_vote` to save the response.
 *
 * @example
 * ```typescript
 * const result = await create_poll({
 *   question: "Which restaurant for lunch?",
 *   options: [
 *     { text: "🍜 Chinese", value: "chinese" },
 *     { text: "🍕 Pizza", value: "pizza" },
 *     { text: "🍱 Japanese", value: "japanese" },
 *   ],
 *   chatId: "oc_xxx",
 * });
 * ```
 */
export async function create_poll(params: {
  /** The poll question */
  question: string;
  /** Poll options */
  options: PollOption[];
  /** Target chat ID */
  chatId: string;
  /** Optional card title */
  title?: string;
  /** Optional deadline (ISO timestamp) */
  deadline?: string;
}): Promise<CreatePollResult> {
  const { question, options, chatId, title, deadline } = params;

  logger.info({ chatId, optionCount: options.length }, 'create_poll called');

  try {
    // Validate required parameters
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return {
        success: false,
        error: 'question is required and must be a non-empty string',
        message: '❌ question 参数不能为空',
      };
    }
    if (!Array.isArray(options) || options.length === 0) {
      return {
        success: false,
        error: 'options is required and must be a non-empty array',
        message: '❌ options 参数必须为非空数组',
      };
    }
    if (options.length > 10) {
      return {
        success: false,
        error: 'options cannot exceed 10 items',
        message: '❌ options 不能超过 10 个选项',
      };
    }
    if (!chatId || typeof chatId !== 'string') {
      return {
        success: false,
        error: 'chatId is required',
        message: '❌ chatId 参数不能为空',
      };
    }

    // Validate each option
    const seenValues = new Set<string>();
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      if (typeof opt.text !== 'string' || opt.text.trim().length === 0) {
        return {
          success: false,
          error: `options[${i}].text must be a non-empty string`,
          message: `❌ options[${i}].text 不能为空`,
        };
      }
      if (typeof opt.value !== 'string' || opt.value.trim().length === 0) {
        return {
          success: false,
          error: `options[${i}].value must be a non-empty string`,
          message: `❌ options[${i}].value 不能为空`,
        };
      }
      if (seenValues.has(opt.value)) {
        return {
          success: false,
          error: `options[${i}].value "${opt.value}" is duplicated`,
          message: `❌ options[${i}].value "${opt.value}" 重复`,
        };
      }
      seenValues.add(opt.value);
    }

    // Validate deadline if provided
    if (deadline) {
      const deadlineDate = new Date(deadline);
      if (isNaN(deadlineDate.getTime())) {
        return {
          success: false,
          error: 'deadline must be a valid ISO timestamp',
          message: '❌ deadline 必须是有效的 ISO 时间戳',
        };
      }
    }

    // Generate poll ID
    const pollId = generatePollId();

    // Initialize vote counts
    const votes: Record<string, number> = {};
    for (const opt of options) {
      votes[opt.value] = 0;
    }

    // Create poll data
    const pollData: PollData = {
      id: pollId,
      question,
      options,
      chatId,
      createdAt: new Date().toISOString(),
      deadline,
      anonymous: true,
      votes,
      totalVotes: 0,
    };

    // Save poll file
    ensurePollsDir();
    writePollFile(pollData);
    logger.info({ pollId, chatId }, 'Poll file saved');

    // Build action prompts that instruct the agent to record votes
    const actionPrompts: ActionPromptMap = {};
    for (const opt of options) {
      actionPrompts[opt.value] =
        `[用户操作] 用户在投票「${question}」中选择了「${opt.text}」。` +
        `请调用 record_poll_vote 工具记录此投票，参数: pollId="${pollId}", optionValue="${opt.value}"`;
    }

    // Build context line with poll info
    const deadlineStr = deadline ? `\n⏰ 截止: ${deadline}` : '';
    const contextStr = `📋 投票ID: ${pollId}${deadlineStr}\n请点击下方选项参与投票:`;

    // Send interactive card via send_interactive
    const interactiveOptions: InteractiveOption[] = options.map((opt, idx) => ({
      text: opt.text,
      value: opt.value,
      type: idx === 0 ? 'primary' as const : 'default' as const,
    }));

    const sendResult = await send_interactive({
      question: `**${question}**`,
      options: interactiveOptions,
      title: title ?? '📊 投票',
      context: contextStr,
      chatId,
      actionPrompts,
    });

    if (!sendResult.success) {
      // Clean up poll file since card wasn't sent
      try {
        const { unlinkSync } = await import('node:fs');
        unlinkSync(getPollFilePath(pollId));
      } catch {
        // Ignore cleanup errors
      }
      return {
        success: false,
        error: sendResult.error ?? 'Failed to send poll card',
        message: `❌ 投票卡片发送失败: ${sendResult.message}`,
      };
    }

    logger.info({ pollId, chatId }, 'Poll created and card sent');
    return {
      success: true,
      pollId,
      message: `✅ 投票已创建 (ID: ${pollId})，已发送到聊天。共 ${options.length} 个选项。`,
    };

  } catch (error) {
    logger.error({ err: error, chatId }, 'create_poll FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ 创建投票失败: ${errorMessage}` };
  }
}

// ---------------------------------------------------------------------------
// Tool: record_poll_vote
// ---------------------------------------------------------------------------

/**
 * Record a vote for a poll option.
 *
 * This tool is called by the agent when it receives a poll action prompt
 * (generated by `create_poll`). It increments the vote count for the
 * specified option in the poll file.
 *
 * @example
 * ```typescript
 * const result = await record_poll_vote({
 *   pollId: "poll_abc123",
 *   optionValue: "chinese",
 * });
 * ```
 */
export function record_poll_vote(params: {
  /** The poll ID */
  pollId: string;
  /** The option value to vote for */
  optionValue: string;
}): RecordPollVoteResult {
  const { pollId, optionValue } = params;

  logger.info({ pollId, optionValue }, 'record_poll_vote called');

  try {
    // Validate required parameters
    if (!pollId || typeof pollId !== 'string') {
      return {
        success: false,
        error: 'pollId is required',
        message: '❌ pollId 参数不能为空',
      };
    }
    if (!optionValue || typeof optionValue !== 'string') {
      return {
        success: false,
        error: 'optionValue is required',
        message: '❌ optionValue 参数不能为空',
      };
    }

    // Read poll file
    const poll = readPollFile(pollId);
    if (!poll) {
      return {
        success: false,
        error: `Poll not found: ${pollId}`,
        message: `❌ 投票不存在: ${pollId}`,
      };
    }

    // Validate option exists
    const option = poll.options.find(o => o.value === optionValue);
    if (!option) {
      return {
        success: false,
        error: `Invalid option "${optionValue}" for poll ${pollId}`,
        message: `❌ 无效选项 "${optionValue}"。可选: ${poll.options.map(o => o.text).join(', ')}`,
      };
    }

    // Check deadline
    if (poll.deadline) {
      const deadlineDate = new Date(poll.deadline);
      if (new Date() > deadlineDate) {
        return {
          success: false,
          error: `Poll ${pollId} has expired`,
          message: `❌ 投票已截止 (截止时间: ${poll.deadline})`,
        };
      }
    }

    // Record vote
    poll.votes[optionValue] = (poll.votes[optionValue] ?? 0) + 1;
    poll.totalVotes += 1;

    // Save updated poll file
    writePollFile(poll);
    logger.info({ pollId, optionValue, totalVotes: poll.totalVotes }, 'Vote recorded');

    return {
      success: true,
      message: `✅ 投票已记录: 「${option.text}」 (当前 ${poll.votes[optionValue]} 票，总计 ${poll.totalVotes} 票)`,
    };

  } catch (error) {
    logger.error({ err: error, pollId, optionValue }, 'record_poll_vote FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ 记录投票失败: ${errorMessage}` };
  }
}

// ---------------------------------------------------------------------------
// Tool: get_poll_results
// ---------------------------------------------------------------------------

/**
 * Get the results of a poll.
 *
 * Reads the poll file and returns a formatted summary with vote counts
 * and percentages for each option.
 *
 * @example
 * ```typescript
 * const result = await get_poll_results({
 *   pollId: "poll_abc123",
 * });
 * ```
 */
export function get_poll_results(params: {
  /** The poll ID */
  pollId: string;
}): GetPollResultsResult {
  const { pollId } = params;

  logger.info({ pollId }, 'get_poll_results called');

  try {
    // Validate required parameters
    if (!pollId || typeof pollId !== 'string') {
      return {
        success: false,
        error: 'pollId is required',
        message: '❌ pollId 参数不能为空',
      };
    }

    // Read poll file
    const poll = readPollFile(pollId);
    if (!poll) {
      return {
        success: false,
        error: `Poll not found: ${pollId}`,
        message: `❌ 投票不存在: ${pollId}`,
      };
    }

    const results = formatPollResults(poll);
    return {
      success: true,
      message: results,
    };

  } catch (error) {
    logger.error({ err: error, pollId }, 'get_poll_results FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ 获取投票结果失败: ${errorMessage}` };
  }
}
