/**
 * ProjectManager core logic — pure in-memory operations.
 *
 * Manages project template loading, instance creation, and chatId binding
 * entirely in memory. No filesystem operations are performed in this layer
 * (Sub-Issue D adds filesystem operations on top).
 *
 * Key design decisions:
 * - `ProjectResult<T>` unified return type — validation failures return
 *   `{ ok: false, error }` instead of throwing
 * - Stale binding self-healing — if a chatId is bound to a deleted instance,
 *   the binding is silently removed
 * - Path traversal protection on all name inputs
 * - "default" is a reserved name (implicit built-in project)
 *
 * @see docs/proposals/unified-project-context.md §4 API Design
 * @see Issue #2224 (Sub-Issue B — ProjectManager core logic)
 */

import path from 'node:path';
import type {
  CwdProvider,
  InstanceInfo,
  ProjectContextConfig,
  ProjectManagerOptions,
  ProjectResult,
  ProjectTemplate,
  ProjectTemplatesConfig,
} from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Internal State
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Internal representation of a project instance.
 *
 * Extends ProjectContextConfig with creation timestamp for listInstances().
 */
interface InternalInstance {
  /** Instance name */
  name: string;

  /** Source template name */
  templateName: string;

  /** Instance working directory */
  workingDir: string;

  /** ISO 8601 creation timestamp */
  createdAt: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Validation Constants
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Characters forbidden in instance/project names */
const FORBIDDEN_NAME_CHARS = /[\x00\\/]/;

/** Maximum name length */
const MAX_NAME_LENGTH = 64;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ProjectManager
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Manages project templates, instances, and chatId bindings in memory.
 *
 * Lifecycle:
 * 1. Construct with workspaceDir, packageDir, templatesConfig
 * 2. Templates loaded automatically via init()
 * 3. Create instances from templates, bind chatIds, query active project
 *
 * Thread safety: Not thread-safe. Single-threaded use only.
 */
export class ProjectManager {
  private templates: Map<string, ProjectTemplate> = new Map();
  private instances: Map<string, InternalInstance> = new Map();
  private chatProjectMap: Map<string, string> = new Map();

  private readonly workspaceDir: string;
  private readonly packageDir: string;

  /**
   * Create a new ProjectManager.
   *
   * @param options - Constructor options including workspace/package dirs and template config
   */
  constructor(options: ProjectManagerOptions) {
    this.workspaceDir = options.workspaceDir;
    this.packageDir = options.packageDir;
    this.init(options.templatesConfig);
  }

  // ── Initialization ──

  /**
   * Load templates from config (not filesystem).
   *
   * Clears existing templates and reloads from the provided config.
   * Does NOT clear existing instances or bindings — templates can be
   * reloaded independently.
   *
   * @param templatesConfig - Template configuration from disclaude.config.yaml
   */
  init(templatesConfig?: ProjectTemplatesConfig): void {
    this.templates.clear();

    if (templatesConfig) {
      for (const [name, meta] of Object.entries(templatesConfig)) {
        this.templates.set(name, {
          name,
          displayName: meta.displayName,
          description: meta.description,
        });
      }
    }
  }

  // ── Core Methods ──

  /**
   * Get the active project configuration for a chatId.
   *
   * Implements stale binding self-healing: if a chatId is bound to
   * a project name that no longer exists in the instances map,
   * the binding is silently removed and the default project is returned.
   *
   * @param chatId - The chat session identifier
   * @returns ProjectContextConfig for the active project (or default)
   */
  getActive(chatId: string): ProjectContextConfig {
    const boundName = this.chatProjectMap.get(chatId);
    if (boundName) {
      const instance = this.instances.get(boundName);
      if (instance) {
        return {
          name: instance.name,
          templateName: instance.templateName,
          workingDir: instance.workingDir,
        };
      }
      // Stale binding self-healing: instance was deleted, clean up binding
      this.chatProjectMap.delete(chatId);
    }

    // Return default project
    return {
      name: 'default',
      workingDir: this.workspaceDir,
    };
  }

  /**
   * Create a new project instance from a template and bind it to a chatId.
   *
   * Pure in-memory operation — does not create directories or copy files.
   * Sub-Issue D adds filesystem operations on top of this.
   *
   * @param chatId - The chat session to bind
   * @param templateName - The template to instantiate from
   * @param name - The unique instance name (user-specified)
   * @returns ProjectResult with the new ProjectContextConfig on success
   */
  create(
    chatId: string,
    templateName: string,
    name: string,
  ): ProjectResult<ProjectContextConfig> {
    // Validate chatId
    const chatIdError = this.validateChatId(chatId);
    if (chatIdError) {
      return { ok: false, error: chatIdError };
    }

    // Validate templateName
    if (!this.templates.has(templateName)) {
      return { ok: false, error: `模板 "${templateName}" 不存在` };
    }

    // Validate name
    const nameError = this.validateName(name);
    if (nameError) {
      return { ok: false, error: nameError };
    }

    // Check if instance already exists
    if (this.instances.has(name)) {
      return { ok: false, error: `实例 "${name}" 已存在，请使用 /project use 绑定` };
    }

    // Create instance in memory
    const workingDir = path.join(this.workspaceDir, 'projects', name);
    const instance: InternalInstance = {
      name,
      templateName,
      workingDir,
      createdAt: new Date().toISOString(),
    };

    this.instances.set(name, instance);
    this.chatProjectMap.set(chatId, name);

    return {
      ok: true,
      data: {
        name: instance.name,
        templateName: instance.templateName,
        workingDir: instance.workingDir,
      },
    };
  }

