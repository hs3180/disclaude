/**
 * ProjectManager — Core module for the unified ProjectContext system.
 *
 * Manages templates, instances, and bindings between chatIds and projects.
 *
 * Two-layer architecture:
 * - Template (blueprint for creating projects)
 * - Instance (concrete project with its own workingDir)
 *
 * Key behaviors:
 * - "default" project is always implicitly available (workingDir = workspace root)
 * - Templates define available blueprints; instances are snapshots at creation time
 * - Multiple chatIds can bind to the same instance (shared workspace)
 * - Persistence via projects.json in {workspace}/.disclaude/
 *
 * @see Issue #1916 - Feature: 统一 ProjectContext 系统
 * @see docs/proposals/unified-project-context.md
 * @module project/project-manager
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger, type Logger } from '../utils/logger.js';
import type {
  ProjectTemplate,
  ProjectContextConfig,
  InstanceInfo,
  ProjectResult,
  CwdProvider,
  ProjectTemplatesConfig,
  ProjectsPersistData,
} from './types.js';

/** Reserved instance name for the default project */
const DEFAULT_INSTANCE_NAME = 'default';

/** Directory name for project instances under workspace */
const PROJECTS_DIR_NAME = 'projects';

/** Directory name for disclaude config under workspace */
const DISCLAUDE_DIR_NAME = '.disclaude';

/** File name for persistence */
const PROJECTS_FILE_NAME = 'projects.json';

/**
 * ProjectManager initialization options.
 */
export interface ProjectManagerOptions {
  /** Workspace root directory */
  workspaceDir: string;

  /** Package directory containing built-in templates */
  packageDir?: string;

  /** Templates configuration from disclaude.config.yaml */
  templatesConfig?: ProjectTemplatesConfig;

  /** Custom logger instance */
  logger?: Logger;
}

/**
 * ProjectManager — Manages project templates, instances, and chatId bindings.
 *
 * Usage:
 * ```typescript
 * const pm = new ProjectManager({ workspaceDir: '/path/to/workspace' });
 * pm.init({ projectTemplates: { research: { displayName: '研究模式' } } });
 *
 * // Create an instance from a template
 * const result = pm.create('chat-123', 'research', 'my-research');
 *
 * // Get the active project for a chatId
 * const config = pm.getActive('chat-123');
 *
 * // Create a CwdProvider for Pilot integration
 * const cwdProvider: CwdProvider = (chatId) => pm.getActive(chatId).workingDir;
 * ```
 */
export class ProjectManager {
  private readonly workspaceDir: string;
  private readonly packageDir: string | undefined;
  private readonly logger: Logger;

  /** Available templates (intersection of built-in and configured) */
  private templates = new Map<string, ProjectTemplate>();

  /** Project instances (name → config) */
  private projects = new Map<string, ProjectContextConfig & { createdAt: string }>();

  /** chatId → instance name binding */
  private chatProjectMap = new Map<string, string>();

  /** Path to persistence file */
  private persistFilePath: string;

  constructor(options: ProjectManagerOptions) {
    this.workspaceDir = options.workspaceDir;
    this.packageDir = options.packageDir;
    this.logger = options.logger ?? createLogger('ProjectManager');
    this.persistFilePath = path.join(
      this.workspaceDir,
      DISCLAUDE_DIR_NAME,
      PROJECTS_FILE_NAME,
    );
  }

  /**
   * Initialize the ProjectManager.
   *
   * Loads templates (intersection of built-in and configured),
   * existing instances and bindings from persistence.
   *
   * @param templatesConfig - Templates configuration from disclaude.config.yaml
   * @throws If persistence file exists but is corrupted
   */
  init(templatesConfig?: ProjectTemplatesConfig): void {
    // Load templates from configuration
    this.loadTemplates(templatesConfig);

    // Load persisted data
    this.loadPersistedData();

    this.logger.info(
      { templates: this.templates.size, instances: this.projects.size, bindings: this.chatProjectMap.size },
      'ProjectManager initialized',
    );
  }

  /**
   * Get the active project for a chatId.
   *
   * Returns the default project if no binding exists.
   * The default project's workingDir is the workspace root.
   *
   * @param chatId - Chat identifier
   * @returns ProjectContextConfig for the active project
   */
  getActive(chatId: string): ProjectContextConfig {
    const name = this.chatProjectMap.get(chatId);
    if (!name) {
      return this.getDefaultConfig();
    }

    const project = this.projects.get(name);
    if (!project) {
      // Binding exists but instance was removed — fall back to default
      this.chatProjectMap.delete(chatId);
      this.logger.warn(
        { chatId, name },
        'Project binding references non-existent instance, falling back to default',
      );
      return this.getDefaultConfig();
    }

    return project;
  }

