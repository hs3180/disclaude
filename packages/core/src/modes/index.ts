/**
 * Agent Mode module.
 *
 * Provides per-chatId mode switching between 'normal' and 'research' modes.
 *
 * Issue #1709: Research Mode — Phase 1
 *
 * @module modes
 */

export {
  ResearchModeManager,
  sanitizeTopicName,
  type AgentMode,
  type ResearchModeState,
  type EnterResearchModeResult,
  type EnterResearchModeOptions,
} from './agent-mode.js';
