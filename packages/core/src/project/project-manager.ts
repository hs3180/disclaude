/**
 * Project Manager.
 *
 * Manages project state including active project selection per chat,
 * project loading, and content caching.
 *
 * Issue #1916: Part of the Project Knowledge Base feature.
 *
 * Design:
 * - Thread-safe project state management
 * - Per-chatId active project tracking
 * - Content caching to avoid redundant file I/O
 * - Configurable default project
 * - Converts between YAML config format (snake_case) and internal format (camelCase)
 *
 * @module project/project-manager
 */

import { createLogger } from '../utils/logger.js';
import type {
  ProjectConfig,
  ProjectsConfig as CoreProjectsConfig,
  LoadedProject,
} from './types.js';
import type { ProjectsConfig } from '../config/types.js';
import { loadProject, formatProjectAsPromptSection } from './knowledge-loader.js';

const logger = createLogger('ProjectManager');

/**
 * Raw project config from YAML (snake_case keys).
 * Matches the format defined in config/types.ts ProjectsConfig.
 */
interface RawProjectConfig {
  name?: string;
  instructions_path?: string;
  knowledge?: string[];
  max_knowledge_length?: number;
}

/**
 * Convert raw YAML project config (snake_case) to internal ProjectConfig (camelCase).
 */
function toProjectConfig(raw: RawProjectConfig): ProjectConfig {
  return {
    name: raw.name,
    instructionsPath: raw.instructions_path,
    knowledge: raw.knowledge,
    maxKnowledgeLength: raw.max_knowledge_length,
  };
}

/**
 * Project Manager - manages project lifecycle and state.
 */
export class ProjectManager {
  private rawConfig: Record<string, RawProjectConfig>;
  private workspaceDir: string;
  private defaultProjectName: string | null;

  /** Cache of loaded projects: name -> LoadedProject */
  private projectCache = new Map<string, LoadedProject>();

  /** Active project per chatId: chatId -> projectName */
  private activeProjectPerChat = new Map<string, string>();

  constructor(
    config: ProjectsConfig | CoreProjectsConfig,
    workspaceDir: string,
    defaultProjectName?: string,
  ) {
    // Accept both config formats (snake_case from YAML and camelCase from internal types)
    this.rawConfig = config as Record<string, RawProjectConfig>;
    this.workspaceDir = workspaceDir;
    this.defaultProjectName = defaultProjectName ?? null;

    logger.info(
      {
        projectsCount: Object.keys(this.rawConfig).length,
        projectNames: Object.keys(this.rawConfig),
        defaultProject: this.defaultProjectName,
      },
      'ProjectManager initialized',
    );
  }

  /**
   * Get list of available project names.
   */
  listProjects(): string[] {
    return Object.keys(this.rawConfig);
  }

  /**
   * Check if a project exists.
   */
  hasProject(name: string): boolean {
    return name in this.rawConfig;
  }

  /**
   * Get the default project name.
   * Returns null if no projects are configured.
   */
  getDefaultProjectName(): string | null {
    if (this.defaultProjectName && this.hasProject(this.defaultProjectName)) {
      return this.defaultProjectName;
    }
    // Fall back to first project
    const names = this.listProjects();
    return names.length > 0 ? names[0] : null;
  }

  /**
   * Get the active project name for a chat.
   * Falls back to default project if none is set.
   */
  getActiveProjectName(chatId: string): string | null {
    const active = this.activeProjectPerChat.get(chatId);
    if (active && this.hasProject(active)) {
      return active;
    }
    return this.getDefaultProjectName();
  }

  /**
   * Set the active project for a chat.
   *
   * @param chatId - Chat ID
   * @param projectName - Project name to switch to
   * @returns true if switch was successful, false if project doesn't exist
   */
  switchProject(chatId: string, projectName: string): boolean {
    if (!this.hasProject(projectName)) {
      logger.warn({ projectName, chatId }, 'Cannot switch to non-existent project');
      return false;
    }

    const previous = this.activeProjectPerChat.get(chatId);
    this.activeProjectPerChat.set(chatId, projectName);

    logger.info(
      { chatId, from: previous ?? 'default', to: projectName },
      'Project switched',
    );
    return true;
  }

  /**
   * Clear the active project for a chat (revert to default).
   */
  clearProject(chatId: string): void {
    this.activeProjectPerChat.delete(chatId);
    logger.info({ chatId }, 'Project cleared, using default');
  }

  /**
   * Load a project (with caching).
   *
   * First checks the cache. If not cached, loads from filesystem.
   *
   * @param projectName - Name of the project to load
   * @returns LoadedProject, or null if project doesn't exist
   */
  async getOrLoadProject(projectName: string): Promise<LoadedProject | null> {
    if (!this.hasProject(projectName)) {
      return null;
    }

    // Check cache
    const cached = this.projectCache.get(projectName);
    if (cached) {
      return cached;
    }

    // Load from filesystem, converting from YAML config format
    const rawConfig = this.rawConfig[projectName]!;
    const config = toProjectConfig(rawConfig);
    const loaded = await loadProject(projectName, config, this.workspaceDir);
    this.projectCache.set(projectName, loaded);
    return loaded;
  }

  /**
   * Get the active project for a chat (loading if necessary).
   *
   * @param chatId - Chat ID
   * @returns LoadedProject for the active project, or null if no project available
   */
  async getActiveProject(chatId: string): Promise<LoadedProject | null> {
    const projectName = this.getActiveProjectName(chatId);
    if (!projectName) {
      return null;
    }
    return this.getOrLoadProject(projectName);
  }

  /**
   * Get formatted prompt section for the active project of a chat.
   *
   * This is the main entry point for MessageBuilder integration.
   * Returns an empty string if no project is configured or no content
   * is available.
   *
   * @param chatId - Chat ID
   * @returns Formatted Markdown section for prompt injection
   */
  async getProjectPromptSection(chatId: string): Promise<string> {
    const project = await this.getActiveProject(chatId);
    if (!project) {
      return '';
    }
    return formatProjectAsPromptSection(project);
  }

  /**
   * Invalidate cache for a specific project.
   * Next access will reload from filesystem.
   */
  invalidateCache(projectName?: string): void {
    if (projectName) {
      this.projectCache.delete(projectName);
      logger.info({ project: projectName }, 'Project cache invalidated');
    } else {
      this.projectCache.clear();
      logger.info('All project caches invalidated');
    }
  }

  /**
   * Get raw project configuration (without loading files).
   * Returns the YAML config format (snake_case).
   */
  getProjectConfig(projectName: string): RawProjectConfig | undefined {
    return this.rawConfig[projectName];
  }

  /**
   * Get the projects configuration.
   */
  getProjectsConfig(): Record<string, RawProjectConfig> {
    return this.rawConfig;
  }

  /**
   * Update projects configuration (for runtime reconfiguration).
   */
  updateConfig(newConfig: ProjectsConfig | CoreProjectsConfig): void {
    this.rawConfig = newConfig as Record<string, RawProjectConfig>;
    // Clear cache since config changed
    this.projectCache.clear();
    logger.info('Project configuration updated, cache cleared');
  }
}
