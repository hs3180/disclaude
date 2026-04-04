/**
 * Research Mode Manager.
 *
 * Manages the agent's mode state and provides the research workspace
 * infrastructure for Issue #1709 Phase 1.
 *
 * Responsibilities:
 * - Track current agent mode (normal / research)
 * - Resolve research workspace paths
 * - Create research workspace directories on demand
 * - Provide CWD override for SDK options when in research mode
 *
 * Phase 1: SOUL + CWD linked switching
 * Phase 2: Research skill subset (future)
 * Phase 3: Directory access control (future)
 *
 * @module modes/research-mode-manager
 * @see Issue #1709
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync, readdirSync, copyFileSync } from 'fs';
import { createLogger } from '../utils/logger.js';
import type {
  AgentMode,
  ResearchModeConfig,
  ResearchModeState,
  ResearchActivationResult,
} from './types.js';

const logger = createLogger('ResearchModeManager');

/**
 * Get the directory containing this module's source files.
 * Used to locate the research-soul.md template at runtime.
 */
function getModuleDir(): string {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    // Fallback for CommonJS bundling where import.meta.url is undefined
    return __dirname;
  }
}

/** Default configuration values */
const DEFAULTS = {
  defaultTopic: 'default',
  workspaceSuffix: 'research',
} as const;

/**
 * Research Mode Manager.
 *
 * Manages mode switching between normal and research modes.
 * Each agent instance should have its own ResearchModeManager.
 *
 * @example
 * ```typescript
 * const manager = new ResearchModeManager({
 *   baseWorkspaceDir: '/app/workspace',
 *   config: { enabled: true, defaultTopic: 'my-research' },
 * });
 *
 * // Switch to research mode
 * const result = manager.activateResearch('my-research');
 * if (result.success) {
 *   const cwd = manager.getEffectiveCwd(); // /app/workspace/research/my-research
 * }
 *
 * // Switch back to normal
 * manager.deactivateResearch();
 * ```
 */
export class ResearchModeManager {
  private readonly baseWorkspaceDir: string;
  private readonly config: Required<ResearchModeConfig>;
  private state: ResearchModeState;

  /**
   * Create a new ResearchModeManager.
   *
   * @param options - Manager configuration
   * @param options.baseWorkspaceDir - Absolute path to the base workspace directory
   * @param options.config - Research mode configuration (optional)
   */
  constructor(
    options: {
      baseWorkspaceDir: string;
      config?: ResearchModeConfig;
    }
  ) {
    this.baseWorkspaceDir = options.baseWorkspaceDir;

    // Merge config with defaults
    const cfg = options.config ?? {};
    this.config = {
      enabled: cfg.enabled ?? false,
      defaultTopic: cfg.defaultTopic ?? DEFAULTS.defaultTopic,
      workspaceSuffix: cfg.workspaceSuffix ?? DEFAULTS.workspaceSuffix,
    };

    // Initialize state
    this.state = {
      mode: 'normal',
      topic: '',
      researchWorkspaceDir: '',
    };

    logger.debug({
      baseWorkspaceDir: this.baseWorkspaceDir,
      config: this.config,
    }, 'ResearchModeManager initialized');
  }

  /**
   * Get the current agent mode.
   */
  getMode(): AgentMode {
    return this.state.mode;
  }

  /**
   * Check if currently in research mode.
   */
  isResearchMode(): boolean {
    return this.state.mode === 'research';
  }

  /**
   * Check if research mode feature is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Get the current research topic.
   * Returns empty string if not in research mode.
   */
  getTopic(): string {
    return this.state.topic;
  }

  /**
   * Get the current mode state (read-only copy).
   */
  getState(): Readonly<ResearchModeState> {
    return { ...this.state };
  }

  /**
   * Resolve the absolute path for a research topic workspace.
   *
   * @param topic - Research topic name
   * @returns Absolute path to the research workspace directory
   */
  resolveResearchWorkspaceDir(topic: string): string {
    return path.resolve(
      this.baseWorkspaceDir,
      this.config.workspaceSuffix,
      topic,
    );
  }

