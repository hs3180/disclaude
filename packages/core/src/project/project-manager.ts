/**
 * Project Manager — Manages project configurations, knowledge base loading,
 * and per-chat project assignments.
 *
 * Issue #1916: Claude Projects-like knowledge base and instructions.
 *
 * Responsibilities:
 * - Load project configs from disclaude.config.yaml
 * - Resolve and read CLAUDE.md instructions per project
 * - Scan and read knowledge base files from configured directories
 * - Maintain chatId -> project mapping for session-scoped projects
 *
 * @module project/project-manager
 */

import path from 'path';
import fs from 'fs';
import { createLogger } from '../utils/logger.js';
import type {
  ProjectConfig,
  ProjectsConfig,
  KnowledgeFileEntry,
  ProjectContext,
} from '../config/types.js';
import {
  SUPPORTED_EXTENSIONS,
  DEFAULT_MAX_KNOWLEDGE_CHARS,
} from './context-builder.js';

const logger = createLogger('ProjectManager');

/**
 * ProjectManager handles project-scoped instructions and knowledge base.
 *
 * Usage:
 * ```typescript
 * const pm = new ProjectManager(projectsConfig, workspaceDir);
 * const ctx = pm.loadProject('default');
 * const section = buildProjectContextSection(ctx);
 * ```
 */
export class ProjectManager {
  private readonly projects: ProjectsConfig;
  private readonly workspaceDir: string;
  private readonly chatProjectMap = new Map<string, string>();
  private readonly projectCache = new Map<string, ProjectContext>();

  constructor(projects: ProjectsConfig, workspaceDir: string) {
    this.projects = projects || {};
    this.workspaceDir = workspaceDir;
  }

  /**
   * Get the list of available project names.
   */
  listProjects(): string[] {
    return Object.keys(this.projects);
  }

  /**
   * Check if a project exists.
   */
  hasProject(name: string): boolean {
    return name in this.projects;
  }

  /**
   * Get the project configuration for a given project name.
   */
  getProjectConfig(name: string): ProjectConfig | undefined {
    return this.projects[name];
  }

  /**
   * Get the current project name for a chat.
   * Falls back to 'default' if the chat has no assigned project.
   */
  getProjectForChat(chatId: string): string {
    return this.chatProjectMap.get(chatId) || 'default';
  }

  /**
   * Set the active project for a chat.
   *
   * @returns true if the project exists and was set, false otherwise
   */
  setProjectForChat(chatId: string, projectName: string): boolean {
    if (!this.hasProject(projectName)) {
      return false;
    }
    this.chatProjectMap.set(chatId, projectName);
    // Invalidate cache when switching projects
    this.projectCache.delete(projectName);
    return true;
  }

  /**
   * Clear the project assignment for a chat (reverts to default).
   */
  clearProjectForChat(chatId: string): void {
    this.chatProjectMap.delete(chatId);
  }

  /**
   * Load and return the full project context (instructions + knowledge files).
   * Results are cached until explicitly invalidated.
   *
   * @param name - Project name (defaults to 'default')
   * @returns ProjectContext with loaded content, or a minimal context if project not found
   */
  loadProject(name?: string): ProjectContext {
    const projectName = name || 'default';
    const config = this.projects[projectName];

    // Return cached result if available
    const cached = this.projectCache.get(projectName);
    if (cached) {
      return cached;
    }

    const context: ProjectContext = {
      name: projectName,
      instructions: undefined,
      knowledgeFiles: [],
      totalChars: 0,
    };

    if (!config) {
      logger.debug({ projectName }, 'Project not found, returning empty context');
      return context;
    }

    // Load instructions (CLAUDE.md)
    if (config.instructionsPath) {
      context.instructions = this.loadInstructions(config.instructionsPath);
      if (context.instructions) {
        context.totalChars += context.instructions.length;
      }
    }

    // Load knowledge base files
    if (config.knowledge && config.knowledge.length > 0) {
      context.knowledgeFiles = this.loadKnowledgeFiles(config.knowledge);
      context.totalChars += context.knowledgeFiles.reduce((sum, f) => sum + f.content.length, 0);
    }

    logger.info(
      {
        project: projectName,
        hasInstructions: !!context.instructions,
        knowledgeFileCount: context.knowledgeFiles.length,
        totalChars: context.totalChars,
      },
      'Project context loaded',
    );

    this.projectCache.set(projectName, context);
    return context;
  }

