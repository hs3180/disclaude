/**
 * PollManager - Manages poll lifecycle, vote recording, and result aggregation.
 *
 * Implements lightweight poll/survey functionality (Issue #2191, 方案 C).
 * Provides file-based persistence so poll state survives process restarts.
 *
 * @module core/polling/poll-manager
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { createLogger } from '../utils/logger.js';
import { Config } from '../config/index.js';
import type {
  Poll,
  PollVote,
  PollOptionResult,
  PollResults,
  CreatePollOptions,
  RecordVoteOptions,
  PollValidationError,
} from './types.js';

const logger = createLogger('PollManager');

/** Directory name for poll storage */
const POLLS_DIR = 'polls';

/** Maximum number of options per poll */
const MAX_OPTIONS = 20;

/** Maximum question length */
const MAX_QUESTION_LENGTH = 500;

/** Maximum option text length */
const MAX_OPTION_LENGTH = 100;

/**
 * Generate a unique poll ID.
 */
function generatePollId(): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(4).toString('hex');
  return `poll_${timestamp}_${random}`;
}

/**
 * Generate an anonymous voter ID from the original voter ID.
 */
function anonymizeVoterId(voterId: string, pollId: string): string {
  return crypto.createHash('sha256')
    .update(`${pollId}:${voterId}`)
    .digest('hex')
    .slice(0, 12);
}

/**
 * PollManager - manages poll lifecycle with file-based persistence.
 */
export class PollManager {
  private readonly pollsDir: string;
  private readonly cache = new Map<string, Poll>();
  private initialized = false;

  constructor(pollsDir?: string) {
    if (pollsDir) {
      this.pollsDir = pollsDir;
    } else {
      this.pollsDir = path.join(Config.getWorkspaceDir(), POLLS_DIR);
    }
  }

  /**
   * Ensure the polls directory exists.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {return;}
    await fs.mkdir(this.pollsDir, { recursive: true });
    this.initialized = true;
  }

  /**
   * Get the file path for a poll.
   */
  private getPollFilePath(pollId: string): string {
    return path.join(this.pollsDir, `${pollId}.json`);
  }

  /**
   * Validate poll creation options.
   */
  validateCreatePoll(options: CreatePollOptions): PollValidationError | { valid: true } {
    if (!options.question || typeof options.question !== 'string' || options.question.trim().length === 0) {
      return { valid: false, error: 'Question must be a non-empty string' };
    }
    if (options.question.length > MAX_QUESTION_LENGTH) {
      return { valid: false, error: `Question must not exceed ${MAX_QUESTION_LENGTH} characters` };
    }
    if (!Array.isArray(options.options) || options.options.length < 2) {
      return { valid: false, error: 'At least 2 options are required' };
    }
    if (options.options.length > MAX_OPTIONS) {
      return { valid: false, error: `Maximum ${MAX_OPTIONS} options allowed` };
    }
    for (let i = 0; i < options.options.length; i++) {
      const opt = options.options[i];
      if (!opt.text || typeof opt.text !== 'string' || opt.text.trim().length === 0) {
        return { valid: false, error: `Option ${i + 1} must have non-empty text` };
      }
      if (opt.text.length > MAX_OPTION_LENGTH) {
        return { valid: false, error: `Option ${i + 1} must not exceed ${MAX_OPTION_LENGTH} characters` };
      }
    }
    // Check for duplicate option texts
    const texts = options.options.map(o => o.text.trim().toLowerCase());
    const uniqueTexts = new Set(texts);
    if (uniqueTexts.size !== texts.length) {
      return { valid: false, error: 'Duplicate options are not allowed' };
    }
    if (!options.chatId || typeof options.chatId !== 'string') {
      return { valid: false, error: 'chatId is required' };
    }
    if (options.expiresAt) {
      const expiresAt = new Date(options.expiresAt);
      if (isNaN(expiresAt.getTime())) {
        return { valid: false, error: 'expiresAt must be a valid ISO timestamp' };
      }
      if (expiresAt <= new Date()) {
        return { valid: false, error: 'expiresAt must be in the future' };
      }
    }
    return { valid: true };
  }

