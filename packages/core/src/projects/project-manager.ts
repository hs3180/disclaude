/**
 * Project Manager - Runtime project state management.
 *
 * Issue #1916: Manages project switching and knowledge base caching
 * for the Claude Projects-like feature.
 *
 * This module provides:
 * - Per-chatId project tracking
 * - Knowledge base content caching with lazy loading
 * - Project listing and switching operations
 *
 * @module projects/project-manager
 */

import path from 'path';
import { createLogger } from '../utils/logger.js';
import { KnowledgeBaseLoader } from './knowledge-base-loader.js';
import type {
  ProjectConfig,
  ProjectsConfig,
  ProjectInfo,
  KnowledgeLoadResult,
  KnowledgeBaseLoaderOptions,
} from './types.js';

const logger = createLogger('ProjectManager');

/**
 * Project Manager for runtime project state management.
 *
 * Manages which project is active for each chatId, caches loaded
 * knowledge base content, and provides project listing/switching.
 *
 * Usage:
 * ```typescript
 * const pm = new ProjectManager(projectsConfig, workspaceDir);
 * pm.switchProject('chat-123', 'book-reader');
 * const knowledge = await pm.getProjectKnowledge('chat-123');
 * ```
 */
export class ProjectManager {
  private readonly config: ProjectsConfig;
  private readonly workspaceDir: string;
  private readonly loader: KnowledgeBaseLoader;

  /** Per-chatId current project name */
  private readonly currentProjects = new Map<string, string>();

  /** Cached knowledge base content per project name */
  private readonly knowledgeCache = new Map<string, KnowledgeLoadResult>();

  /** Project names in config order */
  private readonly projectNames: string[];

  /**
   * Create a new ProjectManager.
   *
   * @param config - Projects configuration from disclaude.config.yaml
   * @param workspaceDir - Workspace directory for resolving relative paths
   * @param loaderOptions - Optional custom loader options
   */
  constructor(
    config: ProjectsConfig,
    workspaceDir: string,
    loaderOptions?: KnowledgeBaseLoaderOptions
  ) {
    this.config = config;
    this.workspaceDir = workspaceDir;
    this.loader = new KnowledgeBaseLoader(loaderOptions);

    // Extract project names (filter out non-ProjectConfig values)
    this.projectNames = Object.keys(config).filter(name => {
      const val = config[name];
      return val && typeof val === 'object' && !Array.isArray(val);
    });

    if (this.projectNames.length > 0) {
      logger.info(
        { projects: this.projectNames, workspaceDir },
        'ProjectManager initialized'
      );
    }
  }

  /**
   * Get the currently active project for a chatId.
   *
   * Falls back to the first project in config order, or 'default' if available.
   *
   * @param chatId - Chat identifier
   * @returns Current project name, or undefined if no projects configured
   */
  getCurrentProject(chatId: string): string | undefined {
    // Check if there's an explicit project set for this chatId
    const current = this.currentProjects.get(chatId);
    if (current) {
      return current;
    }

    // Fall back to 'default' project if it exists
    if (this.config['default']) {
      return 'default';
    }

    // Fall back to first project in config
    if (this.projectNames.length > 0) {
      return this.projectNames[0];
    }

    return undefined;
  }

  /**
   * Switch the active project for a chatId.
   *
   * Clears the cached knowledge for the previous project (if different).
   *
   * @param chatId - Chat identifier
   * @param projectName - Name of the project to switch to
   * @returns true if switch was successful, false if project not found
   */
  switchProject(chatId: string, projectName: string): boolean {
    if (!this.projectNames.includes(projectName)) {
      logger.warn(
        { chatId, projectName, available: this.projectNames },
        'Cannot switch to unknown project'
      );
      return false;
    }

    const previous = this.currentProjects.get(chatId);
    this.currentProjects.set(chatId, projectName);

    if (previous !== projectName) {
      logger.info(
        { chatId, from: previous ?? 'default', to: projectName },
        'Switched project'
      );
    }

    return true;
  }

