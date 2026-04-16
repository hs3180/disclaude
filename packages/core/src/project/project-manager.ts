/**
 * ProjectManager — core in-memory logic for per-chatId Agent context switching.
 *
 * Manages project templates, instances, and chatId bindings entirely in memory.
 * No filesystem operations or persistence — those are Sub-Issues C and D.
 *
 * @see Issue #2224 (Sub-Issue B — ProjectManager core logic)
 * @see Issue #1916 (parent — unified ProjectContext system)
 */

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
// Validation Constants
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Maximum allowed length for instance names */
const MAX_NAME_LENGTH = 64;

/** Characters forbidden in instance names */
const FORBIDDEN_NAME_CHARS = /[\x00\\/]/;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Internal Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Internal representation of a project instance (in-memory only).
 */
interface ProjectInstance {
  name: string;
  templateName: string;
  workingDir: string;
  createdAt: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ProjectManager
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Manages project templates, instances, and chatId bindings in pure memory.
 *
 * Lifecycle:
 * 1. Construct with `ProjectManagerOptions`
 * 2. Call `init()` (or `init(templatesConfig)`) to load templates
 * 3. Use `create()`, `use()`, `getActive()`, `reset()` to manage projects
 * 4. Call `createCwdProvider()` to get a CwdProvider for Agent injection
 *
 * Zero-config: if no templates are configured, behavior is identical to
 * the current system (all chatIds use workspace root as cwd).
 */
export class ProjectManager {
  private readonly workspaceDir: string;
  /** Root directory containing built-in templates with CLAUDE.md files.
   *  Used by Sub-Issue D (#2459) for `instantiateFromTemplate()` to copy
   *  `{packageDir}/templates/{name}/CLAUDE.md` into the instance workingDir.
   *  @internal Prefixed with _ until instantiateFromTemplate is implemented. */
  // @ts-expect-error — packageDir will be used by instantiateFromTemplate (Sub-Issue D)
  private readonly _packageDir: string;
  private templates: Map<string, ProjectTemplate> = new Map();
  private instances: Map<string, ProjectInstance> = new Map();
  /** chatId → instance name binding */
  private chatProjectMap: Map<string, string> = new Map();
  /** Reverse index: instance name → Set of bound chatIds (O(1) lookup) */
  private instanceChatIds: Map<string, Set<string>> = new Map();

  constructor(options: ProjectManagerOptions) {
    this.workspaceDir = options.workspaceDir;
    this._packageDir = options.packageDir;
    this.init(options.templatesConfig);
  }

  // ───────────────────────────────────────────
  // Initialization
  // ───────────────────────────────────────────

  /**
   * Initialize (or re-initialize) templates from config.
   *
   * Does NOT clear existing instances or bindings — templates can be
   * hot-reloaded without losing runtime state.
   *
   * @param templatesConfig - Template configuration (from disclaude.config.yaml or auto-discovery)
   */
  init(templatesConfig?: ProjectTemplatesConfig): void {
    this.templates.clear();

    if (!templatesConfig) {
      return;
    }

    for (const [name, meta] of Object.entries(templatesConfig)) {
      this.templates.set(name, {
        name,
        displayName: meta.displayName,
        description: meta.description,
      });
    }
  }

  // ───────────────────────────────────────────
  // Core Methods
  // ───────────────────────────────────────────

  /**
   * Get the active project context for a chatId.
   *
   * Stale binding self-healing: if the bound instance no longer exists,
   * the binding is automatically removed and the default context is returned.
   *
   * @param chatId - Chat session identifier
   * @returns ProjectContextConfig for the active project (or default)
   */
  getActive(chatId: string): ProjectContextConfig {
    // Check for explicit binding
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

      // Stale binding self-healing: instance was removed, clean up binding
      this.chatProjectMap.delete(chatId);
      this.removeFromReverseIndex(boundName, chatId);
    }

