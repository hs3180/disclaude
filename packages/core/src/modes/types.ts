/**
 * Mode type definitions for Disclaude.
 *
 * Defines the agent mode system that allows switching between
 * normal operation and specialized modes like Research.
 *
 * @module modes/types
 * @see Issue #1709
 */

/**
 * Agent operating mode.
 *
 * - `normal`: Default mode — uses base workspace and full skill set.
 * - `research`: Research mode — uses isolated project workspace.
 *
 * Future modes may include `debug`, `teaching`, etc.
 */
export type AgentMode = 'normal' | 'research';

/**
 * Research mode configuration from disclaude.config.yaml.
 *
 * Must be explicitly enabled; research mode is opt-in.
 *
 * ```yaml
 * research:
 *   enabled: true
 *   workspaceSuffix: "research"
 * ```
 */
export interface ResearchConfig {
  /** Enable/disable research mode feature (default: false) */
  enabled?: boolean;
  /** Directory suffix for research workspaces (default: "research") */
  workspaceSuffix?: string;
}

/**
 * Internal state for the research mode manager.
 * Tracks the current mode and active project per instance.
 */
export interface ResearchModeState {
  /** Current agent mode */
  mode: AgentMode;
  /** Active research project name (only when mode is 'research') */
  project: string | null;
}

/**
 * Result of activating a research project.
 */
export interface ActivateResearchResult {
  /** Absolute path to the research workspace */
  cwd: string;
  /** Whether the project directory was newly created */
  created: boolean;
  /** Whether a default CLAUDE.md was written */
  claudeMdWritten: boolean;
}

/**
 * Interface for research mode operations.
 *
 * This is the contract that control command handlers depend on.
 * The ResearchModeManager class implements this interface.
 *
 * @see ResearchModeManager
 */
export interface IResearchModeManager {
  /**
   * Activate research mode for a specific project.
   *
   * Creates the project workspace directory if it doesn't exist,
   * and writes a minimal default CLAUDE.md if none is present.
   *
   * @param project - Project name (must be non-empty, no default)
   * @returns Result with workspace path and creation status
   * @throws Error if project name is empty
   */
  activateResearch(project: string): ActivateResearchResult;

  /**
   * Deactivate research mode and return to normal workspace.
   *
   * @returns The project name that was deactivated, or null if not in research mode
   */
  deactivateResearch(): string | null;

  /**
   * List all existing research project directories.
   *
   * @returns Array of project names that have workspace directories
   */
  listResearchProjects(): string[];

  /**
   * Check if research mode is currently active.
   *
   * @returns true if in research mode
   */
  isActive(): boolean;

  /**
   * Get the currently active research project name.
   *
   * @returns Project name or null if not in research mode
   */
  getCurrentProject(): string | null;

  /**
   * Get the effective working directory based on current mode.
   *
   * @returns Research workspace path if active, otherwise base workspace
   */
  getEffectiveCwd(): string;

  /**
   * Get the current mode state.
   *
   * @returns Current mode and project
   */
  getState(): Readonly<ResearchModeState>;
}
