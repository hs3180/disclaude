/**
 * Mode module - Agent mode switching infrastructure.
 *
 * Issue #1709: Research Mode - SOUL + cwd + Skill set switching.
 *
 * Provides per-chat mode state management for switching between
 * normal and research modes.
 *
 * Architecture:
 * ```
 * ModeManager (per-chat state)
 *   ├── ModeState { mode: 'normal' | 'research' }
 *   ├── ResearchModeConfig { topic, cwd, soulContent }
 *   └── sanitizeTopicName() (directory-safe names)
 * ```
 *
 * @module mode
 */

// Types
export type {
  AgentMode,
  ResearchModeConfig,
  ModeState,
} from './types.js';

// Mode Manager
export {
  ModeManager,
  type ModeManagerOptions,
} from './mode-manager.js';

// Research SOUL
export {
  generateResearchSoulContent,
  createResearchModeConfig,
  sanitizeTopicName,
} from './research-soul.js';
