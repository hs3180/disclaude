/**
 * Project state manager.
 *
 * Manages per-chat project state, including current project selection
 * and knowledge base caching.
 *
 * Implements Issue #1916: Project-scoped knowledge base.
 *
 * @module knowledge/project-manager
 */

import { createLogger } from '../utils/logger.js';
import type {
  ProjectsConfig,
  ProjectConfig,
  ProjectState,
  ProjectSummary,
  KnowledgeLoadResult,
} from './types.js';
import { loadProjectKnowledge, buildKnowledgeSection } from './loader.js';

const logger = createLogger('ProjectManager');

/**
 * Cache entry for loaded project knowledge.
 */
interface KnowledgeCacheEntry {
  /** Loaded knowledge result */
  result: KnowledgeLoadResult;
  /** Formatted knowledge section for prompt injection */
  formattedSection: string;
  /** Timestamp when the cache was populated */
  loadedAt: number;
}

/**
 * Project manager for managing project state and knowledge base.
 *
 * Features:
 * - Per-chat project state tracking
 * - Knowledge base caching with TTL
 * - Project listing and switching
 */
export class ProjectManager {
  private readonly projectsConfig: ProjectsConfig;
  private readonly baseDir: string;
  private readonly defaultProject: string;

  /** Per-chat project state */
  private readonly chatStates = new Map<string, ProjectState>();

  /** Knowledge cache */
  private readonly knowledgeCache = new Map<string, KnowledgeCacheEntry>();

  /** Cache TTL in milliseconds (5 minutes) */
  private readonly cacheTtlMs: number;

  constructor(
    projectsConfig: ProjectsConfig,
    baseDir: string,
    options?: { cacheTtlMs?: number }
  ) {
    this.projectsConfig = projectsConfig;
    this.baseDir = baseDir;
    this.defaultProject = Object.keys(projectsConfig)[0] || 'default';
    this.cacheTtlMs = options?.cacheTtlMs ?? 5 * 60 * 1000;
  }

  /**
   * Get the current project name for a chat.
   *
   * @param chatId - Chat identifier
   * @returns Current project name
   */
  getCurrentProject(chatId: string): string {
    return this.chatStates.get(chatId)?.currentProject ?? this.defaultProject;
  }

  /**
   * Switch the current project for a chat.
   *
   * @param chatId - Chat identifier
   * @param projectName - Name of the project to switch to
   * @returns true if switch was successful, false if project not found
   */
  switchProject(chatId: string, projectName: string): boolean {
    if (!this.projectsConfig[projectName]) {
      logger.warn({ chatId, projectName }, 'Project not found');
      return false;
    }

    const previousProject = this.getCurrentProject(chatId);
    this.chatStates.set(chatId, {
      currentProject: projectName,
      switchedAt: Date.now(),
    });

    logger.info(
      { chatId, from: previousProject, to: projectName },
      'Project switched'
    );
    return true;
  }

  /**
   * Get the project configuration for the current project of a chat.
   *
   * @param chatId - Chat identifier
   * @returns Project configuration, or default project config
   */
  getProjectConfig(chatId: string): ProjectConfig {
    const projectName = this.getCurrentProject(chatId);
    return this.projectsConfig[projectName] || {};
  }

  /**
   * Load and cache knowledge for a chat's current project.
   *
   * Uses caching to avoid re-reading files on every message.
   * Cache is invalidated after TTL expires.
   *
   * @param chatId - Chat identifier
   * @returns Knowledge load result
   */
  async loadKnowledge(chatId: string): Promise<KnowledgeLoadResult> {
    const projectName = this.getCurrentProject(chatId);
    const cacheKey = `${chatId}:${projectName}`;

    // Check cache
    const cached = this.knowledgeCache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < this.cacheTtlMs) {
      logger.debug(
        { chatId, projectName, cacheAge: Date.now() - cached.loadedAt },
        'Using cached knowledge'
      );
      return cached.result;
    }

    // Load fresh knowledge
    const projectConfig = this.projectsConfig[projectName] || {};
    const result = await loadProjectKnowledge(projectName, projectConfig, this.baseDir);

    // Update cache
    const formattedSection = buildKnowledgeSection(result);
    this.knowledgeCache.set(cacheKey, {
      result,
      formattedSection,
      loadedAt: Date.now(),
    });

    return result;
  }

  /**
   * Get the formatted knowledge section for a chat's current project.
   *
   * This is the string that gets injected into the agent prompt.
   *
   * @param chatId - Chat identifier
   * @returns Formatted knowledge section, or empty string if no content
   */
  async getKnowledgeSection(chatId: string): Promise<string> {
    const projectName = this.getCurrentProject(chatId);
    const cacheKey = `${chatId}:${projectName}`;

    // Check cache
    const cached = this.knowledgeCache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < this.cacheTtlMs) {
      return cached.formattedSection;
    }

    // Load and cache
    await this.loadKnowledge(chatId);
    const freshCached = this.knowledgeCache.get(cacheKey);
    return freshCached?.formattedSection ?? '';
  }

  /**
   * Invalidate knowledge cache for a specific chat.
   *
   * Useful after knowledge files are modified.
   *
   * @param chatId - Chat identifier
   */
  invalidateCache(chatId: string): void {
    const projectName = this.getCurrentProject(chatId);
    const cacheKey = `${chatId}:${projectName}`;
    this.knowledgeCache.delete(cacheKey);
    logger.debug({ chatId, projectName }, 'Knowledge cache invalidated');
  }

  /**
   * Invalidate all knowledge caches.
   */
  invalidateAllCaches(): void {
    this.knowledgeCache.clear();
    logger.info('All knowledge caches invalidated');
  }

  /**
   * List all available projects with summaries.
   *
   * @returns List of project summaries
   */
  listProjects(): ProjectSummary[] {
    return Object.entries(this.projectsConfig).map(([name, config]) => ({
      name,
      isDefault: name === this.defaultProject,
      hasInstructions: !!config.instructions_path,
      knowledgeDirCount: config.knowledge?.length ?? 0,
    }));
  }

  /**
   * Clear chat state for a specific chat.
   *
   * @param chatId - Chat identifier
   */
  clearChatState(chatId: string): void {
    this.chatStates.delete(chatId);
    // Also invalidate related caches
    for (const key of this.knowledgeCache.keys()) {
      if (key.startsWith(`${chatId}:`)) {
        this.knowledgeCache.delete(key);
      }
    }
  }

  /**
   * Check if projects are configured.
   *
   * @returns true if at least one project is configured
   */
  hasProjects(): boolean {
    return Object.keys(this.projectsConfig).length > 0;
  }
}

/**
 * Create a project manager from config.
 *
 * @param projectsConfig - Projects configuration from disclaude.config.yaml
 * @param baseDir - Base directory for resolving relative paths
 * @param options - Optional configuration
 * @returns ProjectManager instance, or null if no projects configured
 */
export function createProjectManager(
  projectsConfig: ProjectsConfig | undefined,
  baseDir: string,
  options?: { cacheTtlMs?: number }
): ProjectManager | null {
  if (!projectsConfig || Object.keys(projectsConfig).length === 0) {
    return null;
  }

  return new ProjectManager(projectsConfig, baseDir, options);
}
