/**
 * Discussion module - offline discussion management (Issue #631).
 *
 * Provides types and manager for tracking discussion lifecycle.
 * The actual group creation and agent spawning are handled
 * by DiscussionService in @disclaude/primary-node.
 *
 * @module core/discussion
 */

export type {
  DiscussionTopic,
  DiscussionAction,
  DiscussionResult,
  DiscussionStatus,
  DiscussionRecord,
  CreateDiscussionOptions,
  ConcludeDiscussionOptions,
  DiscussionManagerConfig,
} from './types.js';

export {
  DiscussionManager,
  getDiscussionManager,
  resetDiscussionManager,
} from './discussion-manager.js';
