/**
 * Mode type definitions for agent mode switching.
 *
 * Issue #1709: Research Mode - SOUL + cwd + Skill set switching.
 *
 * Defines the mode type and related configuration for switching
 * between normal and research modes per chat session.
 *
 * @module mode/types
 */

/**
 * Agent operation mode.
 *
 * - `normal`: Default mode with standard SOUL, workspace, and full skill set
 * - `research`: Isolated research environment with research SOUL,
 *   topic-specific working directory, and research skill subset
 */
export type AgentMode = 'normal' | 'research';

/**
 * Configuration for research mode.
 *
 * Contains all information needed to operate in research mode
 * for a specific research topic.
 */
export interface ResearchModeConfig {
  /** Research topic name (used as directory name) */
  topic: string;
  /** Absolute path to the research working directory */
  cwd: string;
  /** Research SOUL content to inject into agent context */
  soulContent: string;
  /** Timestamp when research mode was activated (ISO 8601) */
  activatedAt: string;
}

/**
 * Per-chat mode state.
 *
 * Tracks the current mode and any mode-specific configuration
 * for each chat session.
 */
export interface ModeState {
  /** Current agent mode */
  mode: AgentMode;
  /** Research-specific configuration (only when mode is 'research') */
  research?: ResearchModeConfig;
}