  /**
   * Get the loaded knowledge base content for a chatId's current project.
   *
   * Uses cached content if available, otherwise loads and caches it.
   *
   * @param chatId - Chat identifier
   * @returns Knowledge load result, or empty result if no project configured
   */
  async getProjectKnowledge(chatId: string): Promise<KnowledgeLoadResult> {
    const projectName = this.getCurrentProject(chatId);
    if (!projectName) {
      return { content: '', fileCount: 0, totalSize: 0, files: [], truncated: false };
    }

    return this.getProjectKnowledgeByName(projectName);
  }

  /**
   * Get the knowledge base content for a specific project by name.
   *
   * @param projectName - Project name
   * @returns Knowledge load result
   */
  async getProjectKnowledgeByName(projectName: string): Promise<KnowledgeLoadResult> {
    // Return cached result if available
    const cached = this.knowledgeCache.get(projectName);
    if (cached) {
      return cached;
    }

    // Load knowledge base for the project
    const projectConfig = this.config[projectName];
    if (!projectConfig || typeof projectConfig !== 'object') {
      return { content: '', fileCount: 0, totalSize: 0, files: [], truncated: false };
    }

    const knowledgeDirs = (projectConfig as ProjectConfig).knowledge;
    if (!knowledgeDirs || knowledgeDirs.length === 0) {
      const emptyResult: KnowledgeLoadResult = {
        content: '',
        fileCount: 0,
        totalSize: 0,
        files: [],
        truncated: false,
      };
      this.knowledgeCache.set(projectName, emptyResult);
      return emptyResult;
    }

    // Resolve relative paths against workspace directory
    const resolvedDirs = knowledgeDirs.map(dir => {
      return path.isAbsolute(dir) ? dir : path.resolve(this.workspaceDir, dir);
    });

    logger.info(
      { project: projectName, dirs: resolvedDirs },
      'Loading knowledge base for project'
    );

    try {
      const result = await this.loader.loadFromDirectories(resolvedDirs);
      this.knowledgeCache.set(projectName, result);

      logger.info(
        {
          project: projectName,
          fileCount: result.fileCount,
          totalSize: result.totalSize,
          truncated: result.truncated,
        },
        'Knowledge base loaded'
      );

      return result;
    } catch (error) {
      logger.error(
        { project: projectName, err: error instanceof Error ? error.message : String(error) },
        'Failed to load knowledge base'
      );
      const errorResult: KnowledgeLoadResult = {
        content: '',
        fileCount: 0,
        totalSize: 0,
        files: [],
        truncated: false,
      };
      this.knowledgeCache.set(projectName, errorResult);
      return errorResult;
    }
  }

  /**
   * List all configured projects with their metadata.
   *
   * @returns List of project info objects
   */
  listProjects(): ProjectInfo[] {
    return this.projectNames.map(name => {
      const config = this.config[name] as ProjectConfig | undefined;
      return {
        name,
        isDefault: name === 'default',
        knowledgeDirCount: config?.knowledge?.length ?? 0,
        hasInstructions: !!config?.instructionsPath,
      };
    });
  }

  /**
   * Clear the knowledge cache for a specific project.
   *
   * Useful when knowledge files have been updated and need to be reloaded.
   *
   * @param projectName - Project name to clear cache for
   * @returns true if cache was cleared, false if project not found
   */
  clearCache(projectName?: string): boolean {
    if (projectName) {
      if (!this.projectNames.includes(projectName)) {
        return false;
      }
      this.knowledgeCache.delete(projectName);
      return true;
    }

    // Clear all caches
    this.knowledgeCache.clear();
    return true;
  }

  /**
   * Get the raw project configuration.
   *
   * @param projectName - Project name
   * @returns Project config, or undefined if not found
   */
  getProjectConfig(projectName: string): ProjectConfig | undefined {
    const config = this.config[projectName];
    if (config && typeof config === 'object' && !Array.isArray(config)) {
      return config as ProjectConfig;
    }
    return undefined;
  }

  /**
   * Check if any projects are configured.
   *
   * @returns true if at least one project is configured
   */
  hasProjects(): boolean {
    return this.projectNames.length > 0;
  }
}