  /**
   * Reload a project's context (invalidate cache and reload).
   */
  reloadProject(name: string): ProjectContext {
    this.projectCache.delete(name);
    return this.loadProject(name);
  }

  /**
   * Get the loaded project context for a chat's active project.
   */
  loadProjectForChat(chatId: string): ProjectContext {
    const projectName = this.getProjectForChat(chatId);
    return this.loadProject(projectName);
  }

  /**
   * Load instructions from a CLAUDE.md file (or any specified path).
   *
   * @param instructionsPath - Path to instructions file (relative or absolute)
   * @returns File content as string, or undefined if file not found/empty
   */
  private loadInstructions(instructionsPath: string): string | undefined {
    const resolvedPath = path.isAbsolute(instructionsPath)
      ? instructionsPath
      : path.resolve(this.workspaceDir, instructionsPath);

    try {
      if (!fs.existsSync(resolvedPath)) {
        logger.warn({ path: resolvedPath }, 'Instructions file not found');
        return undefined;
      }

      const content = fs.readFileSync(resolvedPath, 'utf-8').trim();
      if (!content) {
        logger.warn({ path: resolvedPath }, 'Instructions file is empty');
        return undefined;
      }

      logger.info({ path: resolvedPath, chars: content.length }, 'Instructions loaded');
      return content;
    } catch (err) {
      logger.error({ err, path: resolvedPath }, 'Failed to load instructions file');
      return undefined;
    }
  }

  /**
   * Load knowledge base files from configured directories.
   *
   * Scans directories recursively for supported file types,
   * reads their content, and returns structured entries.
   *
   * @param knowledgeDirs - List of directory paths to scan
   * @returns Array of knowledge file entries
   */
  private loadKnowledgeFiles(knowledgeDirs: string[]): KnowledgeFileEntry[] {
    const files: KnowledgeFileEntry[] = [];
    let totalChars = 0;

    for (const dir of knowledgeDirs) {
      const resolvedDir = path.isAbsolute(dir)
        ? dir
        : path.resolve(this.workspaceDir, dir);

      try {
        if (!fs.existsSync(resolvedDir)) {
          logger.warn({ dir: resolvedDir }, 'Knowledge directory not found');
          continue;
        }

        const stat = fs.statSync(resolvedDir);
        if (!stat.isDirectory()) {
          logger.warn({ dir: resolvedDir }, 'Knowledge path is not a directory');
          continue;
        }

        const dirFiles = this.scanDirectory(resolvedDir);
        files.push(...dirFiles);
        totalChars += dirFiles.reduce((sum, f) => sum + f.content.length, 0);
      } catch (err) {
        logger.error({ err, dir: resolvedDir }, 'Failed to load knowledge directory');
      }
    }

    if (totalChars > DEFAULT_MAX_KNOWLEDGE_CHARS) {
      logger.warn(
        {
          totalChars,
          maxChars: DEFAULT_MAX_KNOWLEDGE_CHARS,
          fileCount: files.length,
        },
        'Knowledge base exceeds recommended size, consider reducing content',
      );
    }

    return files;
  }

  /**
   * Recursively scan a directory for supported file types.
   *
   * @param dir - Absolute directory path
   * @param maxDepth - Maximum recursion depth (default: 3)
   * @returns Array of knowledge file entries
   */
  private scanDirectory(dir: string, maxDepth: number = 3): KnowledgeFileEntry[] {
    const files: KnowledgeFileEntry[] = [];

    const scan = (currentDir: string, depth: number) => {
      if (depth > maxDepth) return;

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);

        // Skip hidden files and directories
        if (entry.name.startsWith('.')) continue;

        if (entry.isDirectory()) {
          scan(fullPath, depth + 1);
          continue;
        }

        if (!entry.isFile()) continue;

        const ext = path.extname(entry.name).toLowerCase().replace('.', '');
        if (!SUPPORTED_EXTENSIONS.includes(ext)) continue;

        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          if (!content.trim()) continue;

          files.push({
            path: fullPath,
            name: entry.name,
            content: content.trim(),
            size: Buffer.byteLength(content, 'utf-8'),
            extension: ext,
          });
        } catch {
          logger.warn({ path: fullPath }, 'Failed to read knowledge file');
        }
      }
    };

    scan(dir, 0);
    return files;
  }
}
