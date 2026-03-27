/**
 * Agent Mode module.
 *
 * Provides per-chatId mode switching between 'normal' and 'research' modes.
 * Includes Research State File management for tracking research progress.
 *
 * Issue #1709: Research Mode — Phase 1
 * Issue #1710: RESEARCH.md 研究状态文件
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

export {
  ResearchStateFile,
  generateResearchTemplate,
  RESEARCH_STATE_FILENAME,
} from './research-state.js';
