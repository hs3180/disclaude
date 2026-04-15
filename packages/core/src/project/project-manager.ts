/**
 * ProjectManager — core logic for per-chatId Agent context switching.
 *
 * Manages template-based project instantiation, chatId binding, and persistence.
 * In-memory state is persisted to `{workspaceDir}/.disclaude/projects.json`
 * using atomic write-then-rename for crash safety.
 *
 * @see docs/proposals/unified-project-context.md §4.1
 * @see Issue #2224 (Sub-Issue B — ProjectManager core logic)
 * @see Issue #2225 (Sub-Issue C — Persistence)
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  CwdProvider,
  InstanceInfo,
  ProjectContextConfig,
  ProjectManagerOptions,
  ProjectResult,
  ProjectTemplate,
  ProjectTemplatesConfig,
  ProjectsPersistData,
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
// Persistence Constants
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Directory name for persistence data (relative to workspaceDir) */
const PERSIST_DIR = '.disclaude';

/** Filename for the persistence file */
const PERSIST_FILENAME = 'projects.json';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ProjectManager
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Manages project templates, instances, and chatId bindings with persistence.
 *
 * Lifecycle:
 * 1. `new ProjectManager(options)` — construct with directory paths
 * 2. `init(templatesConfig)` — load templates from config
 * 3. Optionally call `loadPersistedData()` to restore previous state
 * 4. Use `create`, `use`, `reset`, `getActive`, etc.
 *
 * Mutating operations (`create`, `use`, `reset`, `delete`) automatically
 * persist state to `{workspaceDir}/.disclaude/projects.json` using atomic
 * write-then-rename. On persist failure, the in-memory mutation is rolled back.
 *
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
 * pm.loadPersistedData(); // Restore from disk (safe if file doesn't exist)
 *
 * const result = pm.create('oc_chat123', 'research', 'my-research');
 * if (result.ok) {
 *   console.log('Created:', result.data.workingDir);
 *   // State is automatically persisted to disk
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
   * Persists state to disk after successful creation. On persist failure,
   * the in-memory mutation is rolled back.
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

    // Snapshot for rollback
    const snapshot = this.captureSnapshot();

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

    // Persist with rollback on failure
    const persistResult = this.persist();
    if (!persistResult.ok) {
      this.restoreSnapshot(snapshot);
      return { ok: false, error: persistResult.error };
    }

    return { ok: true, data: instance };
  }

  /**
   * Bind a chatId to an existing project instance.
   *
   * Multiple chatIds can bind to the same instance (workspace sharing).
   * Persists state after successful binding.
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

    // Snapshot for rollback
    const snapshot = this.captureSnapshot();

    // Bind
    this.chatProjectMap.set(chatId, name);

    // Persist with rollback on failure
    const persistResult = this.persist();
    if (!persistResult.ok) {
      this.restoreSnapshot(snapshot);
      return { ok: false, error: persistResult.error };
    }

    return { ok: true, data: instance };
  }

  /**
   * Reset a chatId to the default project.
   *
   * If already on default, this is a silent no-op (returns success).
   * Persists state after successful reset.
   *
   * @param chatId - The chat session to reset
   * @returns ProjectResult with the default ProjectContextConfig
   */
  reset(chatId: string): ProjectResult<ProjectContextConfig> {
    const chatIdError = validateChatId(chatId);
    if (chatIdError) {
      return { ok: false, error: chatIdError };
    }

    // Snapshot for rollback
    const snapshot = this.captureSnapshot();

    // Remove binding (no-op if not bound)
    this.chatProjectMap.delete(chatId);

    // Persist with rollback on failure
    const persistResult = this.persist();
    if (!persistResult.ok) {
      this.restoreSnapshot(snapshot);
      return { ok: false, error: persistResult.error };
    }

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
  // Deletion
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Delete a project instance.
   *
   * Removes the instance from memory and disk (persistence file).
   * Cleans up all associated chatId bindings.
   * The instance's working directory is NOT removed (handled by Sub-Issue D).
   *
   * @param name - The instance name to delete
   * @returns ProjectResult with void on success
   */
  delete(name: string): ProjectResult<void> {
    const nameError = validateName(name);
    if (nameError) {
      return { ok: false, error: nameError };
    }

    // Check instance exists
    if (!this.instances.has(name)) {
      return {
        ok: false,
        error: `实例 "${name}" 不存在`,
      };
    }

    // Snapshot for rollback
    const snapshot = this.captureSnapshot();

    // Remove instance
    this.instances.delete(name);
    this.createdAtMap.delete(name);

    // Clean up all chatId bindings pointing to this instance
    for (const [chatId, boundName] of this.chatProjectMap) {
      if (boundName === name) {
        this.chatProjectMap.delete(chatId);
      }
    }

    // Persist with rollback on failure
    const persistResult = this.persist();
    if (!persistResult.ok) {
      this.restoreSnapshot(snapshot);
      return { ok: false, error: persistResult.error };
    }

    return { ok: true, data: undefined };
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Persistence
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Get the path to the persistence file.
   *
   * @returns Absolute path to `{workspaceDir}/.disclaude/projects.json`
   */
  getPersistPath(): string {
    return path.join(this.workspaceDir, PERSIST_DIR, PERSIST_FILENAME);
  }

  /**
   * Persist current in-memory state to disk.
   *
   * Uses atomic write-then-rename pattern:
   * 1. Write to a `.tmp` file
   * 2. Rename `.tmp` to the target file
   *
   * This prevents corruption from interrupted writes.
   * The `.disclaude/` directory is created automatically if it doesn't exist.
   *
   * @returns ProjectResult with void on success, or error on failure
   */
  persist(): ProjectResult<void> {
    const persistPath = this.getPersistPath();
    const persistDir = path.dirname(persistPath);
    const tmpPath = `${persistPath}.tmp`;

    try {
      // Ensure .disclaude/ directory exists
      if (!fs.existsSync(persistDir)) {
        fs.mkdirSync(persistDir, { recursive: true });
      }

      // Serialize state to ProjectsPersistData format
      const data: ProjectsPersistData = {
        instances: {},
        chatProjectMap: Object.fromEntries(this.chatProjectMap),
      };

      for (const [name, instance] of this.instances) {
        data.instances[name] = {
          name: instance.name,
          templateName: instance.templateName ?? '',
          workingDir: instance.workingDir,
          createdAt: this.createdAtMap.get(name) ?? new Date().toISOString(),
        };
      }

      // Write to temp file first
      const json = JSON.stringify(data, null, 2);
      fs.writeFileSync(tmpPath, json, 'utf8');

      // Atomic rename
      fs.renameSync(tmpPath, persistPath);

      return { ok: true, data: undefined };
    } catch (err) {
      // Clean up temp file if rename failed
      try {
        if (fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      } catch {
        // Ignore cleanup errors
      }

      const message =
        err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `持久化失败: ${message}`,
      };
    }
  }

  /**
   * Load persisted state from disk into memory.
   *
   * Reads `{workspaceDir}/.disclaude/projects.json`, validates the schema,
   * and restores in-memory state. Safe to call when the file doesn't exist
   * (returns success with no-op).
   *
   * **Validation rules:**
   * - `instances` must be an object
   * - `chatProjectMap` must be an object
   * - Each instance must have `workingDir` (string) and `createdAt` (string)
   *
   * @returns ProjectResult with void on success, or error if the file is corrupt
   */
  loadPersistedData(): ProjectResult<void> {
    const persistPath = this.getPersistPath();

    // No file = nothing to load (not an error)
    if (!fs.existsSync(persistPath)) {
      return { ok: true, data: undefined };
    }

    try {
      const raw = fs.readFileSync(persistPath, 'utf8');
      const data = JSON.parse(raw) as unknown;

      // Schema validation
      const validationError = validatePersistData(data);
      if (validationError) {
        return { ok: false, error: validationError };
      }

      const persistData = data as ProjectsPersistData;

      // Convert to Map entries for loadState
      const instanceEntries: Array<[string, ProjectContextConfig]> = [];
      const createdAtEntries: Array<[string, string]> = [];

      for (const [name, persisted] of Object.entries(persistData.instances)) {
        instanceEntries.push([
          name,
          {
            name: persisted.name,
            templateName: persisted.templateName,
            workingDir: persisted.workingDir,
          },
        ]);
        createdAtEntries.push([name, persisted.createdAt]);
      }

      const chatProjectMapEntries = Object.entries(persistData.chatProjectMap);

      // Load into memory
      this.loadState({
        instances: instanceEntries,
        chatProjectMap: chatProjectMapEntries,
        createdAtMap: createdAtEntries,
      });

      return { ok: true, data: undefined };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `读取持久化数据失败: ${message}`,
      };
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Internal Helpers
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Capture a snapshot of current state for rollback.
   *
   * Returns deep copies of the internal Maps so mutations
   * don't affect the snapshot.
   */
  private captureSnapshot(): {
    instances: Map<string, ProjectContextConfig>;
    chatProjectMap: Map<string, string>;
    createdAtMap: Map<string, string>;
  } {
    return {
      instances: new Map(this.instances),
      chatProjectMap: new Map(this.chatProjectMap),
      createdAtMap: new Map(this.createdAtMap),
    };
  }

  /**
   * Restore state from a previously captured snapshot.
   */
  private restoreSnapshot(snapshot: {
    instances: Map<string, ProjectContextConfig>;
    chatProjectMap: Map<string, string>;
    createdAtMap: Map<string, string>;
  }): void {
    this.instances = snapshot.instances;
    this.chatProjectMap = snapshot.chatProjectMap;
    this.createdAtMap = snapshot.createdAtMap;
  }

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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Schema Validation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Validate the schema of a persisted data object.
 *
 * @returns Error message if invalid, or `undefined` if valid
 */
function validatePersistData(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return 'projects.json 格式错误: 期望一个对象';
  }

  const obj = data as Record<string, unknown>;

  // Check instances
  if (typeof obj.instances !== 'object' || obj.instances === null || Array.isArray(obj.instances)) {
    return 'projects.json 格式错误: instances 应为对象';
  }

  // Check chatProjectMap
  if (typeof obj.chatProjectMap !== 'object' || obj.chatProjectMap === null || Array.isArray(obj.chatProjectMap)) {
    return 'projects.json 格式错误: chatProjectMap 应为对象';
  }

  // Validate each instance entry
  const instances = obj.instances as Record<string, unknown>;
  for (const [name, instance] of Object.entries(instances)) {
    if (typeof instance !== 'object' || instance === null || Array.isArray(instance)) {
      return `projects.json 格式错误: instances["${name}"] 应为对象`;
    }

    const inst = instance as Record<string, unknown>;

    if (typeof inst.workingDir !== 'string' || inst.workingDir.length === 0) {
      return `projects.json 格式错误: instances["${name}"].workingDir 应为非空字符串`;
    }

    if (typeof inst.createdAt !== 'string' || inst.createdAt.length === 0) {
      return `projects.json 格式错误: instances["${name}"].createdAt 应为非空字符串`;
    }
  }

  // Validate each chatProjectMap entry
  const chatMap = obj.chatProjectMap as Record<string, unknown>;
  for (const [chatId, instanceName] of Object.entries(chatMap)) {
    if (typeof instanceName !== 'string') {
      return `projects.json 格式错误: chatProjectMap["${chatId}"] 应为字符串`;
    }
  }

  return undefined;
}