  /**
   * Create a new project instance from a template and bind it to the chatId.
   *
   * @param chatId - Chat identifier
   * @param templateName - Name of the template to instantiate
   * @param name - Name for the new instance (globally unique)
   * @returns Result with the created project config, or an error
   */
  create(chatId: string, templateName: string, name: string): ProjectResult<ProjectContextConfig> {
    // Validate: template must exist
    if (!this.templates.has(templateName)) {
      return { ok: false, error: `模板 "${templateName}" 不存在。可用模板: ${this.getAvailableTemplateNames()}` };
    }

    // Validate: "default" is reserved
    if (name === DEFAULT_INSTANCE_NAME) {
      return { ok: false, error: `"${DEFAULT_INSTANCE_NAME}" 为保留名，请使用其他名称` };
    }

    // Validate: instance name must not already exist
    if (this.projects.has(name)) {
      return { ok: false, error: `实例名 "${name}" 已存在，请使用 /project use 绑定` };
    }

    // Instantiate from template
    const instantiateResult = this.instantiateFromTemplate(templateName, name);
    if (!instantiateResult.ok) {
      return instantiateResult;
    }

    // Bind chatId to the new instance
    this.chatProjectMap.set(chatId, name);

    // Persist
    this.persist();

    this.logger.info(
      { chatId, templateName, name, workingDir: instantiateResult.data.workingDir },
      'Project instance created and bound',
    );

    return { ok: true, data: instantiateResult.data };
  }

  /**
   * Bind a chatId to an existing project instance.
   *
   * @param chatId - Chat identifier
   * @param name - Name of the existing instance
   * @returns Result with the project config, or an error
   */
  use(chatId: string, name: string): ProjectResult<ProjectContextConfig> {
    // Validate: "default" should use reset instead
    if (name === DEFAULT_INSTANCE_NAME) {
      return { ok: false, error: `请使用 /project reset 切换到默认项目` };
    }

    // Validate: instance must exist
    const project = this.projects.get(name);
    if (!project) {
      return { ok: false, error: `实例 "${name}" 不存在。使用 /project list 查看可用实例` };
    }

    // Bind chatId to instance
    this.chatProjectMap.set(chatId, name);

    // Persist
    this.persist();

    this.logger.info(
      { chatId, name, workingDir: project.workingDir },
      'Chat bound to existing project instance',
    );

    return { ok: true, data: project };
  }

  /**
   * Reset a chatId to the default project.
   *
   * If already on default, this is a no-op.
   *
   * @param chatId - Chat identifier
   * @returns Result with the default project config
   */
  reset(chatId: string): ProjectResult<ProjectContextConfig> {
    const wasBound = this.chatProjectMap.has(chatId);

    this.chatProjectMap.delete(chatId);

    if (wasBound) {
      this.persist();
      this.logger.info({ chatId }, 'Chat reset to default project');
    }

    return { ok: true, data: this.getDefaultConfig() };
  }

  /**
   * List all available templates.
   *
   * @returns Array of available project templates
   */
  listTemplates(): ProjectTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * List all project instances (excluding "default").
   *
   * @returns Array of instance info with binding relationships
   */
  listInstances(): InstanceInfo[] {
    const instances: InstanceInfo[] = [];

    for (const [name, project] of this.projects) {
      // Collect all chatIds bound to this instance
      const chatIds: string[] = [];
      for (const [chatId, instanceName] of this.chatProjectMap) {
        if (instanceName === name) {
          chatIds.push(chatId);
        }
      }

      instances.push({
        name,
        templateName: project.templateName ?? name,
        chatIds,
        workingDir: project.workingDir,
        createdAt: project.createdAt,
      });
    }

    return instances;
  }

  /**
   * Create a CwdProvider function for Pilot integration.
   *
   * The returned function dynamically queries the current project's
   * workingDir for a given chatId. Returns undefined for default
   * projects (letting BaseAgent use getWorkspaceDir()).
   *
   * @returns CwdProvider function
   */
  createCwdProvider(): CwdProvider {
    return (chatId: string): string | undefined => {
      const config = this.getActive(chatId);
      // Return undefined for default project → BaseAgent uses getWorkspaceDir()
      if (config.name === DEFAULT_INSTANCE_NAME) {
        return undefined;
      }
      return config.workingDir;
    };
  }

  // ── Internal Methods ─────────────────────────────────────────────

  /**
   * Get the default project configuration.
   */
  private getDefaultConfig(): ProjectContextConfig {
    return {
      name: DEFAULT_INSTANCE_NAME,
      workingDir: this.workspaceDir,
    };
  }

  /**
   * Load templates from configuration.
   *
   * Templates are defined in disclaude.config.yaml under `projectTemplates`.
   * Only templates listed in config are available (even if built-in files exist).
   */
  private loadTemplates(config?: ProjectTemplatesConfig): void {
    if (!config) {
      this.logger.info('No projectTemplates configured, only default project available');
      return;
    }

    for (const [name, meta] of Object.entries(config)) {
      this.templates.set(name, {
        name,
        displayName: meta.displayName,
        description: meta.description,
      });
    }

    this.logger.info(
      { templates: Array.from(this.templates.keys()) },
      'Templates loaded from configuration',
    );
  }

