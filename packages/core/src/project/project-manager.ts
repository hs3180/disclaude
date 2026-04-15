/**
 * ProjectManager — core in-memory logic for per-chatId Agent context switching.
 *
 * Manages template-based project instantiation and chatId binding.
 * This module is pure in-memory — no filesystem or persistence operations.
 *
 * @see docs/proposals/unified-project-context.md §4.1
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
// Name Validation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Characters forbidden in instance/template names */
const FORBIDDEN_NAME_CHARS = /[\x00\\/]/;

/** Maximum length for instance names */
const MAX_NAME_LENGTH = 64;

/**
 * Validate an instance or template name.
 *
 * Rules:
 * - Must be non-empty and non-whitespace-only
 * - Must not be "default" (reserved for built-in project)
 * - Must not contain ".." (path traversal)
 * - Must not contain "/" or "\" (path separators)
 * - Must not contain null bytes
 * - Must not exceed 64 characters
 *
 * @returns Error message if invalid, or `undefined` if valid
 */
function validateName(name: string): string | undefined {
  if (!name || name.trim().length === 0) {
    return '名称不能为空';
  }
  if (name === 'default') {
    return '"default" 为保留名，不能用作实例名';
  }
  if (name === '..' || name.includes('..')) {
    return '名称不能包含 ".."（路径遍历防护）';
  }
  if (FORBIDDEN_NAME_CHARS.test(name)) {
    return '名称不能包含 "/", "\\", 或空字节';
  }
  if (name.trim().length !== name.length) {
    return '名称不能以空格开头或结尾';
  }
  if (name.length > MAX_NAME_LENGTH) {
    return `名称长度不能超过 ${MAX_NAME_LENGTH} 个字符`;
  }
  return undefined;
}

/**
 * Validate a chatId.
 *
 * @returns Error message if invalid, or `undefined` if valid
 */
