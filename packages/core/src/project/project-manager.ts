/**
 * ProjectManager — Core module for unified ProjectContext system.
 *
 * Manages templates, instances, and chatId bindings for per-chatId Agent context switching.
 *
 * Architecture:
 * - Templates: Built-in blueprints from {packageDir}/templates/{name}/CLAUDE.md
 * - Instances: User-created projects with independent workingDir
 * - Bindings: chatId → instance name mapping
 * - Default: Implicit project using workspace root as workingDir
 *
 * Persistence:
 * - Stored in {workspace}/.disclaude/projects.json
 * - Uses write-then-rename for atomicity
 *
 * @module project/project-manager
 * @see Issue #1916
 */

import path from 'path';
import fs from 'fs';
import { createLogger } from '../utils/logger.js';
import type {
  ProjectTemplate,
  ProjectTemplateConfig,
  ProjectContextConfig,
  InstanceInfo,
  CwdProvider,
  Result,
  ProjectData,
} from './types.js';

const logger = createLogger('ProjectManager');

/** Reserved instance name */
const DEFAULT_NAME = 'default';

/** Directory name for project instances under workspace */
const PROJECTS_DIR_NAME = 'projects';

/** File name for persisted project data */
const PROJECTS_DATA_FILE = 'projects.json';

export class ProjectManager {
  private templates = new Map<string, ProjectTemplate>();
  private projects = new Map<string, ProjectContextConfig>();
  private chatProjectMap = new Map<string, string>();
  private workspaceDir!: string;
  private templatesDir!: string;
  private initialized = false;

  /**
   * Initialize the ProjectManager.
   *
   * Loads templates from config (intersection with package built-in templates),
   * loads persisted instances and bindings from projects.json.
   *
   * @param workspaceDir - Workspace root directory
   * @param templatesDir - Package built-in templates directory
   * @param configTemplates - Templates from config file
   * @throws Error if workspaceDir is invalid
   */
  init(
    workspaceDir: string,
    templatesDir: string,
    configTemplates?: Record<string, ProjectTemplateConfig>,
  ): void {
    this.workspaceDir = path.resolve(workspaceDir);
    this.templatesDir = path.resolve(templatesDir);

    // Load templates: intersection of config and built-in
    this.loadTemplates(configTemplates);

    // Load persisted data
    this.loadPersistedData();

    this.initialized = true;
    logger.info(
      {
        templates: Array.from(this.templates.keys()),
        instances: Array.from(this.projects.keys()),
        bindings: Array.from(this.chatProjectMap.entries()),
      },
      'ProjectManager initialized',
    );
  }

  /**
   * Get the active project for a chatId.
   * Returns default project config if no binding exists.
   */
  getActive(chatId: string): ProjectContextConfig {
    this.ensureInitialized();
    const name = this.chatProjectMap.get(chatId);
    if (name && this.projects.has(name)) {
      return this.projects.get(name)!;
    }
    // Default project: workingDir = workspace root
    return { name: DEFAULT_NAME, workingDir: this.workspaceDir };
  }

  /**
   * Create a new instance from a template and bind to chatId.
   *
   * @param chatId - Chat ID to bind
   * @param templateName - Template to instantiate from
   * @param name - Instance name (must be globally unique)
   * @returns Result with the created project config
   */
  create(chatId: string, templateName: string, name: string): Result<ProjectContextConfig> {
    this.ensureInitialized();

    // Validate template
    if (!this.templates.has(templateName)) {
      return { ok: false, error: `模板 "${templateName}" 不存在。可用模板: ${this.getAvailableTemplateNames()}` };
    }

    // Validate name is not reserved
    if (name === DEFAULT_NAME) {
      return { ok: false, error: `"${DEFAULT_NAME}" 为保留名，请使用其他名称` };
    }

    // Validate name is not already taken
    if (this.projects.has(name)) {
      return { ok: false, error: `实例名 "${name}" 已存在，请使用 /project use ${name} 绑定` };
    }

    // Validate name is reasonable
    if (!name || name.includes('/') || name.includes('..')) {
      return { ok: false, error: '实例名不能为空或包含 / 或 ..' };
    }

    // Instantiate from template
    const result = this.instantiateFromTemplate(templateName, name);
    if (!result.ok) {
      return result;
    }

    const config = result.data;

    // Register instance
    this.projects.set(name, config);

    // Bind chatId
    this.chatProjectMap.set(chatId, name);

    // Persist
    this.persist();

    logger.info({ chatId, templateName, name, workingDir: config.workingDir }, 'Created project instance');
    return { ok: true, data: config };
  }

