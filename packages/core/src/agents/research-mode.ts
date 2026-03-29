/**
 * Research Mode - Mode switching framework for agent behavior customization.
 *
 * This module implements the Research Mode feature (Issue #1709):
 * - Defines AgentMode type (normal | research)
 * - Provides ResearchModeConfig for mode-specific settings
 * - Implements ResearchModeService for mode management and switching
 *
 * ## Architecture
 *
 * Research Mode switches three dimensions when activated:
 * 1. **SOUL**: Loads research-specific behavior guidelines
 * 2. **CWD**: Redirects to isolated research working directory
 * 3. **Skills**: Filters to research-relevant skill subset
 *
 * ## Usage
 *
 * ```typescript
 * import { ResearchModeService, DEFAULT_RESEARCH_SOUL } from './research-mode.js';
 *
 * const service = new ResearchModeService('/workspace');
 *
 * // Activate research mode for a topic
 * service.activate('ai-safety');
 * // -> cwd: /workspace/research/ai-safety/
 * // -> soul: DEFAULT_RESEARCH_SOUL
 * // -> skills: ['web-search', 'code-reader', 'note-taker', ...]
 *
 * // Get mode-specific SDK options
 * const extra = service.getSdkOptionsExtra();
 *
 * // Deactivate back to normal
 * service.deactivate();
 * ```
 *
 * @module agents/research-mode
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ResearchMode');

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Agent operation mode.
 *
 * - `normal`: Default mode with full skill access and standard SOUL
 * - `research`: Isolated research mode with restricted skills and research SOUL
 */
export type AgentMode = 'normal' | 'research';

/**
 * Research mode configuration.
 *
 * Defines the behavior when research mode is activated.
 * All fields have sensible defaults.
 */
export interface ResearchModeConfig {
  /**
   * Research topic identifier.
   * Used as the subdirectory name under the research workspace.
   * Must be a valid directory name (no slashes, spaces, etc.).
   */
  topic: string;

  /**
   * Path to the research SOUL.md content.
   * If provided, this file's content will be used as the system prompt addition.
   * If not provided, DEFAULT_RESEARCH_SOUL is used.
   */
  soulContent?: string;

  /**
   * List of skill names allowed in research mode.
   * Only these skills will be accessible when research mode is active.
   * If empty, all skills remain accessible (no filtering).
   */
  allowedSkills?: string[];

  /**
   * Custom research working directory.
   * If provided, overrides the default `{workspace}/research/{topic}` path.
   */
  researchDir?: string;
}

/**
 * Current mode state snapshot.
 */
export interface ModeState {
  /** Current active mode */
  mode: AgentMode;
  /** Research topic (only when mode is 'research') */
  topic?: string;
  /** Effective working directory */
  cwd: string;
  /** Effective SOUL content (if any) */
  soulContent?: string;
  /** Allowed skill names (if filtered) */
  allowedSkills?: string[];
}

// ============================================================================
// Default Research SOUL
// ============================================================================

/**
 * Default Research SOUL content.
 *
 * This defines the behavior guidelines when research mode is active.
 * It instructs the agent to focus on research tasks and respect directory boundaries.
 */
export const DEFAULT_RESEARCH_SOUL = `---
name: research-soul
description: Research mode behavior guidelines
---

## Research Behavior Guidelines

### Objective
You are in **Research Mode** — an isolated research environment designed for deep, focused investigation.

### Directory Boundaries
- **Allowed**: Current research directory and its subdirectories only
- **Restricted**: Workspace project files, system directories, and other research topics
- **Action**: If asked to access files outside the research directory, inform the user and suggest copying relevant files into the research workspace instead

### Research Workflow
1. **Plan**: Break down the research question into clear sub-questions
2. **Search**: Use available tools to gather information systematically
3. **Synthesize**: Organize findings into structured notes
4. **Cite**: Always reference sources for any claims or data
5. **Review**: Summarize key findings and identify gaps

### Output Standards
- Save research notes as Markdown files in the current research directory
- Use clear file naming: \`01-question.md\`, \`02-findings.md\`, \`03-analysis.md\`
- Include date and source information in all notes
- Keep a \`README.md\` summarizing the research progress

### Constraints
- Do not modify files outside the research directory
- Do not execute code that affects the host system
- Focus on information gathering and analysis, not implementation
`;

// ============================================================================
// Default Research Skills
// ============================================================================

/**
 * Default skill names allowed in research mode.
 *
 * These are skills commonly needed for research tasks.
 * Subsets can be customized via ResearchModeConfig.allowedSkills.
 */
export const DEFAULT_RESEARCH_SKILLS: string[] = [
  'web-search',
  'code-reader',
  'note-taker',
  'research-workflow',
  'daily-soul-question',
  'next-step',
  'task',
];

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate a research topic name.
 *
 * Topic must be a valid directory name:
 * - Non-empty
 * - No path separators (/ or \\)
 * - No null bytes
 * - No leading/trailing dots or spaces
 *
 * @param topic - Topic name to validate
 * @returns Error message if invalid, undefined if valid
 */
export function validateTopic(topic: string): string | undefined {
  if (!topic || topic.trim().length === 0) {
    return 'Topic must not be empty';
  }
  if (topic.includes('/') || topic.includes('\\')) {
    return 'Topic must not contain path separators';
  }
  if (topic.includes('\0')) {
    return 'Topic must not contain null bytes';
  }
  if (topic.startsWith('.') || topic.endsWith('.')) {
    return 'Topic must not start or end with a dot';
  }
  if (topic.trim() !== topic) {
    return 'Topic must not have leading or trailing whitespace';
  }
  return undefined;
}

// ============================================================================
// ResearchModeService
// ============================================================================

