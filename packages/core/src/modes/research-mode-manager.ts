/**
 * Research Mode Manager.
 *
 * Provides per-agent research mode state management with project workspace
 * isolation. When research mode is activated for a project, the effective
 * working directory changes to `workspace/research/{project}/`, causing
 * the Claude Code SDK to read a project-specific CLAUDE.md.
 *
 * Design principles (from Issue #1709 review feedback):
 * - No default project — must be explicitly specified
 * - No fixed SOUL template — writes minimal default CLAUDE.md only if absent
 * - Instance-based — each agent owns its own manager (no global state)
 * - Non-destructive — existing CLAUDE.md in research workspace is never overwritten
 *
 * @module modes/research-mode-manager
 * @see Issue #1709
 */

import path from 'path';
import fs from 'fs';
import { createLogger } from '../utils/logger.js';
import type {
  ResearchConfig,
  ResearchModeState,
  ActivateResearchResult,
  IResearchModeManager,
} from './types.js';

const logger = createLogger('ResearchMode');

/** Default content for CLAUDE.md in new research project workspaces. */
const DEFAULT_CLAUDE_MD = `# Research Project

This is an isolated research workspace. Customize this file to define
project-specific instructions and context for the agent.
`;

/**
 * Research Mode Manager implementation.
 *
 * Manages per-agent mode state with project workspace creation and CWD switching.
 * Uses pure Node.js fs operations — no external dependencies.
 */
export class ResearchModeManager implements IResearchModeManager {
  private readonly baseWorkspaceDir: string;
  private readonly workspaceSuffix: string;
  private readonly state: ResearchModeState;

  /**
   * Create a new ResearchModeManager.
   *
   * @param baseWorkspaceDir - Base workspace directory (e.g., Config.getWorkspaceDir())
   * @param config - Research configuration section from disclaude.config.yaml
   */
  constructor(baseWorkspaceDir: string, config?: ResearchConfig) {
    this.baseWorkspaceDir = baseWorkspaceDir;
    this.workspaceSuffix = config?.workspaceSuffix || 'research';
    this.state = {
      mode: 'normal',
      project: null,
    };
  }

  /**
   * Activate research mode for a specific project.
   *
   * Creates `workspace/research/{project}/` directory and writes a minimal
   * default CLAUDE.md if none exists. The Claude Code SDK will automatically
   * read CLAUDE.md from the CWD, effectively switching the agent's persona.
   *
   * @param project - Project name (must be non-empty)
   * @returns Result with workspace path and creation status
   * @throws Error if project name is empty or contains path separators
   */
  activateResearch(project: string): ActivateResearchResult {
    // Validate project name — must be explicitly specified
    if (!project || project.trim().length === 0) {
      throw new Error('Project name is required. Usage: /research enter <project>');
    }

    const sanitizedProject = project.trim();

    // Prevent path traversal
    if (sanitizedProject.includes('/') || sanitizedProject.includes('\\') || sanitizedProject.includes('..')) {
      throw new Error(`Invalid project name: "${sanitizedProject}". Project names must not contain path separators.`);
    }

    const projectDir = this.getProjectDir(sanitizedProject);
    let created = false;

    // Create project directory if it doesn't exist
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
      created = true;
      logger.info({ project: sanitizedProject, dir: projectDir }, 'Created research project directory');
    }

    // Write default CLAUDE.md only if the file doesn't exist
    const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
    let claudeMdWritten = false;

    if (!fs.existsSync(claudeMdPath)) {
      fs.writeFileSync(claudeMdPath, DEFAULT_CLAUDE_MD, 'utf-8');
      claudeMdWritten = true;
      logger.info({ project: sanitizedProject }, 'Wrote default CLAUDE.md to research project');
    }

    // Update state
    this.state.mode = 'research';
    this.state.project = sanitizedProject;

    logger.info(
      { project: sanitizedProject, dir: projectDir, created },
      'Research mode activated',
    );

    return { cwd: projectDir, created, claudeMdWritten };
  }

  /**
   * Deactivate research mode and return to normal workspace.
   *
   * @returns The project name that was deactivated, or null if not in research mode
   */
  deactivateResearch(): string | null {
    if (this.state.mode !== 'research') {
      return null;
    }

    const deactivatedProject = this.state.project;
    this.state.mode = 'normal';
    this.state.project = null;

    logger.info({ project: deactivatedProject }, 'Research mode deactivated');
    return deactivatedProject;
  }

  /**
   * List all existing research project directories.
   *
   * Scans the research workspace parent directory for subdirectories.
   *
   * @returns Array of project names
   */
  listResearchProjects(): string[] {
    const researchDir = this.getResearchDir();

    if (!fs.existsSync(researchDir)) {
      return [];
    }

    try {
      return fs.readdirSync(researchDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      logger.warn({ researchDir }, 'Failed to list research projects');
      return [];
    }
  }

  /**
   * Check if research mode is currently active.
   */
  isActive(): boolean {
    return this.state.mode === 'research';
  }

  /**
   * Get the currently active research project name.
   */
  getCurrentProject(): string | null {
    return this.state.project;
  }

  /**
   * Get the effective working directory based on current mode.
   *
   * Returns the research project workspace if active, otherwise the base workspace.
   */
  getEffectiveCwd(): string {
    if (this.state.mode === 'research' && this.state.project) {
      return this.getProjectDir(this.state.project);
    }
    return this.baseWorkspaceDir;
  }

  /**
   * Get the current mode state (read-only snapshot).
   */
  getState(): Readonly<ResearchModeState> {
    return { ...this.state };
  }

  /**
   * Get the research workspace parent directory.
   */
  private getResearchDir(): string {
    return path.join(this.baseWorkspaceDir, this.workspaceSuffix);
  }

  /**
   * Get the full path for a specific research project.
   */
  private getProjectDir(project: string): string {
    return path.join(this.baseWorkspaceDir, this.workspaceSuffix, project);
  }
}