  /**
   * Create a new poll.
   *
   * @returns The created poll with its ID
   */
  async createPoll(options: CreatePollOptions): Promise<Poll> {
    await this.ensureInitialized();

    const validation = this.validateCreatePoll(options);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const pollId = generatePollId();
    const now = new Date().toISOString();

    const poll: Poll = {
      id: pollId,
      question: options.question.trim(),
      options: options.options.map((opt, i) => ({
        id: `option_${i}`,
        text: opt.text.trim(),
      })),
      votes: [],
      chatId: options.chatId,
      createdAt: now,
      expiresAt: options.expiresAt,
      anonymous: options.anonymous !== false, // default true
      closed: false,
      creatorId: options.creatorId,
      description: options.description?.trim(),
    };

    // Persist to file
    const filePath = this.getPollFilePath(pollId);
    await fs.writeFile(filePath, JSON.stringify(poll, null, 2), 'utf-8');

    // Update cache
    this.cache.set(pollId, poll);

    logger.info({ pollId, chatId: options.chatId, optionCount: poll.options.length }, 'Poll created');
    return poll;
  }

  /**
   * Validate vote recording options.
   */
  validateRecordVote(
    poll: Poll,
    options: RecordVoteOptions
  ): PollValidationError | { valid: true } {
    if (poll.closed) {
      return { valid: false, error: 'Poll is closed' };
    }
    if (poll.expiresAt && new Date(poll.expiresAt) <= new Date()) {
      return { valid: false, error: 'Poll has expired' };
    }
    const optionExists = poll.options.some(o => o.id === options.optionId);
    if (!optionExists) {
      return { valid: false, error: `Invalid option ID: ${options.optionId}` };
    }
    return { valid: true };
  }

  /**
   * Record a vote for a poll.
   *
   * Each voter can only vote once per poll (subsequent votes update the previous choice).
   *
   * @returns Updated poll
   */
  async recordVote(options: RecordVoteOptions): Promise<Poll> {
    await this.ensureInitialized();

    const poll = await this.getPoll(options.pollId);
    if (!poll) {
      throw new Error(`Poll not found: ${options.pollId}`);
    }

    const validation = this.validateRecordVote(poll, options);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    // Anonymize voter ID if needed (must be done before checking existing votes)
    const effectiveVoterId = poll.anonymous
      ? anonymizeVoterId(options.voterId, poll.id)
      : options.voterId;

    // Check if voter already voted
    const existingVoteIndex = poll.votes.findIndex(v => v.voterId === effectiveVoterId);

    const vote: PollVote = {
      voterId: effectiveVoterId,
      optionId: options.optionId,
      votedAt: new Date().toISOString(),
    };

    if (existingVoteIndex >= 0) {
      // Update existing vote
      poll.votes[existingVoteIndex] = vote;
      logger.debug({ pollId: poll.id, voterId: effectiveVoterId }, 'Vote updated');
    } else {
      // Add new vote
      poll.votes.push(vote);
      logger.debug({ pollId: poll.id, voterId: effectiveVoterId }, 'Vote recorded');
    }

    // Persist updated poll
    const filePath = this.getPollFilePath(poll.id);
    await fs.writeFile(filePath, JSON.stringify(poll, null, 2), 'utf-8');

    // Update cache
    this.cache.set(poll.id, poll);

    return poll;
  }