    // Default: workspace root
    return {
      name: 'default',
      workingDir: this.workspaceDir,
    };
  }

  /**
   * Create a new project instance from a template (in-memory only).
   *
   * Does NOT create directories or copy CLAUDE.md — that's Sub-Issue D.
   * The workingDir is computed as `{workspaceDir}/projects/{name}/`.
   *
   * @param chatId - Chat session requesting creation
   * @param templateName - Template to instantiate from
   * @param name - Unique name for the new instance
   * @returns ProjectResult with ProjectContextConfig on success
   */
  create(chatId: string, templateName: string, name: string): ProjectResult<ProjectContextConfig> {
    // Validate inputs
    const nameError = this.validateInstanceName(name);
    if (nameError) {
      return { ok: false, error: nameError };
    }

    const chatIdError = this.validateChatId(chatId);
    if (chatIdError) {
      return { ok: false, error: chatIdError };
    }

    // Check template exists
    if (!this.templates.has(templateName)) {
      return { ok: false, error: `模板 "${templateName}" 不存在` };
    }

    // Check name uniqueness
    if (this.instances.has(name)) {
      return { ok: false, error: `实例 "${name}" 已存在` };
    }

    const workingDir = this.resolveWorkingDir(name);
    const instance: ProjectInstance = {
      name,
      templateName,
      workingDir,
      createdAt: new Date().toISOString(),
    };

    this.instances.set(name, instance);
    this.chatProjectMap.set(chatId, name);
    this.addToReverseIndex(name, chatId);

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
   * Bind a chatId to an existing instance.
   *
   * @param chatId - Chat session requesting binding
   * @param name - Instance name to bind to
   * @returns ProjectResult with ProjectContextConfig on success
   */
  use(chatId: string, name: string): ProjectResult<ProjectContextConfig> {
    const chatIdError = this.validateChatId(chatId);
    if (chatIdError) {
      return { ok: false, error: chatIdError };
    }

    const instance = this.instances.get(name);
    if (!instance) {
      return { ok: false, error: `实例 "${name}" 不存在` };
    }

    // Remove from old instance's reverse index if rebinding
    const oldName = this.chatProjectMap.get(chatId);
    if (oldName && oldName !== name) {
      this.removeFromReverseIndex(oldName, chatId);
    }

    this.chatProjectMap.set(chatId, name);
    this.addToReverseIndex(name, chatId);

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
   * Reset a chatId's binding, reverting to default project.
   *
   * @param chatId - Chat session to reset
   * @returns ProjectResult with default ProjectContextConfig
   */
  reset(chatId: string): ProjectResult<ProjectContextConfig> {
    const chatIdError = this.validateChatId(chatId);
    if (chatIdError) {
      return { ok: false, error: chatIdError };
    }

    const boundName = this.chatProjectMap.get(chatId);
    this.chatProjectMap.delete(chatId);
    if (boundName) {
      this.removeFromReverseIndex(boundName, chatId);
    }

    return {
      ok: true,
      data: {
        name: 'default',
        workingDir: this.workspaceDir,
      },
    };
  }

  // ───────────────────────────────────────────
  // Query Methods
  // ───────────────────────────────────────────

  /**
   * List all available templates.
   *
   * @returns Array of templates sorted by name
   */
  listTemplates(): ProjectTemplate[] {
    return Array.from(this.templates.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  /**
   * List all instances with their binding information.
   *
   * Does NOT include the implicit "default" project.
   *
   * @returns Array of InstanceInfo sorted by creation time
   */
  listInstances(): InstanceInfo[] {
    const result: InstanceInfo[] = [];

    for (const instance of this.instances.values()) {
      const chatIds = this.getBoundChatIds(instance.name);
      result.push({
        name: instance.name,
        templateName: instance.templateName,
        chatIds,
        workingDir: instance.workingDir,
        createdAt: instance.createdAt,
      });
    }

    return result.sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  // ───────────────────────────────────────────
  // CwdProvider Factory
  // ───────────────────────────────────────────

  /**
   * Create a CwdProvider closure bound to this ProjectManager.
   *
   * Injected into ChatAgent for dynamic cwd resolution.
   *
   * @returns CwdProvider function
   */
  createCwdProvider(): CwdProvider {
    return (chatId: string): string | undefined => {
      const active = this.getActive(chatId);
      // Return undefined for default → SDK falls back to getWorkspaceDir()
      if (active.name === 'default') {
        return undefined;
      }
      return active.workingDir;
    };
  }

  // ───────────────────────────────────────────
  // Internal Helpers
  // ───────────────────────────────────────────

  /**
   * Resolve the working directory for an instance.
   *
   * Pattern: `{workspaceDir}/projects/{name}/`
   *
   * @param name - Instance name
   * @returns Absolute working directory path
   */
  private resolveWorkingDir(name: string): string {
    // Use simple path join (path traversal already validated in create())
    // Avoid importing `path` to keep this module filesystem-free
    const ws = this.workspaceDir.replace(/\/+$/, '');
    return `${ws}/projects/${name}`;
  }

  /**
   * Get all chatIds bound to a specific instance.
   *
   * Uses reverse index for O(1) lookup per instance.
   *
   * @param instanceName - Instance name to look up
   * @returns Array of bound chatIds
   */
  private getBoundChatIds(instanceName: string): string[] {
    const chatIds = this.instanceChatIds.get(instanceName);
    return chatIds
      ? [...chatIds]
      : [];
  }

  /**
   * Add a chatId to an instance's reverse index set.
   */
  private addToReverseIndex(instanceName: string, chatId: string): void {
    let set = this.instanceChatIds.get(instanceName);
    if (!set) {
      set = new Set();
      this.instanceChatIds.set(instanceName, set);
    }
    set.add(chatId);
  }

  /**
   * Remove a chatId from an instance's reverse index set.
   * Cleans up empty sets to avoid memory leaks.
   */
  private removeFromReverseIndex(instanceName: string, chatId: string): void {
    const set = this.instanceChatIds.get(instanceName);
    if (set) {
      set.delete(chatId);
      if (set.size === 0) {
        this.instanceChatIds.delete(instanceName);
      }
    }
  }

  // ───────────────────────────────────────────
  // Validation
  // ───────────────────────────────────────────

  /**
   * Validate an instance name.
   *
   * Rules:
   * - Must be non-empty
   * - Must not be "default" (reserved)
   * - Must not contain ".." (path traversal)
   * - Must not contain "/" or "\" (path separators)
   * - Must not contain null bytes
   * - Must not exceed 64 characters
   * - Must not be whitespace-only
   *
   * @param name - Instance name to validate
   * @returns Error message string, or null if valid
   */
  private validateInstanceName(name: string): string | null {
    if (!name || name.length === 0) {
      return '实例名称不能为空';
    }
    if (name === 'default') {
      return '"default" 是保留名称，不能用作实例名';
    }
    if (name === '..' || name.includes('..')) {
      return '实例名称不能包含 ".."（路径遍历防护）';
    }
    if (FORBIDDEN_NAME_CHARS.test(name)) {
      return '实例名称不能包含 /、\\ 或空字节';
    }
    if (name.trim().length === 0) {
      return '实例名称不能仅包含空白字符';
    }
    if (name.length > MAX_NAME_LENGTH) {
      return `实例名称不能超过 ${MAX_NAME_LENGTH} 个字符`;
    }
    return null;
  }

  /**
   * Validate a chatId.
   *
   * @param chatId - Chat session identifier
   * @returns Error message string, or null if valid
   */
  private validateChatId(chatId: string): string | null {
    if (!chatId || chatId.length === 0) {
      return 'chatId 不能为空';
    }
    return null;
  }
}
