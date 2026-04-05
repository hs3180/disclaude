/**
 * Modes module.
 *
 * Provides agent mode switching infrastructure for isolating specialized
 * work from daily conversations. Currently supports Research mode.
 *
 * @module modes
 * @see Issue #1709
 */

export {
  ResearchModeManager,
} from './research-mode-manager.js';

export type {
  AgentMode,
  ResearchConfig,
  ResearchModeState,
  ActivateResearchResult,
  IResearchModeManager,
} from './types.js';