  /**
   * Get a poll by ID.
   *
   * @returns The poll, or undefined if not found
   */
  async getPoll(pollId: string): Promise<Poll | undefined> {
    // Check cache first
    const cached = this.cache.get(pollId);
    if (cached) {return cached;}

    await this.ensureInitialized();

    try {
      const filePath = this.getPollFilePath(pollId);
      const data = await fs.readFile(filePath, 'utf-8');
      const poll: Poll = JSON.parse(data);
      this.cache.set(pollId, poll);
      return poll;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Check if a poll exists.
   */
  async pollExists(pollId: string): Promise<boolean> {
    const poll = await this.getPoll(pollId);
    return poll !== undefined;
  }

  /**
   * Get aggregated results for a poll.
   *
   * @returns Aggregated poll results, or undefined if poll not found
   */
  async getPollResults(pollId: string): Promise<PollResults | undefined> {
    const poll = await this.getPoll(pollId);
    if (!poll) {return undefined;}

    const isExpired = poll.expiresAt ? new Date(poll.expiresAt) <= new Date() : false;

    // Count votes per option
    const voteCounts = new Map<string, number>();
    for (const vote of poll.votes) {
      voteCounts.set(vote.optionId, (voteCounts.get(vote.optionId) || 0) + 1);
    }

    const totalVotes = poll.votes.length;

    const results: PollOptionResult[] = poll.options.map(option => {
      const count = voteCounts.get(option.id) || 0;
      const percentage = totalVotes > 0 ? Math.round((count / totalVotes) * 1000) / 10 : 0;
      return {
        id: option.id,
        text: option.text,
        voteCount: count,
        percentage,
      };
    });

    // Sort by vote count (descending), then by option order
    results.sort((a, b) => b.voteCount - a.voteCount);

    return {
      pollId: poll.id,
      question: poll.question,
      results,
      totalVotes,
      closed: poll.closed,
      expired: isExpired,
    };
  }

  /**
   * List polls, optionally filtered by chat ID.
   *
   * @param chatId - Optional chat ID to filter by
   * @returns Array of polls (without votes, for summary display)
   */
  async listPolls(chatId?: string): Promise<Array<{
    id: string;
    question: string;
    optionCount: number;
    voteCount: number;
    chatId: string;
    createdAt: string;
    closed: boolean;
    expired: boolean;
  }>> {
    await this.ensureInitialized();

    try {
      const files = await fs.readdir(this.pollsDir);
      const jsonFiles = files.filter(f => f.endsWith('.json'));

      const polls: Array<{
        id: string;
        question: string;
        optionCount: number;
        voteCount: number;
        chatId: string;
        createdAt: string;
        closed: boolean;
        expired: boolean;
      }> = [];

      for (const file of jsonFiles) {
        try {
          const filePath = path.join(this.pollsDir, file);
          const data = await fs.readFile(filePath, 'utf-8');
          const poll: Poll = JSON.parse(data);

          if (chatId && poll.chatId !== chatId) {continue;}

          const isExpired = poll.expiresAt ? new Date(poll.expiresAt) <= new Date() : false;

          polls.push({
            id: poll.id,
            question: poll.question,
            optionCount: poll.options.length,
            voteCount: poll.votes.length,
            chatId: poll.chatId,
            createdAt: poll.createdAt,
            closed: poll.closed,
            expired: isExpired,
          });
        } catch (error) {
          logger.warn({ file, err: error }, 'Failed to read poll file');
        }
      }

      // Sort by creation time (newest first)
      polls.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      return polls;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * Close a poll (no more votes accepted).
   *
   * @returns Updated poll, or undefined if not found
   */
  async closePoll(pollId: string): Promise<Poll | undefined> {
    const poll = await this.getPoll(pollId);
    if (!poll) {return undefined;}

    poll.closed = true;

    // Persist
    const filePath = this.getPollFilePath(pollId);
    await fs.writeFile(filePath, JSON.stringify(poll, null, 2), 'utf-8');

    // Update cache
    this.cache.set(pollId, poll);

    logger.info({ pollId }, 'Poll closed');
    return poll;
  }

  /**
   * Delete a poll.
   *
   * @returns true if deleted, false if not found
   */
  async deletePoll(pollId: string): Promise<boolean> {
    await this.ensureInitialized();

    try {
      const filePath = this.getPollFilePath(pollId);
      await fs.unlink(filePath);
      this.cache.delete(pollId);
      logger.info({ pollId }, 'Poll deleted');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  /**
   * Generate a formatted text summary of poll results.
   *
   * Useful for displaying results in chat messages.
   */
  formatResultsText(results: PollResults): string {
    const statusEmoji = results.closed ? '🔒' : results.expired ? '⏰' : '📊';
    const statusText = results.closed ? ' (已关闭)' : results.expired ? ' (已过期)' : '';

    let text = `${statusEmoji} **投票结果**: ${results.question}${statusText}\n\n`;
    text += `**总投票数**: ${results.totalVotes}\n\n`;

    for (const result of results.results) {
      // Build a simple bar visualization
      const filledBars = Math.round(result.percentage / 5);
      const emptyBars = 20 - filledBars;
      const bar = '█'.repeat(filledBars) + '░'.repeat(emptyBars);
      text += `${result.text}: ${result.voteCount} 票 (${result.percentage}%)\n`;
      text += `${bar}\n`;
    }

    return text;
  }

  /**
   * Generate action prompts for a poll's interactive card.
   *
   * Each option gets an action prompt that instructs the agent to record the vote.
   */
  generateActionPrompts(poll: Poll): Record<string, string> {
    const prompts: Record<string, string> = {};

    for (const option of poll.options) {
      prompts[option.id] = [
        `[投票记录] 用户在投票「${poll.question}」中选择了「${option.text}」`,
        '',
        '请立即使用 record_poll_vote 工具记录此投票:',
        `- pollId: "${poll.id}"`,
        `- optionId: "${option.id}"`,
      ].join('\n');
    }

    // Add a "view results" action
    prompts['poll_view_results'] = [
      `[投票查看] 用户查看了投票「${poll.question}」的结果`,
      '',
      '请使用 poll_results 工具获取并展示投票结果:',
      `- pollId: "${poll.id}"`,
    ].join('\n');

    return prompts;
  }

  /**
   * Clear the in-memory cache.
   */
  clearCache(): void {
    this.cache.clear();
  }
}