  /**
   * Instantiate a project from a template.
   *
   * Creates the working directory and copies CLAUDE.md from the template.
   *
   * @param templateName - Template to instantiate from
   * @param name - Instance name
   * @returns Result with the created project config, or an error
   */
  private instantiateFromTemplate(
    templateName: string,
    name: string,
  ): ProjectResult<ProjectContextConfig> {
    const workingDir = path.join(this.workspaceDir, PROJECTS_DIR_NAME, name);

    // Create working directory
    try {
      fs.mkdirSync(workingDir, { recursive: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `无法创建工作目录: ${message}` };
    }

    // Copy CLAUDE.md from template
    const copyResult = this.copyClaudeMd(templateName, workingDir);
    if (!copyResult.ok) {
      // Rollback: remove created directory
      this.safeRmdir(workingDir);
      return { ok: false, error: copyResult.error };
    }

    const config: ProjectContextConfig & { createdAt: string } = {
      name,
      templateName,
      workingDir,
      createdAt: new Date().toISOString(),
    };

    // Register instance
    this.projects.set(name, config);

    return { ok: true, data: config };
  }

  /**
   * Copy CLAUDE.md from a template's source to the instance workingDir.
   *
   * Source: {packageDir}/templates/{templateName}/CLAUDE.md
   * Target: {workingDir}/CLAUDE.md
   *
   * @param templateName - Template name
   * @param targetDir - Instance working directory
   * @returns Result indicating success or failure
   */
  private copyClaudeMd(templateName: string, targetDir: string): ProjectResult<void> {
    if (!this.packageDir) {
      this.logger.warn(
        { templateName },
        'No packageDir configured, skipping CLAUDE.md copy',
      );
      return { ok: true, data: undefined };
    }

    const sourcePath = path.join(
      this.packageDir,
      'templates',
      templateName,
      'CLAUDE.md',
    );
    const targetPath = path.join(targetDir, 'CLAUDE.md');

    try {
      fs.copyFileSync(sourcePath, targetPath);
      this.logger.debug(
        { source: sourcePath, target: targetPath },
        'CLAUDE.md copied from template',
      );
      return { ok: true, data: undefined };
    } catch (err) {
      if (isFileNotFoundError(err)) {
        return {
          ok: false,
          error: `模板 "${templateName}" 的 CLAUDE.md 文件不存在 (${sourcePath})`,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `复制 CLAUDE.md 失败: ${message}` };
    }
  }

  /**
   * Load persisted data from projects.json.
   *
   * Uses write-then-rename pattern for atomic reads.
   * If the file doesn't exist, starts with empty state.
   */
  private loadPersistedData(): void {
    try {
      const data = fs.readFileSync(this.persistFilePath, 'utf-8');
      const parsed: ProjectsPersistData = JSON.parse(data);

      // Restore instances
      if (parsed.projects) {
        for (const [name, projectData] of Object.entries(parsed.projects)) {
          this.projects.set(name, {
            name,
            templateName: projectData.templateName,
            workingDir: projectData.workingDir,
            createdAt: projectData.createdAt,
          });
        }
      }

      // Restore bindings
      if (parsed.chatProjectMap) {
        for (const [chatId, name] of Object.entries(parsed.chatProjectMap)) {
          this.chatProjectMap.set(chatId, name);
        }
      }

      this.logger.info(
        { instances: this.projects.size, bindings: this.chatProjectMap.size },
        'Persisted data loaded',
      );
    } catch (err) {
      if (isFileNotFoundError(err)) {
        this.logger.debug('No persisted data file found, starting fresh');
        return;
      }
      throw new Error(
        `Failed to load projects.json: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Persist current state to projects.json.
   *
   * Uses write-then-rename pattern for atomicity.
   */
  private persist(): void {
    try {
      const data: ProjectsPersistData = {
        projects: Object.fromEntries(
          Array.from(this.projects.entries()).map(([name, project]) => [
            name,
            {
              templateName: project.templateName ?? name,
              workingDir: project.workingDir,
              createdAt: project.createdAt,
            },
          ]),
        ),
        chatProjectMap: Object.fromEntries(this.chatProjectMap),
      };

      // Ensure directory exists
      const dir = path.dirname(this.persistFilePath);
      fs.mkdirSync(dir, { recursive: true });

      // Write to temp file first, then rename (atomic on POSIX)
      const tmpPath = this.persistFilePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.persistFilePath);
    } catch (err) {
      this.logger.error(
        { err },
        'Failed to persist projects.json',
      );
    }
  }

  /**
   * Get comma-separated list of available template names.
   */
  private getAvailableTemplateNames(): string {
    return Array.from(this.templates.keys()).join(', ') || '(无)';
  }

  /**
   * Safely remove a directory (ignores errors if it doesn't exist).
   */
  private safeRmdir(dirPath: string): void {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
    } catch {
      // Ignore errors during cleanup
    }
  }
}

// ── Utility Functions ───────────────────────────────────────────────

/**
 * Check if an error is a "file not found" error.
 */
function isFileNotFoundError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    return (err as { code: string }).code === 'ENOENT';
  }
  return false;
}