  /**
   * Bind to an existing instance.
   * Multiple chatIds can bind to the same instance (shared workspace).
   */
  use(chatId: string, name: string): Result<ProjectContextConfig> {
    this.ensureInitialized();

    if (name === DEFAULT_NAME) {
      // Use reset instead
      return this.reset(chatId);
    }

    if (!this.projects.has(name)) {
      return { ok: false, error: `实例 "${name}" 不存在。使用 /project list 查看可用实例` };
    }

    const config = this.projects.get(name)!;
    this.chatProjectMap.set(chatId, name);
    this.persist();

    logger.info({ chatId, name }, 'Bound chatId to project instance');
    return { ok: true, data: config };
  }

  /**
   * Reset to default project.
   * No-op if already on default.
   */
  reset(chatId: string): Result<ProjectContextConfig> {
    this.ensureInitialized();

    const wasBound = this.chatProjectMap.has(chatId);
    this.chatProjectMap.delete(chatId);
    this.persist();

    if (wasBound) {
      logger.info({ chatId }, 'Reset to default project');
    }
    return { ok: true, data: { name: DEFAULT_NAME, workingDir: this.workspaceDir } };
  }

  /**
   * List all available templates.
   */
  listTemplates(): ProjectTemplate[] {
    this.ensureInitialized();
    return Array.from(this.templates.values());
  }

  /**
   * List all instances with binding info. Does not include default.
   */
  listInstances(): InstanceInfo[] {
    this.ensureInitialized();

    // Build reverse map: name → chatIds[]
    const instanceChatIds = new Map<string, string[]>();
    for (const [chatId, name] of this.chatProjectMap.entries()) {
      const ids = instanceChatIds.get(name) || [];
      ids.push(chatId);
      instanceChatIds.set(name, ids);
    }

    const instances: InstanceInfo[] = [];
    for (const [name, config] of this.projects.entries()) {
      instances.push({
        name,
        templateName: config.templateName || 'unknown',
        chatIds: instanceChatIds.get(name) || [],
        workingDir: config.workingDir,
        createdAt: new Date().toISOString(), // Fallback if no persisted data
      });
    }

    return instances;
  }

  /**
   * Create a CwdProvider callback for use by Pilot.
   * Returns undefined for default project (falls through to getWorkspaceDir()).
   */
  createCwdProvider(): CwdProvider {
    return (chatId: string): string | undefined => {
      const config = this.getActive(chatId);
      // Return undefined for default to let BaseAgent use getWorkspaceDir()
      return config.name === DEFAULT_NAME ? undefined : config.workingDir;
    };
  }

