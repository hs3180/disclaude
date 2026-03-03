/**
 * Human-in-the-Loop Module (Issue #532).
 *
 * This module provides tools for Agent-initiated human interaction:
 * - Create discussion chats
 * - Ask experts for help
 * - @mention users
 *
 * @see Issue #532 - Human-in-the-Loop interaction system
 */

// Types
export type {
  SkillDefinition,
  ExpertConfig,
  ExpertRegistryConfig,
  InteractionButton,
  CreateDiscussionOptions,
  AskExpertOptions,
  CreateDiscussionResult,
  AskExpertResult,
} from './types.js';

// Expert Registry
export { ExpertRegistry, getExpertRegistry } from './expert-registry.js';

// Tools
export {
  formatMention,
  create_discussion,
  ask_expert,
  buildInteractionCard,
  humanLoopToolDefinitions,
  humanLoopSdkTools,
} from './human-loop-tools.js';
