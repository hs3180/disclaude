/**
 * Agent Mode - Mode switching framework for different agent behaviors.
 *
 * Issue #1709: Research Mode Phase 1 - Mode switching framework.
 *
 * Provides:
 * - AgentMode type definition (normal | research)
 * - ModeConfig interface for mode-specific settings
 * - Mode resolution utilities
 *
 * Modes:
 * - 'normal': Default mode with standard workspace and all skills
 * - 'research': Isolated research mode with dedicated workspace and research SOUL
 *
 * Design Principles:
 * - Minimal and composable - mode is just a configuration layer
 * - cwd is already supported by BaseAgent.createSdkOptions({ cwd })
 * - SOUL is loaded via skill finder mechanism
 * - Skill subset loading is deferred to Phase 2
 *
 * @module agents/mode
 */

import * as path from 'path';
import { Config } from '../config/index.js';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Agent operating mode.
 *
 * - 'normal': Default mode - standard workspace, all skills loaded
 * - 'research': Research mode - isolated workspace, research-specific SOUL
 *
 * Future modes may include: 'teaching', 'code-review', etc.
 */
export type AgentMode = 'normal' | 'research';

/**
 * Configuration for a specific agent mode.
 *
 * Defines the behavioral parameters that change when switching modes:
 * - cwd: Working directory (research mode uses isolated subdirectory)
 * - soulSkillName: Optional SOUL skill to load for this mode
 *
 * Phase 2 will add: skillSubsets for filtered skill loading
 * Phase 3 will add: directoryAccessControl for enforced restrictions
 */
export interface ModeConfig {
  /** Mode identifier */
  readonly mode: AgentMode;
  /** Working directory for this mode */
  readonly cwd: string;
  /** Name of the SOUL skill to load (found via skill finder) */
  readonly soulSkillName?: string;
}

/**
 * Options for configuring research mode.
 */
export interface ResearchModeOptions {
  /**
   * Research topic name.
   * Used as subdirectory name under workspace/research/.
   * Must be a valid directory name (alphanumeric, hyphens, underscores).
   */
  topic: string;
}

// ============================================================================
// Mode Resolution
// ============================================================================

/**
 * Resolve the full ModeConfig for a given mode.
 *
 * For 'normal' mode, returns the default workspace directory.
 * For 'research' mode, creates a path to the research workspace subdirectory.
 *
 * The caller (typically BaseAgent.createSdkOptions) uses the resolved cwd
 * and optionally loads the soulSkillName via the skill finder.
 *
 * @param mode - The agent mode to resolve
 * @param options - Mode-specific options (e.g., topic for research mode)
 * @returns Resolved ModeConfig with absolute paths
 *
 * @example
 * ```typescript
 * // Normal mode - uses default workspace
 * const normalConfig = resolveModeConfig('normal');
 * // { mode: 'normal', cwd: '/workspace' }
 *
 * // Research mode - uses isolated workspace
 * const researchConfig = resolveModeConfig('research', { topic: 'ai-safety' });
 * // { mode: 'research', cwd: '/workspace/research/ai-safety', soulSkillName: 'research-soul' }
 * ```
 */
export function resolveModeConfig(
  mode: AgentMode,
  options?: ResearchModeOptions
): ModeConfig {
  const workspaceDir = Config.getWorkspaceDir();

  if (mode === 'research') {
    const topic = options?.topic ?? 'default';
    return {
      mode: 'research',
      cwd: path.join(workspaceDir, 'research', topic),
      soulSkillName: 'research-soul',
    };
  }

  return {
    mode: 'normal',
    cwd: workspaceDir,
  };
}

// ============================================================================
// Research Topic Validation
// ============================================================================

/**
 * Validate a research topic name.
 *
 * Topic names must be:
 * - Non-empty and at most 100 characters
 * - Contain only alphanumeric characters, hyphens, underscores, and dots
 * - This prevents path traversal attacks (e.g., '../escape')
 *
 * @param topic - Topic name to validate
 * @returns True if the topic name is valid
 *
 * @example
 * ```typescript
 * isValidResearchTopic('ai-safety');      // true
 * isValidResearchTopic('../escape');      // false (path traversal)
 * isValidResearchTopic('topic name');     // false (spaces)
 * isValidResearchTopic('');               // false (empty)
 * ```
 */
export function isValidResearchTopic(topic: string): boolean {
  if (!topic || topic.length === 0) {
    return false;
  }
  if (topic.length > 100) {
    return false;
  }
  // Only allow alphanumeric, hyphens, underscores, and dots
  // This prevents path traversal (../) and shell injection
  return /^[a-zA-Z0-9_\-.]+$/.test(topic);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get the research workspace directory for a given topic.
 *
 * Constructs the path: {workspaceDir}/research/{topic}
 *
 * @param topic - Research topic name (should be validated with isValidResearchTopic)
 * @param workspaceDir - Base workspace directory (defaults to Config.getWorkspaceDir())
 * @returns Absolute path to the research workspace directory
 *
 * @example
 * ```typescript
 * getResearchWorkspaceDir('ai-safety', '/workspace');
 * // Returns: '/workspace/research/ai-safety'
 * ```
 */
export function getResearchWorkspaceDir(
  topic: string,
  workspaceDir?: string
): string {
  const base = workspaceDir ?? Config.getWorkspaceDir();
  return path.join(base, 'research', topic);
}
