/**
 * Survey/Poll tools implementation.
 *
 * Provides lightweight poll creation and result aggregation using the
 * existing interactive card mechanism. Polls are stored as JSON files
 * in workspace/surveys/ for persistence.
 *
 * Issue #2191: Survey/Polling feature (Phase 1 — single-question polls).
 *
 * @module mcp-server/tools/survey
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { createLogger } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import { getMessageSentCallback } from './callback-manager.js';

const logger = createLogger('SurveyTools');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PollOption {
  /** Display text shown on the button */
  text: string;
  /** Internal value used for tracking */
  value: string;
}

export interface PollEntry {
  /** Unique poll ID */
  id: string;
  /** Question text */
  question: string;
  /** Available options */
  options: PollOption[];
  /** Chat ID where the poll was sent */
  chatId: string;
  /** Optional card title */
  title?: string;
  /** Optional card context */
  context?: string;
  /** Whether votes are anonymous (default: false) */
  anonymous: boolean;
  /** ISO timestamp when poll was created */
  createdAt: string;
  /** Optional deadline (ISO timestamp) */
  deadline?: string;
  /** Recorded votes: userId → optionValue */
  votes: Record<string, string>;
  /** Status of the poll */
  status: 'open' | 'closed';
}

export interface CreatePollResult {
  success: boolean;
  message: string;
  pollId?: string;
  error?: string;
}

export interface RecordVoteResult {
  success: boolean;
  message: string;
  error?: string;
}

export interface GetPollResultsResult {
  success: boolean;
  message: string;
  poll?: PollEntry;
  summary?: PollSummary;
  error?: string;
}

export interface PollSummary {
  pollId: string;
  question: string;
  status: 'open' | 'closed';
  totalVotes: number;
  results: Array<{
    option: string;
    value: string;
    count: number;
    percentage: string;
  }>;
  voters?: string[];
}

// ---------------------------------------------------------------------------
// Constants & Helpers
// ---------------------------------------------------------------------------

const SURVEY_DIR = 'workspace/surveys';
const MAX_QUESTION_LENGTH = 500;
const MAX_OPTIONS = 10;
const MAX_OPTION_TEXT_LENGTH = 100;
const MAX_POLL_ID_LENGTH = 64;

function getSurveyDir(): string {
  const workspaceDir = process.env.WORKSPACE_DIR ?? process.cwd();
  return join(workspaceDir, SURVEY_DIR);
}

function getPollFilePath(pollId: string): string {
  return join(getSurveyDir(), `${pollId}.json`);
}

function validatePollId(pollId: string): string | null {
  if (!pollId || typeof pollId !== 'string') {
    return 'pollId is required';
  }
  if (pollId.length > MAX_POLL_ID_LENGTH) {
    return `pollId too long (max ${MAX_POLL_ID_LENGTH} chars)`;
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(pollId)) {
    return 'pollId must contain only alphanumeric chars, hyphens, and underscores';
  }
  return null;
}

/**
 * Generate action prompts for poll options.
 * Each option's prompt instructs the agent to record the vote.
 */
