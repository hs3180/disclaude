/**
 * Feedback Module.
 *
 * Provides FeedbackController for unified feedback collection abstraction.
 *
 * @see Issue #411
 */

export {
  FeedbackController,
  type FeedbackControllerConfig,
  type CreateChannelOptions,
  type ChannelType,
  type Feedback,
  type FeedbackType,
  type Decision,
  type CardContent,
  type CollectFeedbackOptions,
} from './feedback-controller.js';
