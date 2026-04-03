/**
 * Agent Mode - Mode switching framework for different agent behaviors.
 *
 * Issue #1709: Research Mode - Phase 1: Mode switching framework
 *
 * This module provides:
 * - AgentMode type definition (normal | research)
 * - ModeManager class for mode state management
 * - Mode-specific path resolution (CWD, CLAUDE.md)
 * - Research workspace setup utilities
 *
 * ## Architecture
 *
 * Mode switching works by changing three dimensions:
 * 1. **CWD** (Working Directory): Research mode uses an isolated workspace
 * 2. **SOUL** (System Prompt): Research mode loads its own CLAUDE.md
 * 3. **Skills** (Phase 2): Research mode filters to a research-specific subset
 *
 * ## How It Works
 *
 * The Claude SDK reads CLAUDE.md from the CWD and loads skills from
 * `.claude/skills/` in the CWD. By switching the CWD to a mode-specific
 * directory, all three dimensions are automatically isolated:
 *
 * ```
 * Normal Mode:
 *   CWD: workspace/
 *   CLAUDE.md: workspace/CLAUDE.md (default behavior)
 *   Skills: workspace/.claude/skills/ (all skills)
 *
 * Research Mode:
 *   CWD: workspace/research/{topic}/
 *   CLAUDE.md: workspace/research/{topic}/CLAUDE.md (research behavior)
 *   Skills: workspace/research/{topic}/.claude/skills/ (research skills)
 * ```
 *
 * @module agents/mode
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger, type Logger } from '../utils/logger.js';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Agent operation mode.
 *
 * - `normal`: Default mode for general conversation and tasks
 * - `research`: Isolated research mode with restricted directory access
 *   and research-specific behavioral guidelines
 */
export type AgentMode = 'normal' | 'research';

/**
 * Research mode configuration.
 *
 * Configures the research mode behavior, including workspace location
 * and directory access restrictions.
 */
export interface ResearchModeConfig {
  /**
   * Base directory for research workspaces.
   * Each research topic gets its own subdirectory under this path.
   * Default: `{workspaceDir}/research/`
   */
  baseDir?: string;

  /**
   * Topic name for the current research session.
   * Used to create a dedicated subdirectory: `{baseDir}/{topic}/`
   *
   * If not provided, defaults to 'default'.
   * Topic names are sanitized to remove unsafe characters.
   */
  topic?: string;
}

/**
 * Resolved mode configuration with computed paths.
 */
export interface ResolvedModeConfig {
  /** The agent mode */
  mode: AgentMode;
  /** Working directory for this mode */
  cwd: string;
  /** Whether the mode uses a custom CWD */
  hasCustomCwd: boolean;
}

/**
 * Research workspace setup result.
 */
export interface ResearchWorkspaceResult {
  /** Whether setup was successful */
  success: boolean;
  /** Path to the created research workspace */
  workspacePath?: string;
  /** Error message if setup failed */
  error?: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Default research directory name */
const DEFAULT_RESEARCH_DIR = 'research';

/** Default topic name when none is specified */
const DEFAULT_TOPIC = 'default';

/** Characters that are not allowed in topic names */
const UNSAFE_TOPIC_CHARS = /[^a-zA-Z0-9_\-]/g;

/** Research CLAUDE.md template content */
const RESEARCH_CLAUDE_MD = `# Research Mode

You are in **Research Mode** — an isolated research environment.

## Behavioral Guidelines

### Directory Access Restrictions
- Only access files within the current research workspace directory
- Do NOT access files in the parent workspace or other project directories
- Do NOT access system directories or paths outside the research workspace

### Research Workflow
1. **Define Scope**: Clearly define the research question or topic
2. **Gather Information**: Use available tools to collect relevant data
3. **Analyze**: Systematically analyze findings
4. **Document**: Record findings and conclusions in markdown files
5. **Summarize**: Provide clear, actionable summaries

### Output Format
- Use markdown for all documentation
- Structure findings with clear headings and sections
- Include source references where applicable
- Flag uncertain findings with ⚠️

### Important Reminders
- Stay focused on the research topic
- Prioritize accuracy over completeness
- Clearly distinguish between facts and interpretations
`;

// ============================================================================
// ModeManager Class
// ============================================================================

/**
 * Manages agent mode state and provides mode-specific configuration.
 *
 * The ModeManager is responsible for:
 * - Storing the current agent mode
 * - Resolving mode-specific working directories
 * - Setting up research workspaces with appropriate CLAUDE.md
 * - Sanitizing topic names for safe filesystem operations
 *
 * @example
 * ```typescript
 * // Create mode manager in research mode
 * const modeManager = new ModeManager({
 *   mode: 'research',
 *   researchConfig: { topic: 'react-performance' },
 *   workspaceDir: '/app/workspace',
 * });
 *
 * // Get resolved configuration
 * const config = modeManager.resolve();
 * console.log(config.cwd); // '/app/workspace/research/react-performance'
 *
 * // Setup research workspace
 * const result = await modeManager.setupResearchWorkspace();
 * ```
 */
export class ModeManager {
  private readonly mode: AgentMode;
  private readonly workspaceDir: string;
  private readonly researchConfig: ResearchModeConfig | undefined;
  private readonly logger: Logger;