  /**
   * Bind a chatId to an existing project instance.
   *
   * Multiple chatIds can bind to the same instance (shared workspace).
   *
   * @param chatId - The chat session to bind
   * @param name - The existing instance name
   * @returns ProjectResult with the bound ProjectContextConfig on success
   */
  use(chatId: string, name: string): ProjectResult<ProjectContextConfig> {
    // Validate chatId
    const chatIdError = this.validateChatId(chatId);
    if (chatIdError) {
      return { ok: false, error: chatIdError };
    }

    // Validate name
    const nameError = this.validateName(name);
    if (nameError) {
      return { ok: false, error: nameError };
    }

    // Check if instance exists
    const instance = this.instances.get(name);
    if (!instance) {
      return { ok: false, error: `实例 "${name}" 不存在` };
    }

    // Bind chatId to instance
    this.chatProjectMap.set(chatId, name);

    return {
      ok: true,
      data: {
        name: instance.name,
        templateName: instance.templateName,
        workingDir: instance.workingDir,
      },
    };
  }

  /**
   * Reset a chatId's binding back to the default project.
   *
   * If the chatId is already unbound (default), this is a silent no-op
   * that still returns success.
   *
   * @param chatId - The chat session to reset
   * @returns ProjectResult with the default ProjectContextConfig
   */
  reset(chatId: string): ProjectResult<ProjectContextConfig> {
    // Validate chatId
    const chatIdError = this.validateChatId(chatId);
    if (chatIdError) {
      return { ok: false, error: chatIdError };
    }

    // Remove binding (no-op if not bound)
    this.chatProjectMap.delete(chatId);

    return {
      ok: true,
      data: {
        name: 'default',
        workingDir: this.workspaceDir,
      },
    };
  }

  /**
   * List all available templates.
   *
   * @returns Array of all loaded templates
   */
  listTemplates(): ProjectTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * List all project instances with their binding information.
   *
   * Does NOT include the "default" project (implicit built-in).
   *
   * @returns Array of InstanceInfo objects
   */
  listInstances(): InstanceInfo[] {
    const result: InstanceInfo[] = [];

    for (const [name, instance] of this.instances) {
      // Collect all chatIds bound to this instance
      const chatIds: string[] = [];
      for (const [chatId, boundName] of this.chatProjectMap) {
        if (boundName === name) {
          chatIds.push(chatId);
        }
      }

      result.push({
        name,
        templateName: instance.templateName,
        chatIds,
        workingDir: instance.workingDir,
        createdAt: instance.createdAt,
      });
    }

    return result;
  }

  /**
   * Create a CwdProvider closure for injecting into Pilot.
   *
   * The returned function queries the active project for a given chatId
   * and returns its workingDir, or undefined for the default project
   * (allowing the SDK to fall back to getWorkspaceDir()).
   *
   * @returns CwdProvider closure bound to this ProjectManager
   */
  createCwdProvider(): CwdProvider {
    return (chatId: string): string | undefined => {
      const active = this.getActive(chatId);
      if (active.name === 'default') {
        return undefined;
      }
      return active.workingDir;
    };
  }

  // ── Accessors (for D phase integration) ──

  /** Get the workspace directory */
  getWorkspaceDir(): string {
    return this.workspaceDir;
  }

  /** Get the package directory */
  getPackageDir(): string {
    return this.packageDir;
  }

  /**
   * Delete a project instance from memory.
   *
   * Does NOT unbind chatIds — they will self-heal on next getActive().
   * This is intentionally limited for D phase rollback support.
   *
   * @param name - Instance name to delete
   * @returns true if the instance existed and was deleted
   */
  deleteInstance(name: string): boolean {
    return this.instances.delete(name);
  }

  // ── Private Helpers ──

  /**
   * Validate a project/instance name.
   *
   * Rules:
   * - Must be non-empty
   * - Must not be "default" (reserved)
   * - Must not contain ".." (path traversal)
   * - Must not contain "/" or "\" (path separators)
   * - Must not contain null bytes
   * - Must not be whitespace-only
   * - Must not exceed 64 characters
   *
   * @param name - The name to validate
   * @returns Error message string, or null if valid
   */
  private validateName(name: string): string | null {
    if (!name || name.length === 0) {
      return '名称不能为空';
    }
    if (name === 'default') {
      return '"default" 是保留名称';
    }
    if (name.includes('..')) {
      return '名称不能包含 ".."';
    }
    if (FORBIDDEN_NAME_CHARS.test(name)) {
      return '名称不能包含路径分隔符或空字节';
    }
    if (name.trim().length === 0) {
      return '名称不能只包含空白字符';
    }
    if (name.length > MAX_NAME_LENGTH) {
      return `名称长度不能超过 ${MAX_NAME_LENGTH} 个字符`;
    }
    return null;
  }

  /**
   * Validate a chatId.
   *
   * @param chatId - The chatId to validate
   * @returns Error message string, or null if valid
   */
  private validateChatId(chatId: string): string | null {
    if (!chatId || chatId.length === 0) {
      return 'chatId 不能为空';
    }
    return null;
  }
}
