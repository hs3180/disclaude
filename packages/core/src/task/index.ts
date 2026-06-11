/**
 * Task Module
 *
 * Provides task management utilities for worker nodes.
 *
 * @module task
 */

// Dialogue Message Tracker
export { DialogueMessageTracker } from './dialogue-message-tracker.js';

// Task Tracker
export { TaskTracker } from './task-tracker.js';

// Loop Feedback (Issue #4017)
export {
  appendFeedback,
  readFeedback,
  readFeedbackSince,
  hasNewFeedback,
  parseFeedbackFromContent,
} from './loop-feedback.js';

export type { FeedbackEntry } from './loop-feedback.js';
