/**
 * Agent Mode Type Definitions.
 *
 * Defines the mode system for switching agent behavior between
 * normal operation and specialized modes like Research.
 *
 * @module modes/types
 * @see Issue #1709
 */

/**
 * Agent operation mode.
 *
 * - `normal`: Default mode - uses standard workspace, SOUL, and all skills.
 * - `research`: Research mode - uses isolated research workspace, research SOUL,
 *   and research-specific skill subset (Phase 2).
 */
export type AgentMode = 'normal' | 'research';

/**
 * Research mode configuration from disclaude.config.yaml.
 *
 * @example
 * ```yaml
 * research:
 *   enabled: true
 *   defaultTopic: "default"
 *   workspaceSuffix: "research"
 * ```
 */
export interface ResearchModeConfig {
  /** Enable research mode feature (default: false) */
  enabled?: boolean;
  /** Default research topic name (default: "default") */
  defaultTopic?: string;
  /** Subdirectory name under workspace for research (default: "research") */
  workspaceSuffix?: string;
}

/**
 * Runtime state for research mode.
 *
 * Tracks the current mode and research topic per agent session.
 */
export interface ResearchModeState {
  /** Current agent mode */
  mode: AgentMode;
  /** Research topic name (only meaningful when mode is 'research') */
  topic: string;
  /** Absolute path to the research workspace directory */
  researchWorkspaceDir: string;
}

/**
 * Result of activating research mode.
 */
export interface ResearchActivationResult {
  /** Whether activation was successful */
  success: boolean;
  /** The research workspace directory path */
  researchWorkspaceDir: string;
  /** Error message if activation failed */
  error?: string;
}