  // ==========================================================================
  // Private methods
  // ==========================================================================

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('ProjectManager not initialized. Call init() first.');
    }
  }

  private getAvailableTemplateNames(): string {
    return Array.from(this.templates.keys()).join(', ') || '(无)';
  }

  /**
   * Load templates from config (intersection with built-in templates).
   */
  private loadTemplates(configTemplates?: Record<string, ProjectTemplateConfig>): void {
    if (!configTemplates || Object.keys(configTemplates).length === 0) {
      // No config templates → no templates available
      return;
    }

    for (const [name, config] of Object.entries(configTemplates)) {
      // Check if template directory exists in package
      const templateDir = path.join(this.templatesDir, name);
      const claudeMdPath = path.join(templateDir, 'CLAUDE.md');

      if (fs.existsSync(claudeMdPath)) {
        this.templates.set(name, {
          name,
          displayName: config.displayName,
          description: config.description,
        });
      } else {
        logger.warn(
          { name, templateDir, claudeMdPath },
          'Template CLAUDE.md not found, skipping template',
        );
      }
    }
  }

  /**
   * Load persisted data from projects.json.
   */
  private loadPersistedData(): void {
    const dataPath = this.getPersistPath();

    if (!fs.existsSync(dataPath)) {
      return;
    }

    try {
      const raw = fs.readFileSync(dataPath, 'utf-8');
      const data: ProjectData = JSON.parse(raw);

      // Restore projects
      if (data.projects) {
        for (const [name, info] of Object.entries(data.projects)) {
          const workingDir = path.join(this.workspaceDir, PROJECTS_DIR_NAME, name);
          this.projects.set(name, {
            name,
            templateName: info.templateName,
            workingDir,
          });
        }
      }

      // Restore bindings
      if (data.chatProjectMap) {
        for (const [chatId, name] of Object.entries(data.chatProjectMap)) {
          // Only restore if the project still exists
          if (this.projects.has(name)) {
            this.chatProjectMap.set(chatId, name);
          }
        }
      }

      logger.debug(
        { projectsCount: this.projects.size, bindingsCount: this.chatProjectMap.size },
        'Loaded persisted project data',
      );
    } catch (error) {
      logger.warn({ error, dataPath }, 'Failed to load projects.json, starting fresh');
    }
  }

  /**
   * Persist current state to projects.json.
   * Uses write-then-rename for atomicity.
   */
  private persist(): void {
    const dataPath = this.getPersistPath();
    const dir = path.dirname(dataPath);

    // Ensure directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Build data
    const data: ProjectData = {
      projects: {},
      chatProjectMap: Object.fromEntries(this.chatProjectMap.entries()),
    };

    for (const [name, config] of this.projects.entries()) {
      data.projects[name] = {
        templateName: config.templateName || 'unknown',
        createdAt: new Date().toISOString(),
      };
    }

    // Atomic write: write to temp file, then rename
    const tmpPath = dataPath + '.tmp';
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8'); // eslint-disable-line prefer-template
      fs.renameSync(tmpPath, dataPath);
    } catch (persistError) {
      logger.error({ error: persistError, dataPath }, 'Failed to persist project data');
      // Clean up temp file if rename failed
      try {
        if (fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Instantiate a project from a template.
   */
  private instantiateFromTemplate(templateName: string, name: string): Result<ProjectContextConfig> {
    const workingDir = path.join(this.workspaceDir, PROJECTS_DIR_NAME, name);

    // Create working directory
    try {
      fs.mkdirSync(workingDir, { recursive: true });
    } catch (error) {
      return { ok: false, error: `无法创建项目目录: ${workingDir}` };
    }

    // Copy CLAUDE.md from template
    const copyResult = this.copyClaudeMd(templateName, workingDir);
    if (!copyResult.ok) {
      // Rollback: remove created directory
      try {
        fs.rmSync(workingDir, { recursive: true, force: true });
      } catch {
        // Ignore rollback errors
      }
      return copyResult;
    }

    return {
      ok: true,
      data: {
        name,
        templateName,
        workingDir,
      },
    };
  }

  /**
   * Copy CLAUDE.md from package built-in template to instance workingDir.
   */
  private copyClaudeMd(templateName: string, targetDir: string): Result<void> {
    const sourcePath = path.join(this.templatesDir, templateName, 'CLAUDE.md');
    const targetPath = path.join(targetDir, 'CLAUDE.md');

    if (!fs.existsSync(sourcePath)) {
      return { ok: false, error: `模板文件不存在: ${sourcePath}` };
    }

    try {
      fs.copyFileSync(sourcePath, targetPath);
      return { ok: true, data: undefined };
    } catch (error) {
      return {
        ok: false,
        error: `无法复制 CLAUDE.md: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Get the persistence file path.
   */
  private getPersistPath(): string {
    return path.join(this.workspaceDir, '.disclaude', PROJECTS_DATA_FILE);
  }
}