/**
 * Service for managing agent mode switching.
 *
 * This service handles transitions between normal and research modes,
 * providing mode-specific configuration for SDK options.
 *
 * ## Lifecycle
 *
 * ```
 * Normal Mode ──activate(topic)──> Research Mode
 *     ^                                  |
 *     └────────deactivate()──────────────┘
 * ```
 *
 * Thread safety: Not designed for concurrent use. Single-threaded access assumed.
 */
export class ResearchModeService {
  private currentMode: AgentMode = 'normal';
  private researchConfig?: ResearchModeConfig;
  private researchDir?: string;
  private readonly baseWorkspaceDir: string;

  /**
   * Create a new ResearchModeService.
   *
   * @param baseWorkspaceDir - The base workspace directory.
   *   Research directories will be created under `{baseWorkspaceDir}/research/{topic}/`
   */
  constructor(baseWorkspaceDir: string) {
    this.baseWorkspaceDir = baseWorkspaceDir;
  }

  /**
   * Get the current agent mode.
   */
  getMode(): AgentMode {
    return this.currentMode;
  }

  /**
   * Check if research mode is currently active.
   */
  isResearchMode(): boolean {
    return this.currentMode === 'research';
  }

  /**
   * Get the current mode state snapshot.
   *
   * Returns a read-only snapshot of the current mode configuration,
   * useful for logging and debugging.
   */
  getState(): ModeState {
    if (this.currentMode === 'normal') {
      return {
        mode: 'normal',
        cwd: this.baseWorkspaceDir,
      };
    }

    return {
      mode: 'research',
      topic: this.researchConfig?.topic,
      cwd: this.researchDir ?? this.baseWorkspaceDir,
      soulContent: this.researchConfig?.soulContent ?? DEFAULT_RESEARCH_SOUL,
      allowedSkills: this.researchConfig?.allowedSkills ?? DEFAULT_RESEARCH_SKILLS,
    };
  }

  /**
   * Activate research mode for a given topic.
   *
   * This will:
   * 1. Validate the topic name
   * 2. Create the research directory if it doesn't exist
   * 3. Save a RESEARCH_SOUL.md file in the research directory
   * 4. Switch the active mode to 'research'
   *
   * @param config - Research mode configuration (topic is required)
   * @returns The research directory path
   * @throws Error if topic is invalid or directory creation fails
   */
  async activate(config: ResearchModeConfig): Promise<string> {
    // Validate topic
    const validationError = validateTopic(config.topic);
    if (validationError) {
      throw new Error(`Invalid research topic: ${validationError}`);
    }

    // Determine research directory
    const researchDir = config.researchDir
      ?? path.join(this.baseWorkspaceDir, 'research', config.topic);

    // Create research directory
    await fs.mkdir(researchDir, { recursive: true });

    // Save SOUL.md to research directory
    const soulContent = config.soulContent ?? DEFAULT_RESEARCH_SOUL;
    const soulPath = path.join(researchDir, 'RESEARCH_SOUL.md');
    await fs.writeFile(soulPath, soulContent, 'utf-8');

    // Update state
    this.currentMode = 'research';
    this.researchConfig = config;
    this.researchDir = researchDir;

    logger.info({
      topic: config.topic,
      researchDir,
      allowedSkills: config.allowedSkills ?? DEFAULT_RESEARCH_SKILLS,
    }, 'Research mode activated');

    return researchDir;
  }

  /**
   * Deactivate research mode and return to normal mode.
   *
   * This clears all research-specific state but does NOT delete
   * the research directory — research data is preserved.
   */
  deactivate(): void {
    if (this.currentMode === 'normal') {
      logger.debug('Already in normal mode, nothing to deactivate');
      return;
    }

    const topic = this.researchConfig?.topic;
    logger.info({ topic }, 'Research mode deactivated');

    this.currentMode = 'normal';
    this.researchConfig = undefined;
    this.researchDir = undefined;
  }

  /**
   * Get SDK options extra for the current mode.
   *
   * Returns an object suitable for passing to `createSdkOptions(extra)`.
   * In research mode, this includes:
   * - Overridden cwd pointing to the research directory
   * - Allowed skills filtered to research subset
   *
   * @returns SdkOptionsExtra-compatible object
   */
  getSdkOptionsExtra(): {
    cwd?: string;
    allowedTools?: string[];
    disallowedTools?: string[];
  } {
    if (this.currentMode === 'normal') {
      // Normal mode: no modifications
      return {};
    }

    const result: {
      cwd?: string;
      allowedTools?: string[];
      disallowedTools?: string[];
    } = {};

    // Override cwd to research directory
    if (this.researchDir) {
      result.cwd = this.researchDir;
    }

    // Filter skills if allowedSkills is configured
    const skills = this.researchConfig?.allowedSkills ?? DEFAULT_RESEARCH_SKILLS;
    if (skills.length > 0) {
      result.allowedTools = skills;
    }

    return result;
  }

  /**
   * Get the research SOUL content for the current mode.
   *
   * In normal mode, returns undefined.
   * In research mode, returns the SOUL content (either custom or default).
   */
  getSoulContent(): string | undefined {
    if (this.currentMode === 'normal') {
      return undefined;
    }
    return this.researchConfig?.soulContent ?? DEFAULT_RESEARCH_SOUL;
  }

  /**
   * Get the research directory path.
   *
   * Returns undefined if not in research mode.
   */
  getResearchDir(): string | undefined {
    return this.researchDir;
  }

  /**
   * Get the default research directory path for a topic (without activating).
   *
   * Useful for pre-checking or displaying the path before activation.
   *
   * @param topic - Research topic name
   * @returns Resolved research directory path
   */
  getResearchDirForTopic(topic: string): string {
    return path.join(this.baseWorkspaceDir, 'research', topic);
  }
}