function validateChatId(chatId: string): string | undefined {
  if (!chatId || chatId.trim().length === 0) {
    return 'chatId 不能为空';
  }
  return undefined;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ProjectManager
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Manages project templates, instances, and chatId bindings in memory.
 *
 * Lifecycle:
 * 1. `new ProjectManager(options)` — construct with directory paths
 * 2. `init(templatesConfig)` — load templates from config
 * 3. Use `create`, `use`, `reset`, `getActive`, etc.
 *
 * All operations are pure in-memory. Persistence is handled externally (Sub-Issue C).
 * File system operations (directory creation, CLAUDE.md copy) are handled externally (Sub-Issue D).
 *
 * @example
 * ```typescript
 * const pm = new ProjectManager({
 *   workspaceDir: '/workspace',
 *   packageDir: '/app/packages/core',
 *   templatesConfig: { research: { displayName: '研究模式' } },
 * });
 * pm.init();
 *
 * const result = pm.create('oc_chat123', 'research', 'my-research');
 * if (result.ok) {
 *   console.log('Created:', result.data.workingDir);
 * }
 * ```
 */
export class ProjectManager {
  /** Available templates loaded from config */
  private templates: Map<string, ProjectTemplate> = new Map();

  /** Created instances keyed by instance name */
  private instances: Map<string, ProjectContextConfig> = new Map();

  /** ChatId → instance name binding map */
  private chatProjectMap: Map<string, string> = new Map();

  /** Instance creation timestamps (ISO 8601) */
  private createdAtMap: Map<string, string> = new Map();

  /** Workspace root directory */
  private readonly workspaceDir: string;

  /** Templates config from constructor */
  private readonly templatesConfig: ProjectTemplatesConfig;

  constructor(options: ProjectManagerOptions) {
    this.workspaceDir = options.workspaceDir;
    this.templatesConfig = options.templatesConfig;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Initialization
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Initialize templates from config.
   *
   * Can be called with an optional override config, otherwise uses
   * the config provided at construction time.
   *
   * @param overrideConfig - Optional config override (e.g., from auto-discovery)
   */
  init(overrideConfig?: ProjectTemplatesConfig): void {
    const config = overrideConfig ?? this.templatesConfig;
    this.templates.clear();

    for (const [name, metadata] of Object.entries(config)) {
      this.templates.set(name, {
        name,
        displayName: metadata.displayName,
        description: metadata.description,
      });
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Core Methods
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Get the active project config for a chatId.
   *
   * If the chatId has no binding, or the binding points to a deleted instance
   * (stale binding self-healing), returns the default project config.
   *
   * @param chatId - The chat session identifier
   * @returns ProjectContextConfig for the active project
   */
  getActive(chatId: string): ProjectContextConfig {
    const boundName = this.chatProjectMap.get(chatId);

    if (boundName) {
      const instance = this.instances.get(boundName);
      if (instance) {
        return instance;
      }
      // Stale binding self-healing: bound instance no longer exists
      this.chatProjectMap.delete(chatId);
    }

    return this.getDefaultProject();
  }

  /**
   * Create a new project instance from a template and bind it to a chatId.
   *
   * In this in-memory implementation, the instance is only registered in memory.
   * Directory creation and CLAUDE.md copying are handled by Sub-Issue D.
   *
   * @param chatId - The chat session creating the instance
   * @param templateName - The template to instantiate
   * @param name - The unique instance name
   * @returns ProjectResult with the created ProjectContextConfig
   */
  create(
    chatId: string,
    templateName: string,
    name: string,
  ): ProjectResult<ProjectContextConfig> {
    // Validate inputs
    const chatIdError = validateChatId(chatId);
    if (chatIdError) {
      return { ok: false, error: chatIdError };
    }

    const nameError = validateName(name);
    if (nameError) {
      return { ok: false, error: nameError };
    }

    // Check template exists
    if (!this.templates.has(templateName)) {
      return { ok: false, error: `模板 "${templateName}" 不存在` };
    }

    // Check instance name uniqueness
    if (this.instances.has(name)) {
      return {
        ok: false,
        error: `实例名 "${name}" 已存在，请使用 /project use ${name} 绑定`,
      };
    }

    // Create instance
    const workingDir = path.join(this.workspaceDir, 'projects', name);
    const instance: ProjectContextConfig = {
      name,
      templateName,
      workingDir,
    };

    this.instances.set(name, instance);
    this.createdAtMap.set(name, new Date().toISOString());
    this.chatProjectMap.set(chatId, name);

    return { ok: true, data: instance };
  }

  /**
   * Bind a chatId to an existing project instance.
   *
   * Multiple chatIds can bind to the same instance (workspace sharing).
   *
   * @param chatId - The chat session to bind
   * @param name - The existing instance name
   * @returns ProjectResult with the bound ProjectContextConfig
   */
  use(chatId: string, name: string): ProjectResult<ProjectContextConfig> {
    // Validate inputs
    const chatIdError = validateChatId(chatId);
    if (chatIdError) {
      return { ok: false, error: chatIdError };
    }

    // Disallow binding to "default"
    if (name === 'default') {
      return {
        ok: false,
        error: '"default" 为保留名，请使用 /project reset 重置',
      };
    }

    // Check instance exists
    const instance = this.instances.get(name);
    if (!instance) {
      return {
        ok: false,
        error: `实例 "${name}" 不存在，请先使用 /project create 创建`,
      };
    }

    // Bind
    this.chatProjectMap.set(chatId, name);

    return { ok: true, data: instance };
  }

  /**
   * Reset a chatId to the default project.
   *
   * If already on default, this is a silent no-op (returns success).
   *
   * @param chatId - The chat session to reset
   * @returns ProjectResult with the default ProjectContextConfig
   */
  reset(chatId: string): ProjectResult<ProjectContextConfig> {
    const chatIdError = validateChatId(chatId);
    if (chatIdError) {
      return { ok: false, error: chatIdError };
    }

    // Remove binding (no-op if not bound)
    this.chatProjectMap.delete(chatId);

    return { ok: true, data: this.getDefaultProject() };
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Query Methods
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * List all available templates.
   *
   * @returns Array of all registered templates
   */
  listTemplates(): ProjectTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * List all instances with their binding relationships.
   *
   * Does NOT include the "default" project (implicit built-in).
   *
   * @returns Array of instance info objects
   */
  listInstances(): InstanceInfo[] {
    const result: InstanceInfo[] = [];

    for (const [name, instance] of this.instances) {
      // Find all chatIds bound to this instance
      const chatIds: string[] = [];
      for (const [chatId, boundName] of this.chatProjectMap) {
        if (boundName === name) {
          chatIds.push(chatId);
        }
      }

      result.push({
        name,
        templateName: instance.templateName ?? '',
        chatIds,
        workingDir: instance.workingDir,
        createdAt: this.createdAtMap.get(name) ?? new Date().toISOString(),
      });
    }

    return result;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // CwdProvider
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Create a CwdProvider closure for Agent integration.
   *
   * The returned function resolves a chatId to the active project's workingDir,
   * or returns `undefined` for the default project (SDK falls back to getWorkspaceDir()).
   *
   * @returns CwdProvider function bound to this ProjectManager
   */
  createCwdProvider(): CwdProvider {
    return (chatId: string): string | undefined => {
      const active = this.getActive(chatId);
      // Return undefined for default project → SDK falls back to getWorkspaceDir()
      if (active.name === 'default') {
        return undefined;
      }
      return active.workingDir;
    };
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Internal Helpers
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Get the default project config.
   *
   * The default project has no template and uses the workspace root as workingDir.
   */
  private getDefaultProject(): ProjectContextConfig {
    return {
      name: 'default',
      workingDir: this.workspaceDir,
    };
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // State Access (for persistence integration)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Get current state for persistence serialization.
   *
   * Returns the raw Maps as plain objects suitable for JSON serialization.
   * Used by Sub-Issue C (persistence) to write projects.json.
   *
   * @internal
   */
  getState(): {
    instances: Map<string, ProjectContextConfig>;
    chatProjectMap: Map<string, string>;
    createdAtMap: Map<string, string>;
  } {
    return {
      instances: this.instances,
      chatProjectMap: this.chatProjectMap,
      createdAtMap: this.createdAtMap,
    };
  }

  /**
   * Load state from persistence.
   *
   * Used by Sub-Issue C (persistence) to restore from projects.json.
   *
   * @internal
   */
  loadState(state: {
    instances: Array<[string, ProjectContextConfig]>;
    chatProjectMap: Array<[string, string]>;
    createdAtMap: Array<[string, string]>;
  }): void {
    this.instances = new Map(state.instances);
    this.chatProjectMap = new Map(state.chatProjectMap);
    this.createdAtMap = new Map(state.createdAtMap);
  }
}