function generatePollActionPrompts(pollId: string, options: PollOption[]): Record<string, string> {
  const prompts: Record<string, string> = {};
  for (const opt of options) {
    prompts[opt.value] = `[投票回应] 用户在投票中选择了"${opt.text}"。请立即调用 record_poll_vote 工具记录此投票，参数: { "pollId": "${pollId}", "optionValue": "${opt.value}", "userId": "从消息中获取用户ID" }。`;
  }
  return prompts;
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function ensureSurveyDir(): void {
  const dir = getSurveyDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function savePoll(poll: PollEntry): void {
  ensureSurveyDir();
  const filePath = getPollFilePath(poll.id);
  writeFileSync(filePath, JSON.stringify(poll, null, 2), 'utf-8');
  logger.debug({ pollId: poll.id }, 'Poll saved');
}

function loadPoll(pollId: string): PollEntry | null {
  const filePath = getPollFilePath(pollId);
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as PollEntry;
  } catch (error) {
    logger.error({ err: error, pollId }, 'Failed to load poll file');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tool: create_poll
// ---------------------------------------------------------------------------

/**
 * Create a poll and send it as an interactive card.
 *
 * The poll is persisted to `workspace/surveys/{pollId}.json`.
 * An interactive card is sent to the target chat via IPC with
 * action prompts that instruct the agent to record votes when
 * users click options.
 */
export async function create_poll(params: {
  /** The poll question */
  question: string;
  /** Available options (2-10) */
  options: PollOption[];
  /** Target chat ID */
  chatId: string;
  /** Optional card title */
  title?: string;
  /** Optional context shown above the question */
  context?: string;
  /** Whether votes are anonymous (default: false) */
  anonymous?: boolean;
  /** Optional deadline (ISO timestamp) */
  deadline?: string;
}): Promise<CreatePollResult> {
  const { question, options, chatId } = params;

  logger.info({ chatId, optionCount: options?.length ?? 0 }, 'create_poll called');

  // Validate required parameters
  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    return {
      success: false,
      error: 'question is required and must be a non-empty string',
      message: '❌ question 参数不能为空',
    };
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return {
      success: false,
      error: `question too long (max ${MAX_QUESTION_LENGTH} chars)`,
      message: `❌ question 过长（最多 ${MAX_QUESTION_LENGTH} 字符）`,
    };
  }
  if (!Array.isArray(options) || options.length < 2) {
    return {
      success: false,
      error: 'options must be an array with at least 2 items',
      message: '❌ options 必须包含至少 2 个选项',
    };
  }
  if (options.length > MAX_OPTIONS) {
    return {
      success: false,
      error: `too many options (max ${MAX_OPTIONS})`,
      message: `❌ options 最多 ${MAX_OPTIONS} 个`,
    };
  }
  if (!chatId || typeof chatId !== 'string') {
    return {
      success: false,
      error: 'chatId is required',
      message: '❌ chatId 参数不能为空',
    };
  }

  // Validate options structure
  const seenValues = new Set<string>();
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    if (!opt.text || typeof opt.text !== 'string' || opt.text.trim().length === 0) {
      return {
        success: false,
        error: `options[${i}].text must be a non-empty string`,
        message: `❌ options[${i}].text 不能为空`,
      };
    }
    if (opt.text.length > MAX_OPTION_TEXT_LENGTH) {
      return {
        success: false,
        error: `options[${i}].text too long (max ${MAX_OPTION_TEXT_LENGTH} chars)`,
        message: `❌ options[${i}].text 过长（最多 ${MAX_OPTION_TEXT_LENGTH} 字符）`,
      };
    }
    if (!opt.value || typeof opt.value !== 'string' || opt.value.trim().length === 0) {
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
  if (params.deadline) {
    const deadlineDate = new Date(params.deadline);
    if (isNaN(deadlineDate.getTime())) {
      return {
        success: false,
        error: 'deadline must be a valid ISO timestamp',
        message: '❌ deadline 格式无效（需为 ISO 时间戳）',
      };
    }
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

  // Generate poll ID
  const pollId = `poll-${Date.now()}-${randomUUID().slice(0, 8)}`;

  // Create poll entry
  const poll: PollEntry = {
    id: pollId,
    question: question.trim(),
    options: options.map(o => ({ text: o.text.trim(), value: o.value.trim() })),
    chatId,
    title: params.title,
    context: params.context,
    anonymous: params.anonymous ?? false,
    createdAt: new Date().toISOString(),
    deadline: params.deadline,
    votes: {},
    status: 'open',
  };

  // Save poll before sending card
  try {
    savePoll(poll);
  } catch (error) {
    logger.error({ err: error, pollId }, 'Failed to save poll');
    return {
      success: false,
      error: 'Failed to save poll state',
      message: `❌ 投票状态保存失败: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }

  // Send interactive card with poll options
  try {
    const { getIpcClient } = await import('@disclaude/core');
    const ipcClient = getIpcClient();

    const actionPrompts = generatePollActionPrompts(pollId, poll.options);

    // Build context string with poll metadata
    const cardContext = params.context
      ? `${params.context}\n\n📊 投票ID: ${pollId}${poll.anonymous ? ' | 🔒 匿名投票' : ''}${poll.deadline ? ` | ⏰ 截止: ${poll.deadline}` : ''}`
      : `📊 投票ID: ${pollId}${poll.anonymous ? ' | 🔒 匿名投票' : ''}${poll.deadline ? ` | ⏰ 截止: ${poll.deadline}` : ''}`;

    const result = await ipcClient.sendInteractive(chatId, {
      question: question.trim(),
      options: poll.options.map(o => ({
        text: o.text,
        value: o.value,
        type: 'default' as const,
      })),
      title: params.title ?? '📊 投票',
      context: cardContext,
      actionPrompts,
    });

    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ chatId, errorType: result.errorType, error: result.error }, 'sendInteractive IPC failed');
      return {
        success: false,
        error: result.error ?? 'Failed to send poll card via IPC',
        message: errorMsg,
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

    return {
      success: true,
      pollId,
      message: `✅ 投票创建成功！\n📊 投票ID: ${pollId}\n❓ 问题: ${question.trim()}\n📝 选项: ${poll.options.map(o => o.text).join(', ')}\n${poll.anonymous ? '🔒 匿名投票\n' : ''}${poll.deadline ? `⏰ 截止时间: ${poll.deadline}\n` : ''}已发送到聊天 ${chatId}`,
    };
  } catch (error) {
    logger.error({ err: error, chatId, pollId }, 'create_poll FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      error: errorMessage,
      message: `❌ 创建投票失败: ${errorMessage}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: record_poll_vote
// ---------------------------------------------------------------------------

/**
 * Record a vote for a poll.
 *
 * If the user has already voted, their previous vote is replaced
 * (allowing users to change their mind). If the poll is closed or
 * past its deadline, the vote is rejected.
 */
export function record_poll_vote(params: {
  /** Poll ID to vote on */
  pollId: string;
  /** The option value being voted for */
  optionValue: string;
  /** The user ID of the voter */
  userId: string;
}): RecordVoteResult {
  const { pollId, optionValue, userId } = params;

  logger.info({ pollId, optionValue, userId }, 'record_poll_vote called');

  // Validate parameters
  const pollIdError = validatePollId(pollId);
  if (pollIdError) {
    return {
      success: false,
      error: pollIdError,
      message: `❌ ${pollIdError}`,
    };
  }
  if (!optionValue || typeof optionValue !== 'string') {
    return {
      success: false,
      error: 'optionValue is required',
      message: '❌ optionValue 参数不能为空',
    };
  }
  if (!userId || typeof userId !== 'string') {
    return {
      success: false,
      error: 'userId is required',
      message: '❌ userId 参数不能为空',
    };
  }

  // Load poll
  const poll = loadPoll(pollId);
  if (!poll) {
    return {
      success: false,
      error: `Poll "${pollId}" not found`,
      message: `❌ 投票 "${pollId}" 不存在`,
    };
  }

  // Check if poll is closed
  if (poll.status === 'closed') {
    return {
      success: false,
      error: 'Poll is closed',
      message: '❌ 投票已关闭，无法继续投票',
    };
  }

  // Check deadline
  if (poll.deadline) {
    const deadlineDate = new Date(poll.deadline);
    if (new Date() > deadlineDate) {
      // Auto-close the poll
      poll.status = 'closed';
      savePoll(poll);
      return {
        success: false,
        error: 'Poll deadline has passed',
        message: `❌ 投票已过截止时间 (${poll.deadline})`,
      };
    }
  }

  // Validate option value
  const option = poll.options.find(o => o.value === optionValue);
  if (!option) {
    const validOptions = poll.options.map(o => o.value).join(', ');
    return {
      success: false,
      error: `Invalid optionValue "${optionValue}". Valid: ${validOptions}`,
      message: `❌ 无效的选项 "${optionValue}"。有效选项: ${poll.options.map(o => o.text).join(', ')}`,
    };
  }

  // Check if user already voted (vote changing)
  const previousVote = poll.votes[userId];
  const isChanging = previousVote !== undefined;

  // Record vote
  poll.votes[userId] = optionValue;
  savePoll(poll);

  const totalVotes = Object.keys(poll.votes).length;
  const voteMsg = isChanging
    ? `✅ 投票已更新！${poll.anonymous ? '' : `用户 ${userId} `}将投票从 "${previousVote}" 改为 "${option.text}"`
    : `✅ 投票已记录！${poll.anonymous ? '' : `用户 ${userId} `}选择了 "${option.text}"`;

  return {
    success: true,
    message: `${voteMsg}\n📊 投票 "${poll.question}" — 当前共 ${totalVotes} 票`,
  };
}

// ---------------------------------------------------------------------------
// Tool: get_poll_results
// ---------------------------------------------------------------------------

/**
 * Get aggregated results for a poll.
 *
 * Returns vote counts and percentages for each option.
 * If the poll is not anonymous, voter details are included.
 */
export function get_poll_results(params: {
  /** Poll ID to query */
  pollId: string;
}): GetPollResultsResult {
  const { pollId } = params;

  logger.info({ pollId }, 'get_poll_results called');

  // Validate
  const pollIdError = validatePollId(pollId);
  if (pollIdError) {
    return {
      success: false,
      error: pollIdError,
      message: `❌ ${pollIdError}`,
    };
  }

  // Load poll
  const poll = loadPoll(pollId);
  if (!poll) {
    return {
      success: false,
      error: `Poll "${pollId}" not found`,
      message: `❌ 投票 "${pollId}" 不存在`,
    };
  }

  // Calculate results
  const totalVotes = Object.keys(poll.votes).length;
  const results = poll.options.map(opt => {
    const count = Object.values(poll.votes).filter(v => v === opt.value).length;
    const percentage = totalVotes > 0 ? ((count / totalVotes) * 100).toFixed(1) : '0.0';
    return {
      option: opt.text,
      value: opt.value,
      count,
      percentage: `${percentage}%`,
    };
  });

  const summary: PollSummary = {
    pollId: poll.id,
    question: poll.question,
    status: poll.status,
    totalVotes,
    results,
    voters: poll.anonymous ? undefined : Object.keys(poll.votes),
  };

  // Build readable message
  const resultLines = results.map(r =>
    `  ${r.option}: ${r.count} 票 (${r.percentage})`
  ).join('\n');

  const message = [
    `📊 投票结果: "${poll.question}"`,
    `状态: ${poll.status === 'open' ? '🟢 进行中' : '🔴 已关闭'}`,
    `总票数: ${totalVotes}`,
    poll.deadline ? `截止时间: ${poll.deadline}` : null,
    '',
    '选项结果:',
    resultLines,
  ].filter(Boolean).join('\n');

  return {
    success: true,
    message,
    poll,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Tool: close_poll
// ---------------------------------------------------------------------------

/**
 * Close a poll, preventing further votes.
 */
export function close_poll(params: {
  /** Poll ID to close */
  pollId: string;
}): RecordVoteResult {
  const { pollId } = params;

  logger.info({ pollId }, 'close_poll called');

  const pollIdError = validatePollId(pollId);
  if (pollIdError) {
    return {
      success: false,
      error: pollIdError,
      message: `❌ ${pollIdError}`,
    };
  }

  const poll = loadPoll(pollId);
  if (!poll) {
    return {
      success: false,
      error: `Poll "${pollId}" not found`,
      message: `❌ 投票 "${pollId}" 不存在`,
    };
  }

  if (poll.status === 'closed') {
    return {
      success: false,
      error: 'Poll is already closed',
      message: '❌ 投票已经关闭',
    };
  }

  poll.status = 'closed';
  savePoll(poll);

  return {
    success: true,
    message: `✅ 投票 "${poll.question}" 已关闭。共 ${Object.keys(poll.votes).length} 票。`,
  };
}

// ---------------------------------------------------------------------------
// Utility: list_polls
// ---------------------------------------------------------------------------

/**
 * List all polls, optionally filtered by status.
 */
export function list_polls(params?: {
  /** Filter by status */
  status?: 'open' | 'closed';
}): GetPollResultsResult & { polls?: Array<{ id: string; question: string; status: string; totalVotes: number }> } {
  const statusFilter = params?.status;

  ensureSurveyDir();
  const dir = getSurveyDir();
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    files = [];
  }

  const polls: Array<{ id: string; question: string; status: string; totalVotes: number }> = [];

  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), 'utf-8');
      const poll = JSON.parse(raw) as PollEntry;
      if (statusFilter && poll.status !== statusFilter) { continue; }
      polls.push({
        id: poll.id,
        question: poll.question,
        status: poll.status,
        totalVotes: Object.keys(poll.votes).length,
      });
    } catch {
      // Skip invalid files
    }
  }

  if (polls.length === 0) {
    return {
      success: true,
      message: statusFilter
        ? `没有${statusFilter === 'open' ? '进行中' : '已关闭'}的投票`
        : '暂无投票',
    };
  }

  const lines = polls.map(p =>
    `  📊 ${p.id} — "${p.question}" (${p.status === 'open' ? '🟢 进行中' : '🔴 已关闭'}, ${p.totalVotes} 票)`
  ).join('\n');

  return {
    success: true,
    message: `共 ${polls.length} 个投票:\n${lines}`,
    polls,
  };
}
