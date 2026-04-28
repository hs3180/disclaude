/**
 * MessageBuilder module - Framework-agnostic message content builder.
 *
 * Issue #1492: Extracted from worker-node to core package.
 *
 * @module agents/message-builder
 */

// Types
export type {
  MessageData,
  MessageBuilderContext,
  MessageBuilderOptions,
} from './types.js';

// Core class
export { MessageBuilder } from './message-builder.js';

// Composable guidance functions (pure, testable, framework-agnostic)
export {
  buildChatHistorySection,
  buildPersistedHistorySection,
  buildNextStepGuidance,
  buildOutputFormatGuidance,
  buildLocationAwarenessGuidance,
  buildTasteContextSection,
} from './guidance.js';