  /**
   * Create a new ModeManager.
   *
   * @param options - Mode configuration options
   * @param options.mode - The agent mode (default: 'normal')
   * @param options.researchConfig - Research mode configuration (only used when mode is 'research')
   * @param options.workspaceDir - Base workspace directory
   */
  constructor(options: {
    mode?: AgentMode;
    researchConfig?: ResearchModeConfig;
    workspaceDir: string;
  }) {
    this.mode = options.mode ?? 'normal';
    this.workspaceDir = options.workspaceDir;
    this.researchConfig = options.researchConfig;
    this.logger = createLogger('ModeManager');

    if (this.mode === 'research') {
      this.logger.info({
        topic: this.researchConfig?.topic,
        baseDir: this.researchConfig?.baseDir,
      }, 'Research mode initialized');
    }
  }

  /**
   * Get the current agent mode.
   */
  getMode(): AgentMode {
    return this.mode;
  }

  /**
   * Check if the agent is in research mode.
   */
  isResearchMode(): boolean {
    return this.mode === 'research';
  }

  /**
   * Resolve mode-specific configuration including CWD.
   *
   * For normal mode, returns the base workspace directory.
   * For research mode, returns the research workspace directory.
   *
   * @returns Resolved mode configuration with computed paths
   */
  resolve(): ResolvedModeConfig {
    if (this.mode === 'normal') {
      return {
        mode: 'normal',
        cwd: this.workspaceDir,
        hasCustomCwd: false,
      };
    }

    // Research mode
    const researchCwd = this.getResearchWorkspacePath();
    return {
      mode: 'research',
      cwd: researchCwd,
      hasCustomCwd: true,
    };
  }

  /**
   * Get the research workspace path.
   *
   * Computes the full path based on:
   * 1. Custom baseDir from researchConfig (if provided)
   * 2. Default `{workspaceDir}/research/`
   * 3. Topic subdirectory (sanitized)
   *
   * @returns Full path to the research workspace
   */
  getResearchWorkspacePath(): string {
    const baseDir = this.researchConfig?.baseDir
      ?? path.join(this.workspaceDir, DEFAULT_RESEARCH_DIR);

    const topic = sanitizeTopicName(
      this.researchConfig?.topic ?? DEFAULT_TOPIC
    );

    return path.join(baseDir, topic);
  }

  /**
   * Setup the research workspace directory structure.
   *
   * Creates the following structure:
   * ```
   * {researchWorkspacePath}/
   *   ├── CLAUDE.md          (research behavioral guidelines)
   *   └── .claude/
   *       └── skills/        (research-specific skills, Phase 2)
   * ```
   *
   * @returns Setup result with status and workspace path
   */
  async setupResearchWorkspace(): Promise<ResearchWorkspaceResult> {
    if (this.mode !== 'research') {
      return {
        success: false,
        error: 'Not in research mode',
      };
    }

    const workspacePath = this.getResearchWorkspacePath();

    try {
      // Create workspace directory
      await fs.mkdir(workspacePath, { recursive: true });
      this.logger.debug({ workspacePath }, 'Created research workspace directory');

      // Create CLAUDE.md if it doesn't exist
      const claudeMdPath = path.join(workspacePath, 'CLAUDE.md');
      try {
        await fs.access(claudeMdPath);
        this.logger.debug({ claudeMdPath }, 'CLAUDE.md already exists, skipping');
      } catch {
        await fs.writeFile(claudeMdPath, RESEARCH_CLAUDE_MD, 'utf-8');
        this.logger.info({ claudeMdPath }, 'Created research CLAUDE.md');
      }

      // Create .claude/skills directory (Phase 2: will contain research-specific skills)
      const skillsDir = path.join(workspacePath, '.claude', 'skills');
      await fs.mkdir(skillsDir, { recursive: true });
      this.logger.debug({ skillsDir }, 'Created research skills directory');

      return {
        success: true,
        workspacePath,
      };
    } catch (error) {
      const err = error as Error;
      this.logger.error({ err, workspacePath }, 'Failed to setup research workspace');
      return {
        success: false,
        workspacePath,
        error: err.message,
      };
    }
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Sanitize a topic name for safe use as a directory name.
 *
 * - Converts to lowercase
 * - Replaces spaces with hyphens
 * - Removes unsafe characters
 * - Limits length to 64 characters
 *
 * @param topic - Raw topic name
 * @returns Sanitized topic name safe for filesystem use
 *
 * @example
 * ```typescript
 * sanitizeTopicName('React Performance Optimization');
 * // Returns: 'react-performance-optimization'
 *
 * sanitizeTopicName('C++ Memory Management');
 * // Returns: 'c-memory-management'
 * ```
 */
export function sanitizeTopicName(topic: string): string {
  return topic
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(UNSAFE_TOPIC_CHARS, '')
    .slice(0, 64);
}

/**
 * Check if a given path looks like a research workspace.
 *
 * A research workspace is identified by the presence of a `CLAUDE.md`
 * file that contains the "Research Mode" header.
 *
 * @param dirPath - Directory path to check
 * @returns True if the directory is a research workspace
 */
export async function isResearchWorkspace(dirPath: string): Promise<boolean> {
  try {
    const claudeMdPath = path.join(dirPath, 'CLAUDE.md');
    const content = await fs.readFile(claudeMdPath, 'utf-8');
    return content.includes('# Research Mode');
  } catch {
    return false;
  }
}
