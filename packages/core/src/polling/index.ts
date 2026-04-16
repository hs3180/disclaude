/**
 * Polling module - lightweight poll/survey functionality.
 *
 * Issue #2191: 方案 C — 内置轻量调查 (卡片+回调)
 *
 * @module core/polling
 */

export { PollManager } from './poll-manager.js';

export type {
  Poll,
  PollOption,
  PollVote,
  PollOptionResult,
  PollResults,
  CreatePollOptions,
  RecordVoteOptions,
  PollValidationError,
} from './types.js';