  /**
   * Activate research mode for a given topic.
   *
   * Creates the research workspace directory if it doesn't exist.
   * The CLAUDE.md in the research workspace will be used as the SOUL
   * (read automatically by the Claude Code SDK from the CWD).
   *
   * @param topic - Research topic name (defaults to configured default topic)
   * @returns Activation result with success status and workspace path
   */
  activateResearch(topic?: string): ResearchActivationResult {
    if (!this.config.enabled) {
      logger.warn('Research mode is not enabled in config');
      return {
        success: false,
        researchWorkspaceDir: '',
        error: 'Research mode is not enabled. Set research.enabled: true in config.',
      };
    }

    const effectiveTopic = topic || this.config.defaultTopic;
    const researchDir = this.resolveResearchWorkspaceDir(effectiveTopic);

    try {
      // Create research workspace directory if it doesn't exist
      const isNewWorkspace = !existsSync(researchDir);
      if (isNewWorkspace) {
        mkdirSync(researchDir, { recursive: true });
        logger.info({ researchDir }, 'Created research workspace directory');

        // Copy research SOUL template (CLAUDE.md) to new research workspace.
        // The Claude Code SDK reads CLAUDE.md from the CWD, effectively
        // switching the agent's persona when in research mode.
        const soulTemplatePath = path.join(getModuleDir(), 'research-soul.md');
        const soulTargetPath = path.join(researchDir, 'CLAUDE.md');
        if (existsSync(soulTemplatePath) && !existsSync(soulTargetPath)) {
          copyFileSync(soulTemplatePath, soulTargetPath);
          logger.info({ soulTemplatePath, soulTargetPath }, 'Copied research SOUL template to workspace');
        }
      }

      // Update state
      this.state = {
        mode: 'research',
        topic: effectiveTopic,
        researchWorkspaceDir: researchDir,
      };

      logger.info(
        { topic: effectiveTopic, researchDir },
        'Research mode activated',
      );

      return {
        success: true,
        researchWorkspaceDir: researchDir,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(
        { err: errorMessage, topic: effectiveTopic, researchDir },
        'Failed to activate research mode',
      );

      return {
        success: false,
        researchWorkspaceDir: researchDir,
        error: errorMessage,
      };
    }
  }

  /**
   * Deactivate research mode and return to normal mode.
   */
  deactivateResearch(): void {
    if (this.state.mode === 'normal') {
      logger.debug('Already in normal mode, no action needed');
      return;
    }

    const previousTopic = this.state.topic;
    this.state = {
      mode: 'normal',
      topic: '',
      researchWorkspaceDir: '',
    };

    logger.info({ previousTopic }, 'Research mode deactivated, returned to normal mode');
  }

  /**
   * Get the effective CWD for SDK options based on current mode.
   *
   * - Normal mode: returns the base workspace directory
   * - Research mode: returns the research workspace directory
   *
   * The Claude Code SDK reads CLAUDE.md from this directory,
   * effectively switching the SOUL based on mode.
   *
   * @returns Effective working directory path
   */
  getEffectiveCwd(): string {
    if (this.state.mode === 'research' && this.state.researchWorkspaceDir) {
      return this.state.researchWorkspaceDir;
    }
    return this.baseWorkspaceDir;
  }

  /**
   * Check if a research workspace directory exists for a given topic.
   *
   * @param topic - Research topic name
   * @returns true if the directory exists
   */
  researchWorkspaceExists(topic?: string): boolean {
    const effectiveTopic = topic || this.config.defaultTopic;
    const researchDir = this.resolveResearchWorkspaceDir(effectiveTopic);
    return existsSync(researchDir);
  }

  /**
   * List available research topics (directories under research workspace root).
   *
   * @returns Array of topic names that have existing directories
   */
  listResearchTopics(): string[] {
    const researchRoot = path.resolve(
      this.baseWorkspaceDir,
      this.config.workspaceSuffix,
    );

    if (!existsSync(researchRoot)) {
      return [];
    }

    try {
      return readdirSync(researchRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch {
      logger.debug({ researchRoot }, 'Failed to list research topics');
      return [];
    }
  }
}
