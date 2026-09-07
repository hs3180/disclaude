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
  buildTaskRecordGuidance,
  buildLocationAwarenessGuidance,
} from './guidance.js';

// Canonical channel CLI help (shared with channel-cli's `help` output —
// Issue #4705, single source of truth so the in-prompt help can't drift)
export {
  CHANNEL_CLI_HELP,
  buildChannelCliHelpGuidance,
} from './channel-cli-help.js';
